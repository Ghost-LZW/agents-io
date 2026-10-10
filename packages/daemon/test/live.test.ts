import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessOpenArgs, HarnessSession, LiveEndpoint, LiveFrame, LiveStartArgs, LiveTransport, Policy, SessionEvent } from '@agents-io/protocol';
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
        stop: async () => end('requested'),
      },
    });
    return s;
  }
}

/** FakeChannel that joins "meetings". */
class MeetingChannel extends FakeChannel {
  /** Offer frames endpoints instead of webrtc. */
  frames = false;
  readonly endpoints: (LiveEndpoint & { answers: string[]; closes: string[]; hangUp(reason: string): void })[] = [];
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
  const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, outputTools: true }, { env: {}, baseDir: dir, cwd: dir });
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
    expect(w.harness.starts).toEqual([{ liveId: expect.stringMatching(/^live_/), transport: { type: 'webrtc', sdp: 'OFFER' }, instructions: 'speak Chinese' }]);
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

  // INVARIANTS EX-2 不成立 1: live_say goes through no outbox and leaves no record (no operationId, nothing in the log); turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('live_say is traceable: explain by its tool operationId returns the turn #EX-2', async () => {
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
    expect(w.gw.explain('tool:fake:default:c1:say1')).toMatchObject({ ok: true, value: { turnId } });
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
  it('a delegated turn (no reply route) sends to "current" = the chat that opened the live #LN-6', async () => {
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
    ev({ t: 'turn.completed', turnId: 'codex:d1', status: 'completed' }, 'codex:d1');
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

  // INVARIANTS LN-4 不成立（可能）: Codex sends live.ended only after thread/realtime/closed or a 5 s
  // fallback, past leaveLive's 5 s bound; the fake harness cannot reproduce that timing, so no it.fails yet.
  it.todo('the gateway stopping records live.ended even when the harness reports it late (Codex realtime) #LN-4');

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

  // INVARIANTS DL-5 不成立 2: live_join's target (gateway.ts joinLive) never goes through Policy.outbound; turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('live_join goes through the outbound check: a policy that denies every destination refuses it, no endpoint is opened #DL-5', async () => {
    const t = toolTurns({ join: ['live_join', { target: '42' }] });
    const w = await setup(t.script, { policy: { outbound: async () => 'deny' } });
    t.holder.h = w.harness;
    await from(w.chat, 'join');
    const r = await until(() => t.results['join']);
    expect(w.chat.endpoints).toHaveLength(0);
    expect(r.isError).toBe(true);
  });
});
