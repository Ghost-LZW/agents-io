import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BodyOf, HarnessEvent, Policy, SessionEvent, Tier } from '@agents-io/protocol';
import { CodexHarness } from '@agents-io/harness-codex';
import { isSnapshotEvent, passes } from '@agents-io/session';
import { CHOICE_KEY, OUTPUT_EVENT, parseChoiceActionId, type ChoiceData, type OutputRecord } from '@agents-io/host-mcp';
import { FakeChannel, checkEventStream, defaultChannelCaps } from '@agents-io/testkit';
import type { ClientSubscription } from './client.js';
import { LocalClient } from './client.js';
import { defaultInstance, withDefaultInstance, type Config, type HarnessInstance } from './config.js';
import { Gateway } from './gateway.js';

/*
 * Scenarios against the REAL harness from the config. Each one starts its own
 * in-process gateway (temp data dir, SQLite log, client socket) with a scripted
 * in-process channel `e2e` (owners e2e:alice and e2e:bob) next to the local
 * socket end, and asserts on the subscribed stream. Prompts are cheap and
 * deterministic; every result is reported as it happened.
 */

const ALICE = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const BOB = { channelUserId: 'bob', evidence: 'platform_signed' as const };
/** Not an owner: in a group the default policy only observes it. */
const STRANGER = { channelUserId: 'eve', displayName: 'Eve', evidence: 'platform_signed' as const };
const LOCAL = 'local:e2e';
const TURN_MS = 180_000;

export interface Scenario {
  id: string;
  name: string;
  /** Reason to skip under this config, if any. */
  skip?(c: Config): string | undefined;
  run(ctx: E2EContext): Promise<string>;
}

export interface E2EContext {
  base: Config;
  progress(msg: string): void;
  /** Gateways and dirs to clean up after the scenario. */
  cleanup: (() => Promise<void> | void)[];
}

class Failure extends Error {}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Failure(msg);
}

const bodies = <K extends SessionEvent['body']['t']>(evs: SessionEvent[], t: K) =>
  evs.filter((e) => e.body.t === t).map((e) => e.body as BodyOf<K>);

async function waitFor<T>(what: string, ms: number, get: () => T | undefined | false): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Failure(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Collects a client subscription in the background. */
class Watch {
  readonly events: SessionEvent[] = [];
  ended = false;
  constructor(readonly sub: ClientSubscription) {
    void (async () => {
      for await (const e of sub) this.events.push(e);
      this.ended = true;
    })();
  }
  of<K extends SessionEvent['body']['t']>(t: K) {
    return bodies(this.events, t);
  }
  turnStartedWith(inputId: string, ms = TURN_MS) {
    return waitFor(`turn with input ${inputId}`, ms, () => this.of('turn.started').find((b) => b.inputIds.includes(inputId)));
  }
  completed(turnId: string, ms = TURN_MS) {
    return waitFor(`turn ${turnId} to complete`, ms, () => this.of('turn.completed').find((b) => b.turnId === turnId));
  }
  item(turnId: string, ms = TURN_MS) {
    return waitFor(`a tool call in turn ${turnId}`, ms, () => this.events.find((e) => e.turnId === turnId && e.body.t === 'item.started' && e.body.item.type !== 'reasoning' && e.body.item.type !== 'agent_message'));
  }
  finalText(turnId: string): string {
    const snaps = this.events.filter((e) => e.turnId === turnId && e.body.t === 'text.snapshot' && e.body.final && e.audience === 'answer');
    return snaps.map((e) => (e.body as BodyOf<'text.snapshot'>).text).join('\n');
  }
  durableSeqs(): number[] {
    return this.events.filter((e) => e.durability === 'durable' && !isSnapshotEvent(e)).map((e) => e.seq);
  }
}

/** Durable seqs must be exactly from+1, from+2, … */
function gapless(seqs: number[], from: number): string | undefined {
  for (let i = 0; i < seqs.length; i++) if (seqs[i] !== from + 1 + i) return `seq ${seqs[i]} at position ${i}, expected ${from + 1 + i}`;
  return undefined;
}

/**
 * The log's seqs are gapless, and a subscriber saw exactly the durable events its
 * tier lets through (internal ones, e.g. native debug events, are filtered out).
 */
function streamComplete(w: World, sk: string, seen: number[], tier: Tier = 'full'): string {
  const log = w.gw.hub.log.read(sk, 0);
  const gap = gapless(log.map((e) => e.seq), 0);
  assert(!gap, `session log has a gap: ${gap}`);
  const expected = log.filter((e) => passes(e, tier)).map((e) => e.seq);
  const missing = expected.filter((q) => !seen.includes(q));
  assert(missing.length === 0, `subscriber missed durable seqs ${missing.slice(0, 5).join(', ')}`);
  assert(seen.length === expected.length, `subscriber saw ${seen.length} durable events, expected ${expected.length}`);
  return `log 1..${log.length} gapless, subscriber got all ${expected.length} visible`;
}

interface World {
  gw: Gateway;
  dir: string;
  config: Config;
  chat: FakeChannel;
  raw: Map<string, HarnessEvent[]>;
  /** Host output-tool calls, with the `_meta` the harness sent. */
  toolCalls: { sessionKey: string; tool: string; meta: Record<string, unknown> | undefined; ok: boolean; error?: string }[];
  client(): Promise<LocalClient>;
  watch(sessionKey: string, o?: { tier?: 'full' | 'card' | 'headline' | 'final'; fromSeq?: number; client?: LocalClient }): Promise<Watch>;
}

/** Per-scenario config: temp dirs, no configured channels, e2e owners, local principal. Runs the default instance. */
export function e2eConfig(base: Config, dir: string): Config {
  const { cwd: _cwd, ...h } = defaultInstance(base);
  const options =
    h.kind === 'claude-code'
      ? // No user/project settings: their permission rules would answer approvals the scenario wants to see.
        { ...h.options, sdk: { settingSources: [], ...(h.options.sdk as object | undefined) } }
      : h.options;
  const profiles =
    h.kind === 'codex' && !h.profiles.restricted ? { ...h.profiles, restricted: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } } : h.profiles;
  const run = h.kind === 'codex' && !h.run.effort ? { ...h.run, effort: 'low' } : h.run;
  // Sessions run in the scenario's work dir, not the instance's cwd.
  const inst = { ...h, options, profiles, run } as HarnessInstance;
  return {
    ...withDefaultInstance(base, inst),
    dataDir: dir,
    logPath: join(dir, 'log.sqlite'),
    socketPath: join(dir, 'run', 'aio.sock'),
    blobs: { ...base.blobs, dir: join(dir, 'blobs') },
    cwd: join(dir, 'work'),
    channels: [],
    policy: { ...base.policy, owners: [...base.policy.owners, 'e2e:alice', 'e2e:bob'], ownerSessionKey: undefined },
    local: { principal: { id: LOCAL, labels: ['owner'] }, session: 'e2e:local' },
  };
}

function tempDir(ctx: E2EContext, prefix = 'aio-e2e-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  ctx.cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function world(ctx: E2EContext, o: { policy?: Partial<Policy>; dir?: string; config?: Config } = {}): Promise<World> {
  const dir = o.dir ?? tempDir(ctx);
  const config = o.config ?? e2eConfig(ctx.base, dir);
  mkdirSync(config.cwd, { recursive: true });
  const chat = new FakeChannel('e2e', defaultChannelCaps);
  const raw = new Map<string, HarnessEvent[]>();
  const toolCalls: World['toolCalls'] = [];
  const gw = await Gateway.start({
    onToolCall: (e) => {
      toolCalls.push(e);
      ctx.progress(`tool ${e.tool} ${e.ok ? 'ok' : `failed: ${e.error}`}; _meta keys: ${Object.keys(e.meta ?? {}).join(', ') || 'none'}`);
    },
    config,
    channels: [{ adapter: chat }],
    ...(o.policy ? { policy: o.policy } : {}),
    onHarnessEvent: (k, e) => {
      let l = raw.get(k);
      if (!l) raw.set(k, (l = []));
      l.push(e);
    },
    logger: (level, msg) => (level === 'error' || level === 'warn' ? ctx.progress(`${level}: ${msg}`) : undefined),
  });
  const clients: LocalClient[] = [];
  ctx.cleanup.push(async () => {
    for (const c of clients) c.close();
    await gw.stop();
  });
  const client = async () => {
    const c = await LocalClient.connect(config.socketPath);
    clients.push(c);
    return c;
  };
  return {
    gw,
    dir,
    config,
    chat,
    raw,
    toolCalls,
    client,
    watch: async (sessionKey, w = {}) => new Watch(await (w.client ?? (await client())).subscribe({ sessionKey, tier: w.tier ?? 'full', fromSeq: w.fromSeq ?? 0 })),
  };
}

/** The raw harness stream of a session conforms (turn inputs include steered ones). */
function conforms(w: World, sessionKey: string, watch: Watch | SessionEvent[], allowTrailing = false): void {
  const events = Array.isArray(watch) ? watch : watch.events;
  const inputs = (turnId: string) => {
    const started = bodies(events, 'turn.started').find((b) => b.turnId === turnId)?.inputIds ?? [];
    const steered = events.filter((e) => e.turnId === turnId && e.body.t === 'input.admitted' && e.body.disposition === 'steer').map((e) => (e.body as BodyOf<'input.admitted'>).inputId);
    return [...started, ...steered];
  };
  const vs = checkEventStream(w.raw.get(sessionKey) ?? [], { turnInputs: inputs, allowTrailing });
  assert(vs.length === 0, `harness stream does not conform: ${vs.slice(0, 3).map((v) => `[${v.rule}] ${v.message}`).join('; ')}`);
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Which `_meta` keys the harness sent with its output-tool calls (the idempotency key comes from one). */
function metaSummary(w: World): string {
  const keys = new Set(w.toolCalls.flatMap((c) => Object.keys(c.meta ?? {})));
  const idKey = ['claudecode/toolUseId', 'callId'].find((k) => w.toolCalls.some((c) => typeof c.meta?.[k] === 'string'));
  return `_meta keys [${[...keys].join(', ') || 'none'}]${idKey ? ` (${idKey} → operationId)` : ' (no call id: JSON-RPC id fallback)'}`;
}

const outputsOf = (w: World, sk: string) =>
  w.gw.hub.log
    .read(sk, 0)
    .filter((e) => e.body.t === 'native' && e.body.name === OUTPUT_EVENT)
    .map((e) => e.native as OutputRecord);

export const SCENARIOS: Scenario[] = [
  {
    id: 'a',
    name: 'one-input',
    async run(ctx) {
      const w = await world(ctx);
      const sk = 'e2e:default:c1';
      const watch = await w.watch(sk);
      const t0 = Date.now();
      const r = await w.chat.inject({ sender: ALICE, text: 'Reply with exactly: pong' });
      assert(r.accepted && r.inputId, 'channel input was not accepted');
      const started = await watch.turnStartedWith(r.inputId);
      const done = await watch.completed(started.turnId);
      assert(done.status === 'completed', `turn ended ${done.status}${done.error ? ` (${done.error.code})` : ''}`);
      const text = watch.finalText(started.turnId);
      assert(/pong/i.test(text), `final answer does not contain pong: ${JSON.stringify(text.slice(0, 80))}`);
      assert(watch.of('input.consumed').some((b) => b.inputIds.includes(r.inputId!)), 'input never reported consumed');
      conforms(w, sk, watch);
      await new Promise((res) => setTimeout(res, 300)); // the trailing session.state
      const seqs = streamComplete(w, sk, watch.durableSeqs());
      const card = await waitFor('the channel card to be finalized', 15_000, () => w.chat.sent.find((s) => s.finalized));
      const shown = card.edits.at(-1)?.text ?? card.msg.text;
      assert(/pong/i.test(shown), `card shows ${JSON.stringify(shown.slice(0, 80))}`);
      return `turn completed in ${sec(Date.now() - t0)}; ${seqs}; card finalized with the answer`;
    },
  },
  {
    id: 'b',
    name: 'batch-same-principal',
    async run(ctx) {
      const w = await world(ctx);
      const sk = 'e2e:local';
      const c = await w.client();
      const watch = await w.watch(sk, { client: c });
      const blocker = await c.input(sk, 'Use the shell to run `sleep 4`, then reply with exactly: ready');
      const first = await watch.turnStartedWith(blocker.inputId);
      ctx.progress('blocker turn running; sending three inputs');
      const sent = [];
      for (const text of ['Remember the word alpha.', 'Remember the word beta.', 'Reply with exactly the two words you were asked to remember, separated by one space.']) sent.push(await c.input(sk, text));
      assert(sent.every((s) => s.disposition === 'queued'), `dispositions: ${sent.map((s) => s.disposition).join(', ')}`);
      await watch.completed(first.turnId);
      const ids = sent.map((s) => s.inputId);
      const turn = await watch.turnStartedWith(ids[0]!);
      assert(ids.every((id) => turn.inputIds.includes(id)), `the three inputs were split: turn ${turn.turnId} got ${turn.inputIds.length} of them`);
      const done = await watch.completed(turn.turnId);
      assert(done.status === 'completed', `batched turn ended ${done.status}`);
      const consumed = new Set(watch.of('input.consumed').filter((b) => b.turnId === turn.turnId).flatMap((b) => b.inputIds));
      assert(ids.every((id) => consumed.has(id)), `consumed ${consumed.size} of 3 in the batched turn`);
      conforms(w, sk, watch);
      return `3 queued inputs ran as one turn, all consumed; answer ${JSON.stringify(watch.finalText(turn.turnId).slice(0, 40))}`;
    },
  },
  {
    id: 'c',
    name: 'principals-not-merged',
    async run(ctx) {
      const w = await world(ctx);
      const sk = 'e2e:default:g1';
      const watch = await w.watch(sk);
      const conv = { id: 'g1', kind: 'group' as const };
      const a = await w.chat.inject({ sender: ALICE, conversation: conv, text: 'Reply with exactly: one' });
      const b = await w.chat.inject({ sender: BOB, conversation: conv, text: 'Reply with exactly: two' });
      const a2 = await w.chat.inject({ sender: ALICE, conversation: conv, text: 'Reply with exactly: three' });
      const ids = [a.inputId, b.inputId, a2.inputId];
      assert(ids.every(Boolean), 'an input was not accepted');
      const turns = [];
      for (const id of ids) turns.push(await watch.turnStartedWith(id!));
      for (const t of turns) await watch.completed(t.turnId);
      const who = new Map(watch.of('input.admitted').map((x) => [x.inputId, x.principalId]));
      for (const t of watch.of('turn.started')) {
        const principals = new Set(t.inputIds.map((i) => who.get(i)));
        assert(principals.size === 1, `turn ${t.turnId} mixes principals ${[...principals].join(', ')}`);
      }
      assert(new Set(turns.map((t) => t.turnId)).size === 3, 'alice and bob inputs shared a turn');
      conforms(w, sk, watch);
      return `3 turns, one principal each (${turns.map((t) => who.get(t.inputIds[0]!)).join(' → ')})`;
    },
  },
  {
    id: 'd',
    name: 'steer',
    async run(ctx) {
      const w = await world(ctx);
      const sk = 'e2e:local';
      const c = await w.client();
      const watch = await w.watch(sk, { client: c });
      const first = await c.input(sk, 'Use the shell to run `sleep 6`, then reply with exactly: done');
      const turn = await watch.turnStartedWith(first.inputId);
      await watch.item(turn.turnId);
      const steer = await c.input(sk, 'Change of plan: when the command has finished, reply with exactly: done banana', 'steer');
      ctx.progress(`steer disposition: ${steer.disposition}`);
      const done = await watch.completed(turn.turnId);
      if (steer.disposition === 'steer') {
        const consumed = watch.of('input.consumed').filter((b) => b.turnId === turn.turnId).flatMap((b) => b.inputIds);
        assert(done.status === 'completed', `steered turn ended ${done.status}`);
        assert(consumed.includes(steer.inputId), 'steer was admitted into the turn but the harness never reported consuming it there');
        conforms(w, sk, watch);
        const text = watch.finalText(turn.turnId);
        return `folded into the running turn (consumed there); answer ${/banana/i.test(text) ? 'follows' : 'ignores'} the steer: ${JSON.stringify(text.slice(0, 40))}`;
      }
      const notice = watch.of('notice').find((n) => n.message.startsWith('steer degraded'));
      assert(steer.disposition === 'queued' && notice, `steer neither folded nor degraded with a notice (disposition ${steer.disposition})`);
      const later = await watch.turnStartedWith(steer.inputId);
      await watch.completed(later.turnId);
      conforms(w, sk, watch);
      return `degraded to queue with notice "${notice.message}", ran as the next turn`;
    },
  },
  {
    id: 'e',
    name: 'interrupt',
    async run(ctx) {
      const w = await world(ctx);
      const sk = 'e2e:local';
      const c = await w.client();
      const watch = await w.watch(sk, { client: c });
      const r = await c.input(sk, 'Use the shell to run `sleep 30`, then reply with exactly: done');
      const turn = await watch.turnStartedWith(r.inputId);
      await watch.item(turn.turnId);
      const t0 = Date.now();
      await c.command({ type: 'interrupt', sessionKey: sk });
      const done = await watch.completed(turn.turnId, 25_000);
      assert(done.status === 'interrupted', `turn ended ${done.status}, expected interrupted`);
      conforms(w, sk, watch);
      return `turn interrupted ${sec(Date.now() - t0)} after the command`;
    },
  },
  {
    id: 'f',
    name: 'human-approval',
    async run(ctx) {
      const dir = tempDir(ctx);
      const config = e2eConfig(ctx.base, dir);
      // Every turn restricted, every request to the local principal: the opposite of the defaults.
      const policy: Partial<Policy> = {
        plan: async () => ({ ...defaultInstance(config).run, profile: 'restricted' }),
        resolve: async () => ({ kind: 'human', principals: [LOCAL], routes: [] }),
      };
      const w = await world(ctx, { policy, dir, config });
      const sk = 'e2e:local';
      const a = await w.client();
      const b = await w.client();
      const watchA = await w.watch(sk, { client: a });
      const watchB = await w.watch(sk, { client: b, tier: 'final' });
      const r = await a.input(sk, 'Use the shell to run `mkdir approved-dir`, then reply with exactly: done');
      const turn = await watchA.turnStartedWith(r.inputId);
      const t0 = Date.now();
      const answered = new Set<string>();
      // Approve whatever reaches the second (final-tier) subscriber until the turn ends.
      while (!watchA.of('turn.completed').some((x) => x.turnId === turn.turnId)) {
        const open = watchB.of('request.opened').find((x) => !answered.has(x.requestId));
        if (open) {
          answered.add(open.requestId);
          assert(open.resolver?.kind === 'human', `request ${open.requestId} resolver is ${open.resolver?.kind}`);
          await b.command({ type: 'resolve', sessionKey: sk, requestId: open.requestId, decision: { kind: 'allow_once' } });
          ctx.progress(`approved ${open.requestId}: ${open.title}`);
        }
        await new Promise((r) => setTimeout(r, 100));
        if (Date.now() - t0 > TURN_MS) throw new Failure('timed out waiting for the turn to complete');
      }
      const done = await watchA.completed(turn.turnId);
      assert(answered.size > 0, 'no request.opened reached the second subscriber');
      assert(done.status === 'completed', `turn ended ${done.status}`);
      const resolved = watchA.of('request.resolved').filter((x) => answered.has(x.requestId));
      assert(resolved.every((x) => typeof x.by === 'object' && x.by.kind === 'human' && x.by.id === LOCAL), 'a request was not resolved by the human');
      const made = existsSync(join(w.config.cwd, 'approved-dir'));
      conforms(w, sk, watchA);
      return `${answered.size} request(s) reached a final-tier subscriber, resolved by ${LOCAL}; turn completed; dir ${made ? 'created' : 'NOT created'}`;
    },
  },
  {
    id: 'g',
    name: 'reconnect-from-seq',
    async run(ctx) {
      const w = await world(ctx);
      const sk = 'e2e:local';
      const c1 = await w.client();
      const w1 = await w.watch(sk, { client: c1 });
      const r = await c1.input(sk, 'Use the shell to run `sleep 3`, then reply with exactly: pong');
      const turn = await w1.turnStartedWith(r.inputId);
      const lastSeq = Math.max(...w1.durableSeqs());
      c1.close();
      ctx.progress(`disconnected at seq ${lastSeq}`);
      await new Promise((res) => setTimeout(res, 2500));
      const w2 = await w.watch(sk, { fromSeq: lastSeq });
      await w2.completed(turn.turnId);
      await new Promise((res) => setTimeout(res, 300));
      assert(!w2.events.some(isSnapshotEvent), 'reconnect got a snapshot although fromSeq was retained');
      const seen = [...w1.durableSeqs().filter((s) => s <= lastSeq), ...w2.durableSeqs()];
      const seqs = streamComplete(w, sk, seen);
      conforms(w, sk, [...w1.events, ...w2.events], true);
      return `disconnected at seq ${lastSeq}, reconnected with fromSeq: ${seqs}`;
    },
  },
  {
    id: 'h',
    name: 'codex-restart-adopt',
    skip: (c) => (defaultInstance(c).kind !== 'codex' ? 'codex unix transport only' : undefined),
    async run(ctx) {
      const dir = tempDir(ctx, 'aio-h-');
      const base = e2eConfig(ctx.base, dir);
      // Our own detached app-server on a Unix socket, so it outlives the first gateway.
      const inst = defaultInstance(base);
      if (inst.kind !== 'codex') throw new Error('unreachable');
      const transport = { kind: 'unix', spawn: 'own', stateDir: join(dir, 'cx') } as const;
      const config = withDefaultInstance(base, { ...inst, codex: { ...inst.codex, transport } });
      ctx.cleanup.push(() => new CodexHarness({ transport }).shutdownOwnServer().then(() => undefined));
      const sk = 'e2e:local';
      const one = await world(ctx, { dir, config });
      const c1 = await one.client();
      const w1 = await one.watch(sk, { client: c1 });
      const r = await c1.input(sk, 'Use the shell to run `sleep 12`, then reply with exactly: done');
      const turn = await w1.turnStartedWith(r.inputId);
      await w1.item(turn.turnId);
      ctx.progress('stopping the first gateway mid-turn (codex detach)');
      await one.gw.stop();

      const two = await world(ctx, { dir, config });
      const w2 = await two.watch(sk, { fromSeq: 0 });
      const adopted = await waitFor('turn.adopted', 30_000, () => w2.of('turn.adopted').find((b) => b.turnId === turn.turnId));
      const done = await w2.completed(turn.turnId);
      assert(done.status === 'completed', `adopted turn ended ${done.status}${done.error ? ` (${done.error.code})` : ''}`);
      const all = two.gw.hub.log.read(sk, 0);
      assert(bodies(all, 'turn.completed').filter((b) => b.turnId === turn.turnId).length === 1, 'turn completed more than once in the log');
      assert(!gapless(all.map((e) => e.seq), 0), 'log has a gap across the restart');
      const at = (t: string) => all.findIndex((e) => e.body.t === t && (e.body as { turnId?: string }).turnId === turn.turnId);
      assert(at('turn.adopted') >= 0 && at('turn.adopted') < at('turn.completed'), 'turn was not left open by gateway 1 and adopted by gateway 2');
      return `turn left open by gateway 1; gateway 2 adopted it (${adopted.inputIds.length} input) and it completed: ${JSON.stringify(w2.finalText(turn.turnId).slice(0, 30))}`;
    },
  },
  {
    id: 'i',
    name: 'watch-digest',
    async run(ctx) {
      const w = await world(ctx);
      const target = 'e2e:local';
      const c = await w.client();
      const watch = await w.watch(target, { client: c });
      const conv = { id: 'x', kind: 'group' as const };
      const added = await c.watchAdd({
        id: 'wx',
        source: { channel: 'e2e', conversation: 'x' },
        target: { sessionKey: target },
        mode: 'digest',
        digest: { everyMs: 5000 },
        note: 'Summarise these group messages for me in one short paragraph; mention every item.',
      });
      assert(added.createdBy === LOCAL, `watch created by ${added.createdBy}`);
      const texts = [
        'The launch moved to Thursday.',
        'Please bring the blue folder to the review.',
        'Budget approved at 42k.',
      ];
      for (const text of texts) {
        const r = await w.chat.inject({ sender: STRANGER, conversation: conv, text });
        assert(r.accepted, 'group message not accepted');
      }
      const ctxInputs = await waitFor('three watched context inputs', 10_000, () => {
        const xs = watch.of('input.admitted').filter((b) => b.disposition === 'observe_only' && b.input?.channelContext.watch === 'wx');
        return xs.length === 3 && xs;
      });
      assert(ctxInputs.every((b) => b.input?.origin.principal === null && b.input.origin.via === 'e2e:default:x'), 'watched inputs lost their original (stranger) origin');
      assert(watch.of('turn.started').length === 0, 'a turn started before the digest');
      ctx.progress('3 context inputs recorded; waiting for the digest');
      const digest = await waitFor('the digest input', 20_000, () => watch.of('input.admitted').find((b) => b.input?.origin.kind === 'system' && b.input.channelContext.watch === 'wx'));
      const turn = await watch.turnStartedWith(digest.inputId);
      const done = await watch.completed(turn.turnId);
      assert(done.status === 'completed', `digest turn ended ${done.status}${done.error ? ` (${done.error.code})` : ''}`);
      await new Promise((r) => setTimeout(r, 1000));
      const turns = watch.of('turn.started');
      assert(turns.length === 1, `expected exactly one turn, got ${turns.length}`);
      assert(turn.inputIds.length === 1 && turn.run?.profile === 'restricted', `digest turn: ${turn.inputIds.length} inputs, profile ${turn.run?.profile}`);
      const notice = watch.of('notice').find((n) => n.message.startsWith('watch wx: digest of 3 items'));
      assert(notice, 'no digest notice in the target log');
      const text = watch.finalText(turn.turnId);
      const missing = [/thursday/i, /folder/i, /42/].filter((re) => !re.test(text));
      assert(missing.length === 0, `answer misses ${missing.join(', ')}: ${JSON.stringify(text.slice(0, 200))}`);
      conforms(w, target, watch);
      return `3 stranger messages → 3 context inputs → 1 digest turn (system origin, restricted); answer mentions all three: ${JSON.stringify(text.slice(0, 160))}`;
    },
  },
  {
    id: 'm',
    name: 'output-ask-choice',
    skip: (c) => (c.outputTools ? undefined : 'outputTools is off'),
    async run(ctx) {
      const w = await world(ctx);
      const sk = 'e2e:default:c1';
      const watch = await w.watch(sk);
      const r = await w.chat.inject({ sender: ALICE, text: 'Use the ask_choice tool to ask me whether I prefer red or blue (options exactly "red" and "blue"). Then stop and wait for my answer. When my answer arrives, reply with exactly: you chose <color>' });
      assert(r.accepted && r.inputId, 'channel input was not accepted');
      const first = await watch.turnStartedWith(r.inputId);
      const sent = await waitFor('the choice message on the channel', TURN_MS, () => w.chat.sent.find((m) => m.msg.actions?.some((a) => parseChoiceActionId(a.id))));
      const choice = (sent.msg.channelData as Record<string, ChoiceData>)[CHOICE_KEY]!;
      assert(choice && choice.options.map((o) => o.toLowerCase()).join(',') === 'red,blue', `options were ${JSON.stringify(choice?.options)}`);
      const done1 = await watch.completed(first.turnId);
      assert(done1.status === 'completed', `asking turn ended ${done1.status}`);
      const blue = sent.msg.actions!.find((a) => /blue/i.test(a.label))!;
      ctx.progress(`clicking ${blue.id}`);
      // A click arrives like any card action: an `action` event with the button's id.
      const click = await w.chat.inject({ sender: ALICE, content: [{ type: 'event', name: 'action', data: { actionId: blue.id, messageId: sent.providerMessageId } }] });
      assert(click.accepted && click.inputId, 'click was not accepted');
      const second = await watch.turnStartedWith(click.inputId);
      const done2 = await watch.completed(second.turnId);
      assert(done2.status === 'completed', `answer turn ended ${done2.status}`);
      const text = watch.finalText(second.turnId);
      assert(/blue/i.test(text), `answer does not mention blue: ${JSON.stringify(text.slice(0, 80))}`);
      const settled = watch.of('delivery.settled').find((d) => d.operationId === outputsOf(w, sk).find((o) => o.tool === 'ask_choice')?.operationId);
      assert(settled?.result === 'delivered', 'ask_choice delivery was not settled as delivered');
      return `buttons ${sent.msg.actions!.map((a) => a.label).join('/')} on the channel (choice ${choice.choiceId}); click → new turn → ${JSON.stringify(text.slice(0, 40))}; ${metaSummary(w)}`;
    },
  },
  {
    id: 'n',
    name: 'output-send-file',
    skip: (c) => (c.outputTools ? undefined : 'outputTools is off'),
    async run(ctx) {
      const w = await world(ctx);
      const sk = 'e2e:default:c1';
      const body = `# e2e file\nmarker ${Math.random().toString(36).slice(2)}\n`;
      writeFileSync(join(w.config.cwd, 'README.md'), body);
      const watch = await w.watch(sk);
      const r = await w.chat.inject({ sender: ALICE, text: 'Send the file README.md to me (use the send_file tool). Then reply with exactly: sent' });
      assert(r.accepted && r.inputId, 'channel input was not accepted');
      const turn = await watch.turnStartedWith(r.inputId);
      const done = await watch.completed(turn.turnId);
      assert(done.status === 'completed', `turn ended ${done.status}`);
      const sent = w.chat.sent.find((m) => m.msg.attachments?.length);
      const mcpStatus = (w.raw.get(sk) ?? []).filter((e) => e.body.t === 'native' && e.body.name === 'mcpServer/startupStatus/updated').map((e) => JSON.stringify(e.native).slice(0, 160));
      assert(sent, `no attachment reached the channel (tool calls: ${w.toolCalls.map((c) => `${c.tool}:${c.ok ? 'ok' : c.error}`).join(', ') || 'none'}; answer ${JSON.stringify(watch.finalText(turn.turnId).slice(0, 200))}; mcp ${mcpStatus.join(' | ')})`);
      const att = sent.msg.attachments![0]!;
      assert(att.name === 'README.md', `attachment name ${att.name}`);
      const got = new TextDecoder().decode((await w.gw.blobs.get(att.ref)).bytes);
      assert(got === body, 'attachment bytes differ from README.md');
      const op = outputsOf(w, sk).find((o) => o.tool === 'send_file');
      assert(op && watch.of('delivery.settled').some((d) => d.operationId === op.operationId && d.result === 'delivered'), 'send_file delivery not settled');
      return `README.md (${att.mime}, ${got.length} bytes) arrived as an attachment, bytes match; ${metaSummary(w)}`;
    },
  },
  {
    id: 'o',
    name: 'output-terminal-choose',
    skip: (c) => (c.outputTools ? undefined : 'outputTools is off'),
    async run(ctx) {
      const w = await world(ctx);
      const sk = 'e2e:local';
      const c = await w.client();
      const watch = await w.watch(sk, { client: c });
      const r = await c.input(sk, 'Use the ask_choice tool to ask me: "Which fruit?" with options "apple" and "pear". Then stop and wait. When my answer arrives, reply with exactly: fruit <name>');
      const first = await watch.turnStartedWith(r.inputId);
      const out = await waitFor('the ask_choice output event', TURN_MS, () => watch.events.find((e) => e.body.t === 'native' && e.body.name === OUTPUT_EVENT && (e.native as OutputRecord).choice));
      const choice = (out.native as OutputRecord).choice!;
      await watch.completed(first.turnId);
      const pear = choice.options.findIndex((o) => /pear/i.test(o)) + 1;
      assert(pear > 0, `options ${JSON.stringify(choice.options)}`);
      // What `/choose <id> <n>` sends.
      const ans = await c.command<{ inputId: string }>({ type: 'input', sessionKey: sk, mode: 'queue', input: { content: [{ type: 'event', name: 'choice', data: { choiceId: choice.choiceId, selected: [pear] } }] } });
      const bad = await c.command({ type: 'input', sessionKey: sk, mode: 'queue', input: { content: [{ type: 'event', name: 'choice', data: { choiceId: choice.choiceId, selected: [9] } }] } }).then(() => 'accepted', (e: Error) => e.message);
      assert(bad !== 'accepted', 'an out-of-range /choose was accepted');
      const second = await watch.turnStartedWith(ans.inputId);
      await watch.completed(second.turnId);
      const text = watch.finalText(second.turnId);
      assert(/pear/i.test(text), `answer does not mention pear: ${JSON.stringify(text.slice(0, 80))}`);
      return `choice event on the local stream (event-only), /choose ${choice.choiceId} ${pear} → ${JSON.stringify(text.slice(0, 30))}; bad answer refused (${bad.slice(0, 40)})`;
    },
  },
];

export interface E2EResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  ms: number;
}

export async function runScenarios(base: Config, o: { only?: string[]; out?: (line: string) => void; verbose?: boolean } = {}): Promise<E2EResult[]> {
  const out = o.out ?? ((l: string) => console.log(l));
  const picked = SCENARIOS.filter((s) => !o.only?.length || o.only.some((x) => x === s.id || x === s.name));
  const results: E2EResult[] = [];
  for (const s of picked) {
    const label = `${s.id} ${s.name}`;
    const skip = s.skip?.(base);
    if (skip) {
      results.push({ id: s.id, name: s.name, status: 'SKIP', detail: skip, ms: 0 });
      out(`SKIP ${label}: ${skip}`);
      continue;
    }
    const ctx: E2EContext = { base, cleanup: [], progress: (m) => o.verbose && out(`     ${s.id}: ${m}`) };
    const t0 = Date.now();
    let r: E2EResult;
    try {
      const detail = await withTimeout(s.run(ctx), 300_000);
      r = { id: s.id, name: s.name, status: 'PASS', detail, ms: Date.now() - t0 };
    } catch (e) {
      r = { id: s.id, name: s.name, status: 'FAIL', detail: e instanceof Failure ? e.message : `error: ${(e as Error).message}`, ms: Date.now() - t0 };
    }
    for (const c of ctx.cleanup.reverse()) await Promise.resolve(c()).catch(() => undefined);
    results.push(r);
    out(`${r.status} ${label} (${sec(r.ms)}): ${r.detail}`);
  }
  return results;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Failure(`scenario timed out after ${sec(ms)}`)), ms)))]).finally(() => clearTimeout(t));
}
