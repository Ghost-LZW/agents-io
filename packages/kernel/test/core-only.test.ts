import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Binding, HarnessOpenArgs, InputRecord, Policy, SessionEvent } from '@agents-io/protocol';
import { KERNEL_TOOL_NAMES } from '@agents-io/host-mcp';
import { isSnapshotEvent } from '@agents-io/session';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { CommandError, LocalClient } from '../src/client.js';
import { COMMAND_HELP } from '../src/commands.js';
import { ConfigError, EMBEDDED_HARNESS, loadConfig, resolveConfig } from '../src/config.js';
import { coreRegistries } from '../src/core.js';
import { Gateway } from '../src/gateway.js';
import { FEATURES } from '../src/host.js';
import { readTokenFile, tokenPath } from '../src/token.js';
// The console is its own core package, which depends on the kernel: reached by path, not as a dependency.
import { consoleFactory } from '../../console/src/index.js';
import { cleanups, closeAndWait, tmp, until } from './helpers.js';

/*
 * The kernel without modules is a product of its own (core-slimming §5): the kernel package alone
 * (`@agents-io/kernel`: no module package, not `@agents-io/daemon`), registries with nothing
 * registered (`coreRegistries`), and the channel and harness the embedder passes (here testkit's
 * FakeChannel and FakeHarness); its console API is the console package's (`@agents-io/console`,
 * `GatewayOptions.consoleFactory`), as an embedder would give it. The kernel's promises hold end to
 * end, and nothing a module adds is there. This file imports no module package either.
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const of = (evs: SessionEvent[], t: string) => evs.filter((e) => e.body.t === t).map((e) => e.body as never as Record<string, unknown>);
const textOf = (inputs: InputRecord[]) => inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join('+');

interface Core {
  gw: Gateway;
  dir: string;
  chat: FakeChannel;
  harness: FakeHarness;
  log(sessionKey: string): SessionEvent[];
  client(): Promise<LocalClient>;
  /** A connection that said host.hello with the daemon's token. */
  host(name?: string): Promise<LocalClient>;
  stop(): Promise<void>;
}

/**
 * A kernel on `coreRegistries()` over a SQLite log in `dir` (reuse `dir` to restart it): the owner
 * fake:alice on the embedder's FakeChannel `fake`, the embedder's FakeHarness behind the config's
 * one instance.
 */
async function core(o: { dir?: string; raw?: Record<string, unknown>; script?: FakeTurnScript; policy?: Partial<Policy>; console?: boolean } = {}): Promise<Core> {
  const dir = o.dir ?? tmp('aio-core-');
  const registries = coreRegistries();
  const raw = { dataDir: dir, policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, cwd: dir, ...(o.console ? { console: { port: 0 } } : {}), ...o.raw };
  const config = { ...resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir, ...registries }), socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  const harness = new FakeHarness(o.script);
  const gw = await Gateway.start({
    config,
    ...registries,
    harness,
    channels: [{ adapter: chat }],
    ...(o.policy ? { policy: o.policy } : {}),
    hostPush: { timeoutMs: 300, retryMs: 20 },
    logger: () => {},
    ...(o.console ? { console: true, consoleFactory, consoleEnv: {} } : {}),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await gw.stop();
  };
  cleanups.push(stop);
  const client = async () => {
    const c = await LocalClient.connect(config.socketPath);
    cleanups.push(() => c.close());
    return c;
  };
  const host = async (name = 'xwo') => {
    const c = await client();
    await c.hello({ token: readTokenFile(tokenPath(config.socketPath)), name });
    return c;
  };
  return { gw, dir, chat, harness, log: (key) => gw.hub.log.read(key, 0), client, host, stop };
}

/** What a harness does with HarnessOpenArgs.mcp: the raw `tools/list` answer. */
async function toolsList(mcp: HarnessOpenArgs['mcp']): Promise<string[]> {
  const res = await fetch(mcp!.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp!.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
}

describe('the kernel with no modules (coreRegistries, the embedder\'s channel and harness)', () => {
  it('a channel message is admitted, consumed by a turn of the embedder\'s harness and answered on its route; the same message again enters once, also after a restart #IN-1 #IN-5', async () => {
    const w = await core();
    expect([w.gw.harnessRegistry.kinds, w.gw.channelRegistry.types, w.gw.moduleRegistry.size]).toEqual([[], [], 0]);
    const key = 'fake:default:c1';
    const r = await w.chat.inject({ id: 'm1', sender: alice, text: 'hi' });
    expect(r.accepted).toBe(true);
    const card = await until(() => w.chat.sent.find((s) => s.finalized));
    expect(card.edits.at(-1)?.text ?? card.msg.text).toBe('echo: hi');
    await until(() => of(w.log(key), 'turn.completed').length === 1);
    expect(of(w.log(key), 'input.admitted').map((a) => a.inputId)).toEqual([r.inputId]);
    expect(of(w.log(key), 'input.consumed').flatMap((c) => c.inputIds as string[])).toEqual([r.inputId]);
    // The config's one instance stands for the adapter the embedder passed: it ran the turn.
    expect(w.harness.sessions.map((s) => s.args.run.harness)).toEqual([EMBEDDED_HARNESS]);

    // The channel delivers it again: no second input, no second turn.
    await w.chat.inject({ id: 'm1', sender: alice, text: 'hi' });
    expect(of(w.log(key), 'input.admitted')).toHaveLength(1);
    await w.stop();
    const w2 = await core({ dir: w.dir });
    await w2.chat.inject({ id: 'm1', sender: alice, text: 'hi' });
    // A message after it runs its turn; by then the redelivery has long been refused.
    const r2 = await w2.chat.inject({ id: 'm2', sender: alice, text: 'again' });
    await until(() => of(w2.log(key), 'turn.completed').length === 2);
    expect(of(w2.log(key), 'input.admitted').map((a) => a.inputId)).toEqual([r.inputId, r2.inputId]);
    expect(of(w2.log(key), 'input.consumed').flatMap((c) => c.inputIds as string[])).toEqual([r.inputId, r2.inputId]);
    expect(w2.harness.sessions.map((s) => s.args.sessionKey)).toEqual([key]);
  });

  it('one writer lane per session and at most one turn at a time: inputs arriving during a turn queue behind it #LN-2', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const w = await core({
      script: async (t) => {
        if (textOf(t.inputs) === 'first') await hold;
        t.emit({ t: 'text.snapshot', text: `echo: ${textOf(t.inputs)}`, final: true }, { audience: 'answer' });
      },
    });
    const a = await w.client();
    const b = await w.client();
    expect(await a.input('s', 'first')).toMatchObject({ disposition: 'new_turn' });
    const queued = await Promise.all([b.input('s', 'second'), a.input('s', 'third')]);
    expect(queued.map((q) => q.disposition)).toEqual(['queued', 'queued']);
    expect(w.gw.sessions().filter((s) => s.sessionKey === 's')).toHaveLength(1);
    release();
    await until(() => of(w.log('s'), 'turn.completed').length === 2);
    // Never two turns open at once; one harness session for the one lane.
    expect(w.log('s').flatMap((e) => (e.body.t === 'turn.started' || e.body.t === 'turn.completed' ? [e.body.t] : []))).toEqual(['turn.started', 'turn.completed', 'turn.started', 'turn.completed']);
    expect(of(w.log('s'), 'text.snapshot').map((s) => s.text)).toEqual(['echo: first', 'echo: second+third']);
    expect(w.harness.sessions).toHaveLength(1);
  });

  it('the session log is gapless and only grows, across a restart; a client resumes from fromSeq with exactly what it missed, and one ahead of the head gets a snapshot first #LN-1 #LN-10', async () => {
    const w = await core();
    const c1 = await w.client();
    await c1.input('s', 'one');
    await until(() => of(w.log('s'), 'turn.completed').length === 1);
    const head = w.gw.hub.log.head('s');
    expect(w.log('s').map((e) => e.seq)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
    await w.stop();
    const w2 = await core({ dir: w.dir });
    const c2 = await w2.client();
    await c2.input('s', 'two');
    await until(() => of(w2.log('s'), 'turn.completed').length === 2);
    const all = w2.log('s');
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
    // Resume from where the first daemon's client was.
    const resumed: SessionEvent[] = [];
    const sub = await (await w2.client()).subscribe({ sessionKey: 's', tier: 'full', fromSeq: head });
    void (async () => {
      for await (const e of sub) resumed.push(e);
    })();
    await until(() => resumed.some((e) => e.body.t === 'turn.completed'));
    await new Promise((r) => setTimeout(r, 20));
    expect(resumed.map((e) => e.seq)).toEqual(w2.gw.hub.log.read('s', head).map((e) => e.seq));
    // A cursor ahead of the head: a snapshot at the head, then the events that follow.
    const now = w2.gw.hub.log.head('s');
    const ahead: SessionEvent[] = [];
    const sub2 = await (await w2.client()).subscribe({ sessionKey: 's', tier: 'full', fromSeq: now + 50 });
    expect(sub2.head).toBe(now);
    void (async () => {
      for await (const e of sub2) ahead.push(e);
    })();
    await until(() => ahead.length > 0);
    expect(isSnapshotEvent(ahead[0]!)).toBe(true);
    expect(ahead[0]!.seq).toBe(now);
    await c2.input('s', 'three');
    await until(() => ahead.some((e) => e.body.t === 'turn.completed'));
    await new Promise((r) => setTimeout(r, 20));
    expect(ahead.slice(1).filter((e) => e.durability === 'durable').map((e) => e.seq)).toEqual(w2.gw.hub.log.read('s', now).map((e) => e.seq));
  });

  it('every delivery settles once: the reply card and a host delivery; the same operationId again is not sent again, also after a restart; explain traces the reply to its turn and input #DL-1 #DL-2 #EX-2', async () => {
    const w = await core();
    const key = 'fake:default:c1';
    const r = await w.chat.inject({ sender: alice, text: 'hi' });
    const card = await until(() => w.chat.sent.find((s) => s.finalized));
    await until(() => of(w.log(key), 'turn.completed').length === 1);
    // The card's deliveries (opening it, finishing it): each settled once, delivered.
    const settled = await until(() => {
      const all = of(w.log(key), 'delivery.settled');
      return all.length >= 2 && all;
    });
    expect(new Set(settled.map((d) => d.operationId)).size).toBe(settled.length);
    expect(settled.every((d) => d.result === 'delivered')).toBe(true);
    expect(settled.map((d) => d.operationId)).toContain(card.op.operationId);
    const turnId = of(w.log(key), 'turn.started')[0]!.turnId;
    const h = await w.host();
    expect(await h.explain(card.op.operationId)).toMatchObject({ operationId: card.op.operationId, sessionKey: key, turnId, inputIds: [r.inputId], result: 'delivered', providerMessageId: card.providerMessageId });

    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    const message = { text: 'from the host' };
    expect(await h.deliver({ operationId: 'op-1', route, message })).toMatchObject({ operationId: 'op-1', status: 'delivered', duplicate: false });
    expect(await h.deliver({ operationId: 'op-1', route, message })).toMatchObject({ status: 'delivered', duplicate: true });
    expect(w.chat.sent.filter((s) => s.msg.text === 'from the host')).toHaveLength(1);
    expect(of(w.log('host:xwo'), 'delivery.settled')).toEqual([expect.objectContaining({ result: 'delivered' })]);
    await expect(h.deliver({ operationId: 'op-2', route: { ...route, channel: 'nope' }, message })).rejects.toMatchObject({ code: 'unknown_channel' });
    await w.stop();
    const w2 = await core({ dir: w.dir });
    expect(await (await w2.host()).deliver({ operationId: 'op-1', route, message })).toMatchObject({ status: 'delivered', duplicate: true });
    expect(w2.chat.sent).toHaveLength(0);
    expect(of(w2.log('host:xwo'), 'delivery.settled')).toHaveLength(1);
  });

  it('a request is opened once and resolved once: the first answer wins, a second is refused #RQ-1', async () => {
    const w = await core({
      script: async (t) => {
        t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'rm -rf build', risk: { writes: true }, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
        const d = await t.waitDecision('r1');
        t.emit({ t: 'text.snapshot', text: `got ${d.kind}`, final: true }, { audience: 'answer' });
      },
      policy: { resolve: async () => ({ kind: 'human', principals: ['me'], routes: [] }) },
    });
    const c = await w.client();
    await c.input('s', 'go');
    await until(() => of(w.log('s'), 'request.opened').length === 1);
    await c.command({ type: 'resolve', sessionKey: 's', requestId: 'r1', decision: { kind: 'allow_once' } });
    await expect(c.command({ type: 'resolve', sessionKey: 's', requestId: 'r1', decision: { kind: 'deny' } })).rejects.toThrow(CommandError);
    await until(() => of(w.log('s'), 'turn.completed').length === 1);
    expect(of(w.log('s'), 'request.opened')).toHaveLength(1);
    expect(of(w.log('s'), 'request.resolved')).toEqual([expect.objectContaining({ requestId: 'r1', decision: { kind: 'allow_once' }, by: expect.objectContaining({ kind: 'human', id: 'me' }) })]);
    expect(of(w.log('s'), 'text.snapshot').at(-1)).toMatchObject({ text: 'got allow_once' });
  });

  it('the host inbound queue keeps what the host has not acked: reads do not move the cursor, an ack does, and the rest is there after a restart #HQ-1', async () => {
    const hostRule: Binding = { id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host' };
    const w = await core();
    const admin = await w.host();
    await admin.bindingsPut({ version: 'q1', bindings: [hostRule], identities: [], onHostDown: 'keep' });
    await closeAndWait(w.gw, admin);
    await w.chat.inject({ id: 'p1', sender: alice, text: 'xwo a' });
    await w.chat.inject({ id: 'p2', sender: alice, text: 'xwo b' });
    const t = await w.host('tail');
    const r1 = await t.inboundRead({ consumer: 'xwo' });
    expect(r1.items.map((i) => i.channelRef)).toEqual(['channel:fake/p1', 'channel:fake/p2']);
    expect((await t.inboundRead({ consumer: 'xwo' })).items).toHaveLength(2);
    expect(await t.inboundAck('xwo', r1.items[0]!.cursor)).toMatchObject({ acked: r1.items[0]!.cursor });
    expect((await t.inboundRead({ consumer: 'xwo' })).items.map((i) => i.channelRef)).toEqual(['channel:fake/p2']);
    await w.stop();
    const w2 = await core({ dir: w.dir });
    const again = await (await w2.host('tail')).inboundRead({ consumer: 'xwo' });
    expect(again).toMatchObject({ acked: r1.items[0]!.cursor });
    expect(again.items.map((i) => [i.channelRef, i.cursor])).toEqual([['channel:fake/p2', r1.items[1]!.cursor]]);
  });

  it('nothing a module adds is there: the owner-commands commands are ordinary messages and /help is the kernel\'s; the model tools are the kernel\'s six, with no topic hint; host.hello lists the kernel\'s features; no external MCP endpoint; /api/bots/lark is an unknown route #CT-2 #CF-6 #PR-1', async () => {
    const holder: { h?: FakeHarness } = {};
    const listed: string[][] = [];
    const inputs: InputRecord[] = [];
    const w = await core({
      raw: { outputTools: true },
      console: true,
      script: async (t) => {
        listed.push(await toolsList(holder.h!.sessions.at(-1)!.args.mcp));
        inputs.push(...t.inputs);
        t.emit({ t: 'text.snapshot', text: `echo: ${textOf(t.inputs)}`, final: true }, { audience: 'answer' });
      },
    });
    holder.h = w.harness;
    const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };
    const reply = async (text: string) => {
      const before = w.chat.sent.length;
      await w.chat.inject({ ...dm, sender: alice, text });
      const s = await until(() => w.chat.sent[before]);
      return s.edits.at(-1)?.text ?? s.msg.text;
    };
    expect(await reply('/help')).toBe(COMMAND_HELP);
    // The kernel's /status: no Plan line (the owner-commands module's).
    const status = (await reply('/status'))!.split('\n');
    expect(status.slice(1)).toEqual(['agent default · embedded (embedded) · model default', `cwd ${w.dir}`, 'state idle']);
    // The run-config commands (the owner-commands module's): each a message the harness gets, a turn of its own.
    const said = ['/agent coder', '/preset fast', '/model opus', '/effort high', '/plan on', '/bypass on', '/compact'];
    for (const text of said) {
      await w.chat.inject({ ...dm, sender: alice, text });
      await until(() => w.chat.sent.some((s) => s.finalized && (s.edits.at(-1)?.text ?? s.msg.text) === `echo: ${text}`));
    }
    expect(inputs.map((i) => textOf([i]))).toEqual(said);
    expect(w.gw.adminStatus().modules).toEqual([]);
    // The kernel's tools only (no watch_*, live_*, session_*), and no topic hint on the inputs.
    expect(listed).toEqual(said.map(() => [...KERNEL_TOOL_NAMES]));
    expect(inputs.every((i) => !('topicTools' in i.channelContext))).toBe(true);
    // host.hello: the kernel's features (onBehalfOf and the test hooks are off by default), no module's.
    const probe = await w.client();
    expect((await probe.hello({ token: w.gw.token, name: 'probe' })).features).toEqual(FEATURES.filter((f) => f !== 'resolve.onBehalfOf' && f !== 'test.hooks'));
    expect(w.gw.adminStatus().externalMcp).toBeUndefined();
    // The console serves the core endpoints only: lark-bot's provisioning is an unknown route.
    const api = async (path: string, init: RequestInit = {}) => {
      const r = await fetch(w.gw.console!.url + path, { ...init, headers: { authorization: `Bearer ${w.gw.token}`, 'content-type': 'application/json' } });
      return { status: r.status, body: (await r.json()) as unknown };
    };
    expect(await api('/api/bots/lark', { method: 'POST', body: JSON.stringify({ name: 'Bot' }) })).toEqual({ status: 404, body: { error: { code: 'not_found', message: 'no POST /api/bots/lark' } } });
    expect((await api('/api/status')).status).toBe(200);
  });

  it('a config file written for modules the kernel lacks fails the load, naming each: a channel type, a harness kind, a config section, a console setting; the one instance needs the embedder\'s adapter to start #CF-4', async () => {
    const dir = tmp('aio-core-');
    const load = (raw: Record<string, unknown>) => {
      const path = join(dir, 'aio.config.json');
      writeFileSync(path, JSON.stringify(raw));
      try {
        loadConfig({ path, env: {}, cwd: dir, ...coreRegistries() });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      throw new Error('loaded');
    };
    expect(load({ channels: [{ type: 'lark-bot', appId: 'cli_x' }] })).toBe('invalid config: /channels/0: Never; channels[0].type: no channel module "lark-bot" is registered (registered types: none)');
    expect(load({ harnesses: { cc: { use: 'claude-code' } } })).toBe('invalid config: /harnesses/cc/use: Expected \'module\'; harnesses.cc.use: no harness module "claude-code" is registered (registered kinds: none; or "module")');
    expect(load({ harness: { use: 'codex' } })).toBe('invalid config: /harness/use: Never; harness.use: no harness module "codex" is registered (registered kinds: none)');
    expect(load({ externalMcp: { clients: {} } })).toBe('invalid config: /externalMcp: Unexpected property; externalMcp: not a key of the config, and no registered module has a section of that name');
    expect(load({ console: { larkBotCommand: ['npx', 'x'] } })).toBe('invalid config: /console/larkBotCommand: Unexpected property; console.larkBotCommand: not a console setting, and no registered channel module adds one of that name');
    // A value that is not a name is not repeated (it could be a secret pasted in the wrong place).
    expect(load({ channels: [{ type: 'sk live 123' }] })).toBe('invalid config: /channels/0: Never; channels[0].type: no channel module is registered (registered types: none)');
    // A model tool of a module is unknown, as any other name.
    expect(load({ agents: { a: { harness: EMBEDDED_HARNESS, tools: ['watch_add'] } } })).toBe(`agents.a.tools: unknown tool "watch_add" (tools: ${KERNEL_TOOL_NAMES.join(', ')})`);

    // A config naming none loads: its one instance stands for the embedder's adapter, which Gateway.start must get.
    const registries = coreRegistries();
    const config = { ...resolveConfig({ dataDir: dir }, { env: {}, baseDir: dir, cwd: dir, ...registries }), socketPath: join(dir, 'run', 'aio.sock') };
    expect(Object.values(config.harnesses)).toEqual([expect.objectContaining({ name: EMBEDDED_HARNESS, kind: EMBEDDED_HARNESS, run: { harness: EMBEDDED_HARNESS, model: '' } })]);
    expect(config.channels).toEqual([]);
    const started = Gateway.start({ config, ...registries, listen: false, logger: () => {} });
    await expect(started).rejects.toBeInstanceOf(ConfigError);
    await expect(started).rejects.toThrow(`harness instance ${EMBEDDED_HARNESS} stands for the embedder's adapter (no harness kind is registered): pass it to Gateway.start (GatewayOptions.harness or buildHarness)`);
  });

  it('presets are a module\'s (named run defaults): with none registered, a config naming one fails the load, saying no registered module provides presets (their section is an unknown key); a task run naming one is refused with bad_override and nothing runs #CF-4 #RN-2', async () => {
    const dir = tmp('aio-core-');
    const load = (raw: Record<string, unknown>) => {
      try {
        resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir, ...coreRegistries() });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      throw new Error('loaded');
    };
    expect(load({ presets: { fast: { harness: EMBEDDED_HARNESS } } })).toBe('invalid config: /presets: Unexpected property; presets: not a key of the config, and no registered module has a section of that name');
    expect(load({ agents: { a: { preset: 'fast' } } })).toBe('agents.a.preset: unknown preset "fast" (no registered module provides presets)');

    const w = await core({ raw: { agents: { exec: { harness: EMBEDDED_HARNESS, mode: 'task' } } } });
    const h = await w.host();
    const input = [{ type: 'text' as const, text: 'go' }];
    await expect(h.runStart({ runId: 'p', agent: 'exec', input, overrides: { preset: 'fast' } })).rejects.toMatchObject({ code: 'bad_override', message: expect.stringMatching(/unknown preset "fast" \(no registered module provides presets\)$/) });
    expect(w.gw.hub.log.head('run:p')).toBe(0);
    expect(w.harness.sessions).toHaveLength(0);
    // Without it the run runs on the agent's own.
    expect((await h.runStart({ runId: 'q', agent: 'exec', input })).run).toMatchObject({ harness: EMBEDDED_HARNESS });
  });
});
