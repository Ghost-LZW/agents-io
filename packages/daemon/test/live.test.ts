import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessOpenArgs, HarnessSession, LiveEndpoint, LiveFrame, LiveSpeaker, LiveStartArgs, LiveTransport, Policy, SessionEvent } from '@agents-io/protocol';
import { MemorySessionLog, SqliteSessionLog, type SessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness, type FakeHarnessSession, type FakeTurnScript } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until<T>(get: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function mcpCall(mcp: { url: string; token: string } | undefined, name: string, args: Record<string, unknown>, callId: string) {
  if (!mcp) throw new Error('no mcp mounted');
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'claudecode/toolUseId': callId } } }),
  });
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: !!body.result.isError, text: body.result.content[0]!.text };
}

/** FakeHarness whose sessions have realtime voice. */
class LiveFakeHarness extends FakeHarness {
  readonly starts: LiveStartArgs[] = [];
  readonly said: string[] = [];
  /** Transports the fake's live takes (undefined: the default, webrtc only). */
  transports?: LiveTransport[];
  /** `stop()` returns at once and `live.ended` comes this much later (Codex: after thread/realtime/closed or its fallback). */
  lateEndMs?: number;
  private readonly enders: ((reason: string) => void)[] = [];
  /** The harness side ends every running live on its own (voice closed, harness gone). */
  endFromHarness(reason: string): void {
    for (const e of this.enders) e(reason);
  }
  override async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    const s = (await super.open(args)) as FakeHarnessSession;
    let current: string | undefined;
    const end = (reason: string) => {
      if (!current) return;
      s.queue.push({ ts: Date.now(), level: 'primary', audience: 'status', durability: 'durable', body: { t: 'live.ended', liveId: current, reason } });
      current = undefined;
    };
    this.enders.push(end);
    const transports = this.transports;
    Object.assign(s, {
      live: {
        ...(transports ? { transports } : {}),
        start: async (a: LiveStartArgs) => {
          this.starts.push(a);
          current = a.liveId;
          return { answerSdp: 'ANSWER' };
        },
        say: async (t: string) => void this.said.push(t),
        stop: async () => {
          if (this.lateEndMs === undefined) return end('requested');
          setTimeout(() => end('requested'), this.lateEndMs);
        },
      },
    });
    return s;
  }
}

/** FakeChannel that joins "meetings". */
class MeetingChannel extends FakeChannel {
  /** Offer frames endpoints instead of webrtc. */
  frames = false;
  /** Endpoints report an active speaker (`LiveEndpoint.speaker`): this one. Unset: no speaker capability. */
  speakers?: { now: LiveSpeaker | undefined; asked: number[] };
  readonly endpoints: (LiveEndpoint & { answers: string[]; closes: string[]; hangUp(reason: string): void })[] = [];
  liveRoute(account: string, target: string) {
    return { channel: this.id, account, conversationId: `meeting:${target}` };
  }
  async openLive(account: string, target: string): Promise<LiveEndpoint> {
    if (target === 'busy') throw new Error('MEETING_PARTICIPANT_BUSY');
    if (target.startsWith('slow')) await new Promise((r) => setTimeout(r, 80));
    let hangUp!: (r: string) => void;
    const ended = new Promise<string>((r) => (hangUp = r));
    const ep = {
      id: `p${this.endpoints.length + 1}`,
      title: `meeting ${target}`,
      route: { channel: this.id, account, conversationId: `meeting:${target}` },
      offer: this.frames ? ({ type: 'frames' as const, audio: { encoding: 'pcm16' as const, rate: 24000 } }) : ({ type: 'webrtc' as const, sdp: 'OFFER' }),
      ...(this.frames ? { media: { frames: (async function* (): AsyncGenerator<LiveFrame> {})(), send: () => {} } } : {}),
      answers: [] as string[],
      closes: [] as string[],
      ended,
      hangUp: (r: string) => hangUp(r),
      answer: async (sdp: string) => void ep.answers.push(sdp),
      ...(this.speakers
        ? {
            speaker: (atMs: number) => {
              this.speakers!.asked.push(atMs);
              return this.speakers!.now;
            },
          }
        : {}),
      close: async (reason: string) => {
        ep.closes.push(reason);
        hangUp(reason);
      },
    };
    this.endpoints.push(ep);
    return ep;
  }
}

async function setup(
  script: FakeTurnScript,
  o: { dir?: string; log?: SessionLog; harness?: LiveFakeHarness; chat?: MeetingChannel; policy?: Partial<Policy> } = {},
) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'aio-live-'));
  // The meetings these tests join are preregistered destinations (DL-5: live_join asks Policy.outbound).
  const routes = ['42', '43', '5', '6', '7', '8', '9', 'busy', 'slow1', 'slow2'].map((t) => `fake:default:meeting:${t}`);
  const base = resolveConfig({ policy: { owners: ['fake:alice'], routes }, local: { principal: 'me' }, outputTools: true }, { env: {}, baseDir: dir, cwd: dir });
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock'), blobs: { ...base.blobs, dir: join(dir, 'blobs') } };
  const chat = o.chat ?? new MeetingChannel('fake');
  const harness = o.harness ?? new LiveFakeHarness(script);
  const log = o.log ?? new MemorySessionLog();
  const gw = await Gateway.start({ config, harness, log, channels: [{ adapter: chat }], logger: () => {}, ...(o.policy ? { policy: o.policy } : {}) });
  if (!o.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => gw.stop());
  const c = await LocalClient.connect(config.socketPath);
  cleanups.push(() => c.close());
  const events: SessionEvent[] = [];
  const sub = await c.subscribe({ sessionKey: 'fake:default:c1', tier: 'full', fromSeq: 0 });
  void (async () => {
    for await (const e of sub) events.push(e);
  })();
  return { gw, chat, harness, events, log, dir };
}

describe('live tools (decision 11)', () => {
  it('live_join pairs the channel peer with the harness voice; the far side hanging up ends both; live_say / live_leave #LN-3 #LN-4', async () => {
    const holder: { h?: LiveFakeHarness } = {};
    const results: Record<string, { isError: boolean; text: string }[]> = {};
    const w = await setup(async (t) => {
      const mcp = holder.h!.sessions.at(-1)!.args.mcp;
      const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
      const call = async (name: string, args: Record<string, unknown>) => ((results[text] ??= []).push(await mcpCall(mcp, name, args, `${text}:${name}`)));
      if (text.includes('join')) {
        await call('live_join', { target: '42', instructions: 'speak Chinese' });
        await call('live_join', { target: '43' });
        await call('live_say', { text: 'hello room' });
      } else if (text.includes('busy')) await call('live_join', { target: 'busy' });
      else if (text.includes('leave')) await call('live_leave', {});
    });
    holder.h = w.harness;
    const say = (text: string) => w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text });

    await say('join please');
    const r = await until(() => results['join please']?.length === 3 && results['join please']);
    expect(r[0]!.isError).toBe(false);
    expect(JSON.parse(r[0]!.text)).toMatchObject({ ok: true, title: 'meeting 42', route: 'fake:default:meeting:42' });
    expect(r[1]).toMatchObject({ isError: true });
    expect(r[1]!.text).toMatch(/already in a live \(meeting 42\)/);
    expect(r[2]!.isError).toBe(false);
    expect(w.harness.said).toEqual(['hello room']);
    expect(w.harness.starts).toEqual([
      { liveId: expect.stringMatching(/^live_/), transport: { type: 'webrtc', sdp: 'OFFER' }, instructions: 'speak Chinese', delegationRun: expect.objectContaining({ profile: 'restricted' }) },
    ]);
    const ep = w.chat.endpoints[0]!;
    expect(ep.answers).toEqual(['ANSWER']);
    const started = await until(() => w.events.find((e) => e.body.t === 'live.started'));
    expect(started.body).toMatchObject({ title: 'meeting 42', route: { conversationId: 'meeting:42' }, controlRoute: { conversationId: 'c1' } });

    // The far side ends it: the voice stops (live.ended) and the endpoint is closed once.
    ep.hangUp('left: meeting ended');
    await until(() => w.events.find((e) => e.body.t === 'live.ended'));
    await until(() => ep.closes.length === 1);
    expect(ep.closes).toEqual(['requested']);

    // A failed join leaves nothing behind; live_leave with nothing running says so.
    await say('busy');
    const b = await until(() => results['busy']?.[0]);
    expect(b.isError).toBe(true);
    expect(b.text).toMatch(/MEETING_PARTICIPANT_BUSY/);
    await say('leave');
    const l = await until(() => results['leave']?.[0]);
    expect(JSON.parse(l.text)).toEqual({ ok: true, left: false });
    expect(w.harness.starts).toHaveLength(1);
  });

  it('live_say is traceable: explain by its tool operationId returns the turn #EX-2', async () => {
    const holder: { h?: LiveFakeHarness } = {};
    let said = false;
    const w = await setup(async () => {
      const mcp = holder.h!.sessions.at(-1)!.args.mcp;
      await mcpCall(mcp, 'live_join', { target: '42' }, 'join1');
      await mcpCall(mcp, 'live_say', { text: 'hello room' }, 'say1');
      said = true;
    });
    holder.h = w.harness;
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'join' });
    await until(() => said);
    const turnId = (w.events.find((e) => e.body.t === 'turn.started')!.body as { turnId: string }).turnId;
    expect(w.gw.explain('tool:fake:default:c1:say1')).toMatchObject({ ok: true, value: { turnId, route: { conversationId: 'meeting:42' }, result: 'delivered' } });
    // The log has it too, in the turn that said it.
    const settled = await until(() => w.events.find((e) => e.body.t === 'delivery.settled' && e.body.operationId === 'tool:fake:default:c1:say1'));
    expect(settled.turnId).toBe(turnId);
  });

  it('live_say settles with kind live and its turn while settlements say what they were (an outbound.scoped host declared); before, as it was #DL-7 #EX-2', async () => {
    const holder: { h?: LiveFakeHarness } = {};
    const said: string[] = [];
    const w = await setup(async (t) => {
      const mcp = holder.h!.sessions.at(-1)!.args.mcp;
      const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
      if (text === 'join') await mcpCall(mcp, 'live_join', { target: '42' }, 'join1');
      await mcpCall(mcp, 'live_say', { text: 'hello room' }, `say:${text}`);
      said.push(text);
    });
    holder.h = w.harness;
    const op = (text: string) => w.events.find((e) => e.body.t === 'delivery.settled' && e.body.operationId === `tool:fake:default:c1:say:${text}`);
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'join' });
    const before = await until(() => op('join'));
    expect(before.body).toMatchObject({ result: 'delivered' });
    expect(before.body).not.toHaveProperty('kind');
    // A scoped host whose scope is elsewhere: the live stays, and what it says now says what it was.
    const h = await LocalClient.connect(join(w.dir, 'run', 'aio.sock'));
    cleanups.push(() => h.close());
    await h.hello({ token: w.gw.token, name: 'lb', callouts: ['outbound.scoped'], outboundScope: { routes: [{ channel: 'fake', account: 'default', conversationId: 'elsewhere' }] } } as never);
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'again' });
    const after = await until(() => op('again'));
    expect(after.body).toMatchObject({ result: 'delivered', kind: 'live', turnId: after.turnId });
    expect(w.harness.said).toEqual(['hello room', 'hello room']);
  });

  it('two concurrent live_join: one wins, the other is refused without touching the running live or opening an endpoint #LN-3', async () => {
    const holder: { h?: LiveFakeHarness } = {};
    const results: { isError: boolean; text: string }[] = [];
    const w = await setup(async (t) => {
      const mcp = holder.h!.sessions.at(-1)!.args.mcp;
      const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
      if (text === 'race') results.push(...(await Promise.all([mcpCall(mcp, 'live_join', { target: 'slow1' }, 'r1'), mcpCall(mcp, 'live_join', { target: 'slow2' }, 'r2')])));
    });
    holder.h = w.harness;
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'race' });
    await until(() => results.length === 2);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    const refused = results.find((r) => r.isError)!;
    expect(refused.text).toMatch(/another live_join is in progress|already in a live/);
    // The winner's endpoint is the only one ever opened and it is still up; its voice was never stopped.
    expect(w.chat.endpoints).toHaveLength(1);
    expect(w.chat.endpoints[0]!.closes).toEqual([]);
    expect(w.harness.starts).toHaveLength(1);
    expect(w.events.some((e) => e.body.t === 'live.ended')).toBe(false);
  });

  it('live_leave ends the live; the gateway stopping ends a running one #LN-4 #RS-8', async () => {
    const holder: { h?: LiveFakeHarness } = {};
    const results: { isError: boolean; text: string }[] = [];
    const w = await setup(async (t) => {
      const mcp = holder.h!.sessions.at(-1)!.args.mcp;
      const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
      if (text === 'join') results.push(await mcpCall(mcp, 'live_join', { target: '7' }, `j${results.length}`));
      if (text === 'leave') results.push(await mcpCall(mcp, 'live_leave', {}, `l${results.length}`));
    });
    holder.h = w.harness;
    const say = (text: string) => w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text });
    await say('join');
    await until(() => results.length === 1);
    await say('leave');
    await until(() => results.length === 2);
    expect(JSON.parse(results[1]!.text)).toEqual({ ok: true, left: true });
    expect(w.chat.endpoints[0]!.closes).toEqual(['left by the agent']);
    await until(() => w.events.find((e) => e.body.t === 'live.ended'));

    await say('join');
    await until(() => results.length === 3);
    await w.gw.stop();
    expect(w.chat.endpoints[1]!.closes).toEqual(['gateway stopping']);
  });
});

describe('delegated turns', () => {
  it('a delegated turn (no reply route) sends to "current" = the chat that opened the live; an unidentified speaker does not get the owner\'s reach: elsewhere is refused #LN-6 #DL-5', async () => {
    const holder: { h?: LiveFakeHarness } = {};
    const results: { isError: boolean; text: string }[] = [];
    const w = await setup(async () => {
      results.push(await mcpCall(holder.h!.sessions.at(-1)!.args.mcp, 'live_join', { target: '9' }, 'join'));
    });
    holder.h = w.harness;
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'join' });
    await until(() => results.length === 1);
    const s = w.harness.sessions[0]!;
    const liveId = w.harness.starts[0]!.liveId;
    // What the Codex harness emits for a delegation: the handoff, then the turn it starts.
    const ev = (body: any, turnId?: string) => s.queue.push({ ts: Date.now(), level: 'primary', audience: 'status', durability: 'durable', ...(turnId ? { turnId } : {}), body });
    await until(() => w.events.some((e) => e.body.t === 'turn.completed'));
    ev({ t: 'live.handoff', liveId, inputId: `live:${liveId}:h1`, text: 'send me that as text' });
    ev({ t: 'turn.started', turnId: 'codex:d1', inputIds: [`live:${liveId}:h1`], replyRoute: null, initiator: 'harness' }, 'codex:d1');
    // The fake harness only scripts its own turns: run the tool call as that turn would.
    await until(() => w.events.some((e) => e.body.t === 'turn.started' && e.turnId === 'codex:d1'));
    const mcp = s.args.mcp;
    results.push(await mcpCall(mcp, 'send_message', { route: 'current', text: 'result as text' }, 'delegated-send'));
    // Nobody in the delegated turn is the owner (DL-5): only its own route is open.
    results.push(await mcpCall(mcp, 'send_message', { route: 'fake:default:elsewhere', text: 'leak' }, 'delegated-elsewhere'));
    ev({ t: 'turn.completed', turnId: 'codex:d1', status: 'completed' }, 'codex:d1');
    expect(results[2]!.isError).toBe(true);
    expect(w.chat.sent.some((m) => m.msg.text === 'leak')).toBe(false);
    expect(results[1]!.isError).toBe(false);
    expect(JSON.parse(results[1]!.text)).toMatchObject({ ok: true, delivered: 'fake:default:c1' });
    expect(w.chat.sent.some((m) => m.msg.text === 'result as text' && m.route.conversationId === 'c1')).toBe(true);
  });
});

/** A script whose turns run `calls[text]` (tool name, args) over the session's MCP; results by text. */
function toolTurns(calls: Record<string, [string, Record<string, unknown>]>) {
  const holder: { h?: LiveFakeHarness } = {};
  const results: Record<string, { isError: boolean; text: string }> = {};
  const script: FakeTurnScript = async (t) => {
    const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
    const call = calls[text];
    if (call) results[text] = await mcpCall(holder.h!.sessions.at(-1)!.args.mcp, call[0], call[1], `${text}:${Date.now()}`);
  };
  return { holder, results, script };
}
const from = (chat: FakeChannel, text: string) => chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text });
const KEY = 'fake:default:c1';
const liveIdOf = (e: SessionEvent) => (e.body as { liveId?: string }).liveId;

describe('live: ends, transports and destinations', () => {
  it('the gateway stopping records live.ended in the log; the harness ending first closes the endpoint too #LN-4', async () => {
    const t = toolTurns({ join: ['live_join', { target: '7' }] });
    const w = await setup(t.script);
    t.holder.h = w.harness;
    await from(w.chat, 'join');
    expect((await until(() => t.results['join'])).isError).toBe(false);

    // Harness side first: the voice ends on its own; the gateway closes the channel endpoint.
    w.harness.endFromHarness('voice closed');
    await until(() => w.chat.endpoints[0]!.closes.length === 1);
    expect(w.chat.endpoints[0]!.closes).toEqual(['voice closed']);
    await until(() => w.log.read(KEY, 0).some((e) => e.body.t === 'live.ended'));

    // A second live, then the daemon stops: the endpoint closes and the log has its live.ended.
    delete t.results['join'];
    await from(w.chat, 'join');
    expect((await until(() => t.results['join'])).isError).toBe(false);
    const second = w.harness.starts[1]!.liveId;
    await w.gw.stop();
    expect(w.chat.endpoints[1]!.closes).toEqual(['gateway stopping']);
    expect(w.log.read(KEY, 0).filter((e) => e.body.t === 'live.ended').map(liveIdOf)).toContain(second);
  });

  it('the gateway stopping records live.ended even when the harness reports it late (Codex realtime) #LN-4', async () => {
    const t = toolTurns({ join: ['live_join', { target: '7' }] });
    const harness = new LiveFakeHarness(t.script);
    harness.lateEndMs = 2_000; // after the lane is gone
    const w = await setup(t.script, { harness });
    t.holder.h = w.harness;
    await from(w.chat, 'join');
    expect((await until(() => t.results['join'])).isError).toBe(false);
    const liveId = w.harness.starts[0]!.liveId;
    await w.gw.stop();
    expect(w.chat.endpoints[0]!.closes).toEqual(['gateway stopping']);
    expect(w.log.read(KEY, 0).filter((e) => e.body.t === 'live.ended').map(liveIdOf)).toEqual([liveId]);
  });

  it('a live does not survive a restart: no live after it, live_say says there is none, and the log ended it #RS-7', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-live-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const t = toolTurns({ join: ['live_join', { target: '8' }], say: ['live_say', { text: 'still there?' }] });
    const w = await setup(t.script, { dir, log: new SqliteSessionLog({ path: join(dir, 'log.sqlite') }) });
    t.holder.h = w.harness;
    await from(w.chat, 'join');
    expect((await until(() => t.results['join'])).isError).toBe(false);
    const liveId = w.harness.starts[0]!.liveId;
    await w.gw.stop();

    const log2 = new SqliteSessionLog({ path: join(dir, 'log.sqlite') });
    const harness2 = new LiveFakeHarness(t.script);
    t.holder.h = harness2;
    const w2 = await setup(t.script, { dir, log: log2, harness: harness2 });
    expect(log2.read(KEY, 0).some((e) => e.body.t === 'live.ended' && liveIdOf(e) === liveId)).toBe(true);
    expect(JSON.stringify(log2.snapshot(KEY))).not.toContain(liveId);
    await from(w2.chat, 'say');
    const r = await until(() => t.results['say']);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no live is running/);
    expect(harness2.said).toEqual([]);
    expect(harness2.starts).toEqual([]);
  });

  it('a frames endpoint for a harness whose live takes webrtc only: refused before start, naming the transport; the endpoint is closed and no live is registered #LN-5', async () => {
    const t = toolTurns({ join: ['live_join', { target: '5' }], say: ['live_say', { text: 'hi' }], again: ['live_join', { target: '6' }] });
    const harness = new LiveFakeHarness(t.script);
    harness.transports = ['webrtc'];
    const chat = new MeetingChannel('fake');
    chat.frames = true;
    const w = await setup(t.script, { harness, chat });
    t.holder.h = harness;
    await from(chat, 'join');
    const r = await until(() => t.results['join']);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/does not take the frames transport/);
    expect(r.text).toMatch(/webrtc/);
    expect(harness.starts).toEqual([]);
    expect(chat.endpoints[0]!.closes).toHaveLength(1);
    expect(chat.endpoints[0]!.closes[0]).toMatch(/^join failed: .*frames/);
    expect(w.events.some((e) => e.body.t === 'live.started')).toBe(false);
    // Nothing registered: live_say has no live, and another join is not "already in a live".
    await from(chat, 'say');
    expect((await until(() => t.results['say'])).text).toMatch(/no live is running/);
    await from(chat, 'again');
    const again = await until(() => t.results['again']);
    expect(again.text).not.toMatch(/already in a live|in progress/);
    expect(chat.endpoints).toHaveLength(2);
  });

  it('live_join from an owner turn (bypass) reaches a meeting that is not preregistered; a channel that cannot name the route first has its endpoint closed when the check denies #DL-5', async () => {
    const t = toolTurns({ join: ['live_join', { target: '99' }] });
    const w = await setup(t.script);
    t.holder.h = w.harness;
    await from(w.chat, 'join');
    const r = await until(() => t.results['join']);
    expect(r.isError).toBe(false);
    expect(w.chat.endpoints).toHaveLength(1);

    const chat = new MeetingChannel('fake');
    (chat as { liveRoute?: unknown }).liveRoute = undefined;
    const t2 = toolTurns({ join: ['live_join', { target: '99' }] });
    const w2 = await setup(t2.script, { chat, policy: { outbound: async () => 'deny' } });
    t2.holder.h = w2.harness;
    await from(w2.chat, 'join');
    expect((await until(() => t2.results['join'])).isError).toBe(true);
    expect(chat.endpoints).toHaveLength(1);
    expect(chat.endpoints[0]!.closes).toEqual(['not an allowed destination']);
    expect(w2.harness.starts).toHaveLength(0);
  });

  it('live_join goes through the outbound check: a policy that denies every destination refuses it, no endpoint is opened #DL-5', async () => {
    const t = toolTurns({ join: ['live_join', { target: '42' }] });
    const w = await setup(t.script, { policy: { outbound: async () => 'deny' } });
    t.holder.h = w.harness;
    await from(w.chat, 'join');
    const r = await until(() => t.results['join']);
    expect(w.chat.endpoints).toHaveLength(0);
    expect(r.isError).toBe(true);
  });
});

describe("delegated turns: the profile follows the speaker (decision 11 amendment)", () => {
  /** Join a live from alice's chat, then delegate as the fake Codex would. */
  async function meeting(speakers?: MeetingChannel['speakers']) {
    const t = toolTurns({ join: ['live_join', { target: '9' }] });
    const chat = new MeetingChannel('fake');
    if (speakers) chat.speakers = speakers;
    const w = await setup(t.script, { chat });
    t.holder.h = w.harness;
    await from(chat, 'join');
    expect((await until(() => t.results['join'])).isError).toBe(false);
    await until(() => w.events.some((e) => e.body.t === 'turn.completed'));
    const s = w.harness.sessions[0]!;
    const liveId = w.harness.starts[0]!.liveId;
    const ev = (body: any, turnId?: string) => s.queue.push({ ts: Date.now(), level: 'primary', audience: 'status', durability: 'durable', ...(turnId ? { turnId } : {}), body });
    let n = 0;
    const delegate = async (text: string) => {
      const turnId = `codex:d${++n}`;
      const inputId = `live:${liveId}:h${n}`;
      ev({ t: 'live.handoff', liveId, inputId, text });
      ev({ t: 'turn.started', turnId, inputIds: [inputId], replyRoute: null, initiator: 'harness' }, turnId);
      const started = await until(() => w.events.find((e) => e.body.t === 'turn.started' && e.turnId === turnId));
      const admitted = w.events.find((e) => e.body.t === 'input.admitted' && e.body.inputId === inputId)!;
      return { turnId, run: (started.body as { run?: { profile: string } }).run, origin: (admitted.body as { input: { origin: unknown } }).input.origin };
    };
    const ask = (turnId: string, requestId: string) =>
      ev({ t: 'request.opened', requestId, kind: 'tool_approval', title: 'rm -rf build', risk: {}, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true }, turnId);
    const resolved = (requestId: string) => until(() => w.events.find((e) => e.body.t === 'request.resolved' && e.body.requestId === requestId));
    return { ...w, chat, ev, delegate, ask, resolved };
  }

  it('the channel names the owner as the speaker: owner origin through the identity path, bypass, requests allowed #LN-7 #ID-4', async () => {
    const speakers = { now: { channelUserId: 'alice', evidence: 'platform_signed' as const, displayName: 'Alice' }, asked: [] as number[] };
    const w = await meeting(speakers);
    const d = await w.delegate('run the tests');
    expect(speakers.asked).toHaveLength(1);
    expect(d.origin).toMatchObject({ kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:meeting:9' });
    expect(d.run).toMatchObject({ profile: 'bypass' });
    w.ask(d.turnId, 'r1');
    expect((await w.resolved('r1')).body).toMatchObject({ decision: { kind: 'allow_once' }, by: { kind: 'auto' } });

    // The same member without platform evidence is not the owner (ID-4): restricted, asked of the starter.
    speakers.now = { channelUserId: 'alice', evidence: 'none' as never, displayName: 'Alice' };
    w.ev({ t: 'turn.completed', turnId: d.turnId, status: 'completed' }, d.turnId);
    await until(() => w.events.some((e) => e.body.t === 'turn.completed' && e.body.turnId === d.turnId));
    const d2 = await w.delegate('again');
    expect(d2.origin).toMatchObject({ principal: null, evidence: 'none' });
    expect(d2.run).toMatchObject({ profile: 'restricted' });
  });

  it("no speaker from the channel: restricted; the request's card with buttons appears in the chat that started the live, a stranger's click is refused, the owner's click answers it #LN-7 #RQ-1 #RQ-5", async () => {
    const w = await meeting();
    const started = await until(() => w.events.find((e) => e.body.t === 'live.started'));
    expect(started.body).toMatchObject({ startedBy: 'fake:alice', controlRoute: { conversationId: 'c1' } });
    const d = await w.delegate('删掉 build 目录');
    expect(d.origin).toMatchObject({ principal: null, evidence: 'none' });
    expect(d.run).toMatchObject({ profile: 'restricted' });
    w.ask(d.turnId, 'r1');
    const opened = await until(() => w.events.find((e) => e.body.t === 'request.opened' && e.body.requestId === 'r1'));
    expect(opened.body).toMatchObject({ resolver: { kind: 'human', principals: ['fake:alice'], routes: ['fake:default:c1'] } });
    const card = await until(() =>
      w.chat.sent.find((m) => m.op.operationId.includes(`:${d.turnId}:`) && m.route.conversationId === 'c1' && (m.edits.at(-1) ?? m.msg).actions?.some((a) => a.label === 'Allow')),
    );
    const actions = (card.edits.at(-1) ?? card.msg).actions!;
    const allow = actions.find((a) => a.label === 'Allow')!;
    const click = (channelUserId: string) =>
      w.chat.inject({ sender: { channelUserId, evidence: 'platform_signed' }, content: [{ type: 'event', name: 'action', data: { actionId: allow.id, messageId: card.providerMessageId } }] });
    await click('eve');
    await new Promise((r) => setTimeout(r, 50));
    expect(w.events.some((e) => e.body.t === 'request.resolved' && e.body.requestId === 'r1')).toBe(false);
    await click('alice');
    expect((await w.resolved('r1')).body).toMatchObject({ decision: { kind: 'allow_once' }, by: { kind: 'human', id: 'fake:alice' } });
  });

  it('a speaker the channel names who is not the owner: restricted, the request goes to the starter #LN-7', async () => {
    const w = await meeting({ now: { channelUserId: 'bob', evidence: 'platform_signed' }, asked: [] });
    const d = await w.delegate('x');
    expect(d.origin).toMatchObject({ kind: 'human', principal: null, evidence: 'platform_signed' });
    expect(d.run).toMatchObject({ profile: 'restricted' });
    w.ask(d.turnId, 'r1');
    const opened = await until(() => w.events.find((e) => e.body.t === 'request.opened' && e.body.requestId === 'r1'));
    expect(opened.body).toMatchObject({ resolver: { kind: 'human', principals: ['fake:alice'] } });
    expect(w.events.some((e) => e.body.t === 'request.resolved' && e.body.requestId === 'r1')).toBe(false);
  });
});
