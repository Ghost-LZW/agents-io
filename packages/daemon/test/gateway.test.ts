import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrameDecoder, encodeFrame, type Policy, type SessionEvent } from '@agents-io/protocol';
import { MemorySessionLog, SqliteSessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness, assertConformingStream } from '@agents-io/testkit';
import { CommandError, LocalClient } from '../src/client.js';
import { resolveConfig, type HarnessInstance } from '../src/config.js';
import { Gateway, InstanceHarness, buildHarness as buildRealHarness } from '../src/gateway.js';
import { cleanups, setup, until } from './gateway-helpers.js';
import { daemon, until as untilD } from './helpers.js';

const of = (evs: SessionEvent[], t: string) => evs.filter((e) => e.body.t === t).map((e) => e.body as never as Record<string, unknown>);

describe('gateway wiring', () => {
  it('channel input → ingress → lane → harness → compositor card back on the route; local subscriber sees the stream #DL-3', async () => {
    const w = await setup();
    const c = await w.client();
    const events = await w.collect(c, 'fake:default:c1');
    const r = await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    expect(r.accepted).toBe(true);
    const card = await until(() => w.chat.sent.find((s) => s.finalized));
    expect(card.edits.at(-1)?.text ?? card.msg.text).toBe('echo: hi');
    await until(() => of(events, 'turn.completed').length === 1);
    expect(of(events, 'turn.started')[0]).toMatchObject({ owner: 'fake:alice', run: { profile: 'bypass' } });
    assertConformingStream(events.filter((e) => e.durability === 'durable'));
    const sessions = await c.sessions();
    expect(sessions).toEqual([expect.objectContaining({ sessionKey: 'fake:default:c1', state: 'idle', live: true })]);
    // Unknown DM senders are dropped by the default policy.
    await w.chat.inject({ sender: { channelUserId: 'eve', evidence: 'platform_signed' }, text: 'hi' });
    expect(w.harness.sessions[0]!.args.run.harness).toBe('claude-code');
  });

  it('two local ends on one session: both see every event and both can talk #LN-1 #IN-3', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const w = await setup({
      script: async (t) => {
        const text = t.inputs.flatMap((i) => i.content).map((x) => (x.type === 'text' ? x.text : '')).join('+');
        if (text === 'first') await hold;
        t.emit({ t: 'text.snapshot', text: `echo: ${text}`, final: true }, { audience: 'answer' });
      },
    });
    const a = await w.client();
    const b = await w.client();
    const ea = await w.collect(a, 'me-session');
    const eb = await w.collect(b, 'me-session', 'final');
    expect(await a.input('me-session', 'first')).toMatchObject({ disposition: 'new_turn' });
    expect(await b.input('me-session', 'second')).toMatchObject({ disposition: 'queued' });
    expect(await a.input('me-session', 'third')).toMatchObject({ disposition: 'queued' });
    release();
    await until(() => of(ea, 'turn.completed').length === 2);
    // Same principal and route from both terminals: the two queued inputs batch into one turn.
    expect(of(ea, 'turn.started').map((s) => (s.inputIds as string[]).length)).toEqual([1, 2]);
    expect(of(ea, 'text.snapshot').map((s) => s.text)).toEqual(['echo: first', 'echo: second+third']);
    await until(() => of(eb, 'turn.completed').length === 2);
    expect(of(eb, 'text.snapshot').map((s) => s.text)).toEqual(['echo: first', 'echo: second+third']);
    expect(of(ea, 'input.admitted').every((x) => x.principalId === 'me')).toBe(true);
  });

  it('human approval reaches a second subscriber at final tier and is resolved through it #RQ-5', async () => {
    const w = await setup({
      script: async (t) => {
        t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'rm -rf build', risk: { writes: true }, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
        const d = await t.waitDecision('r1');
        t.emit({ t: 'text.snapshot', text: `got ${d.kind}`, final: true }, { audience: 'answer' });
      },
      policy: { resolve: async () => ({ kind: 'human', principals: ['me'], routes: [] }) },
    });
    const a = await w.client();
    const b = await w.client();
    const ea = await w.collect(a, 's');
    const eb = await w.collect(b, 's', 'final');
    await a.input('s', 'go');
    const opened = await until(() => of(eb, 'request.opened')[0]);
    expect(opened).toMatchObject({ requestId: 'r1', resolver: { kind: 'human' } });
    await expect(b.command({ type: 'resolve', sessionKey: 's', requestId: 'nope', decision: { kind: 'allow_once' } })).rejects.toThrow(CommandError);
    await b.command({ type: 'resolve', sessionKey: 's', requestId: 'r1', decision: { kind: 'allow_once' } });
    await until(() => of(ea, 'turn.completed').length === 1);
    expect(of(ea, 'request.resolved')[0]).toMatchObject({ by: { kind: 'human', id: 'me' } });
    expect(of(ea, 'text.snapshot').at(-1)).toMatchObject({ text: 'got allow_once' });
  });

  it('interrupt from a local end ends the turn interrupted #CT-1', async () => {
    const w = await setup({ script: (t) => new Promise((_, rej) => t.signal.addEventListener('abort', () => rej(new Error('stop')))) });
    const c = await w.client();
    const ev = await w.collect(c, 's');
    await c.input('s', 'long');
    await until(() => of(ev, 'turn.started').length === 1);
    await c.command({ type: 'interrupt', sessionKey: 's' });
    await until(() => of(ev, 'turn.completed')[0]);
    expect(of(ev, 'turn.completed')[0]).toMatchObject({ status: 'interrupted' });
    await expect(c.command({ type: 'interrupt', sessionKey: 's' })).rejects.toMatchObject({ code: 'no_active_turn' });
  });

  it('reconnecting with fromSeq replays exactly what was missed #LN-1', async () => {
    const w = await setup();
    const c1 = await w.client();
    await c1.input('s', 'one');
    await until(() => w.gw.sessions()[0]?.state === 'idle' && w.gw.hub.log.head('s') > 3);
    const head = w.gw.hub.log.head('s');
    await c1.input('s', 'two');
    await until(() => w.gw.hub.log.read('s', 0).filter((e) => e.body.t === 'turn.completed').length === 2);
    const c2 = await w.client();
    const ev = await (async () => {
      const out: SessionEvent[] = [];
      const sub = await c2.subscribe({ sessionKey: 's', tier: 'full', fromSeq: head });
      void (async () => {
        for await (const e of sub) out.push(e);
      })();
      return out;
    })();
    await until(() => ev.some((e) => e.body.t === 'turn.completed'));
    await new Promise((r) => setTimeout(r, 20));
    expect(ev.map((e) => e.seq)).toEqual(w.gw.hub.log.read('s', head).map((e) => e.seq));
  });

  it('socket is private, rejects bad frames, and tells subscribers when the gateway stops #RS-8 #SE-2', async () => {
    const w = await setup();
    expect(statSync(w.config.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(w.dir, 'run')).mode & 0o777).toBe(0o700);
    const raw = createConnection(w.config.socketPath);
    const dec = new FrameDecoder();
    const got: unknown[] = [];
    raw.on('data', (d) => got.push(...dec.push(d)));
    await new Promise((r) => raw.once('connect', r));
    raw.write('not json\n');
    raw.write(encodeFrame({ v: 1, type: 'command', id: 'x1', command: { type: 'input', sessionKey: 's' } }));
    raw.write(encodeFrame({ v: 1, type: 'command', id: 'x2', command: { type: 'subscribe', sessionKey: 's', tier: 'full', fromSeq: 0 } }));
    await until(() => got.length >= 3);
    expect(got[0]).toMatchObject({ type: 'result', ok: false, error: { code: 'bad_json' } });
    expect(got[1]).toMatchObject({ type: 'result', id: 'x1', ok: false, error: { code: 'invalid_frame' } });
    expect(got[2]).toMatchObject({ type: 'result', id: 'x2', ok: true, value: { head: 0 } });
    await w.gw.stop();
    await until(() => got.some((f) => (f as { type: string }).type === 'closed'));
    raw.destroy();
  });

  it('a turn started from the local terminal sends nothing to a channel, even in the session an owner DM shares #DL-3', async () => {
    const w = await daemon({ raw: { policy: { owners: ['fake:alice'], ownerSessionKey: 'main' } } });
    const done = () => w.gw.hub.log.read('main', 0).filter((e) => e.body.t === 'turn.completed').length;
    // A channel turn in the shared session: its answer goes back to the DM.
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'from the DM' });
    await untilD(() => done() === 1 && w.chat.sent.some((s) => s.finalized));
    const before = JSON.stringify(w.chat.sent);
    // The terminal (local client) starts the next turn in the same session.
    const c = await w.client();
    await c.input('main', 'from the terminal');
    await untilD(() => done() === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.gw.hub.log.read('main', 0).filter((e) => e.body.t === 'turn.started').map((e) => (e.body as { replyRoute: { channel: string } | null }).replyRoute?.channel)).toEqual(['fake', 'local']);
    expect(JSON.stringify(w.chat.sent)).toBe(before);
  });
});

describe('named harness instances', () => {
  it('lanes open the instance the plan names (its cwd, options, id); a restart resumes per instance #RS-1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-gwi-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const config = resolveConfig(
      {
        harnesses: {
          a: { use: 'claude-code', cwd: 'wa', profiles: { bypass: { permissionMode: 'bypassPermissions' } }, options: { forwardSubagentText: true } },
          b: { use: 'codex', run: { model: 'gpt-b' } },
        },
        defaultHarness: 'a',
        policy: { owners: ['fake:alice'] },
        local: { principal: 'me' },
      },
      { env: {}, baseDir: dir, cwd: dir },
    );
    const built = new Map<string, FakeHarness>();
    const buildHarness = (i: HarnessInstance) => {
      const inner = new FakeHarness(async (t) => {
        t.emit({ t: 'session.bound', nativeId: `native-${i.name}` });
        t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
      }, `inner-${i.name}`);
      built.set(i.name, inner);
      return new InstanceHarness(i, inner);
    };
    let use = 'a';
    const policy: Partial<Policy> = { plan: async () => ({ ...config.harnesses[use]!.run, profile: 'bypass' }) };
    const start = async (log: MemorySessionLog | SqliteSessionLog) =>
      Gateway.start({ config: { ...config, socketPath: join(dir, 'run', 'aio.sock') }, buildHarness, policy, log, channels: [{ adapter: new FakeChannel('fake') }], logger: () => {} });
    const log = new SqliteSessionLog({ path: join(dir, 'log.sqlite') });
    const gw = await start(log);
    const c = await LocalClient.connect(join(dir, 'run', 'aio.sock'));
    const send = async (text: string) => {
      const n = gw.hub.log.read('s', 0).filter((e) => e.body.t === 'turn.completed').length;
      await c.input('s', text);
      await until(() => gw.hub.log.read('s', 0).filter((e) => e.body.t === 'turn.completed').length > n);
    };
    await send('one');
    expect([...built.keys()]).toEqual(['a']); // lazily: b is not built until a turn names it
    const sa = built.get('a')!.sessions[0]!;
    expect(sa.args).toMatchObject({ cwd: join(dir, 'wa'), run: { harness: 'a', model: 'haiku' }, options: { forwardSubagentText: true, profiles: { bypass: { permissionMode: 'bypassPermissions' } } } });
    use = 'b';
    await send('two');
    const sb = built.get('b')!.sessions[0]!;
    expect(sb.args).toMatchObject({ cwd: config.cwd, run: { harness: 'b', model: 'gpt-b' } });
    expect(sb.args.resume).toBeUndefined();
    const evs = gw.hub.log.read('s', 0);
    expect(evs.filter((e) => e.body.t === 'turn.completed').map((e) => e.harness)).toEqual(['a', 'b']);
    expect(evs.filter((e) => e.body.t === 'session.bound').map((e) => e.harness)).toEqual(['a', 'b']);
    c.close();
    await gw.stop();

    // Restart: a turn on `a` resumes a's native id, not b's.
    built.clear();
    use = 'a';
    const gw2 = await start(new SqliteSessionLog({ path: join(dir, 'log.sqlite') }));
    cleanups.push(() => gw2.stop());
    const c2 = await LocalClient.connect(join(dir, 'run', 'aio.sock'));
    cleanups.push(() => c2.close());
    await c2.input('s', 'three');
    await until(() => built.get('a')?.sessions[0]);
    expect(built.get('a')!.sessions[0]!.args.resume).toBe('native-a');
    expect(gw2.harness('b').id).toBe('b');
    expect(() => buildRealHarness({ ...config.harnesses.a!, unavailable: 'harnesses.a.env.K: environment variable K is not set' })).toThrow('harness instance a is unavailable: harnesses.a.env.K: environment variable K is not set');
    expect(() => gw2.harness('zzz')).toThrow(/unknown harness instance "zzz" \(configured: a, b\)/);
  });
});

describe('persistence', () => {
  it('Gateway.start with a MemorySessionLog logs a "not persistent" warning #RS-9', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-gwm-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const config = { ...resolveConfig({ local: { principal: 'me' } }, { env: {}, baseDir: dir, cwd: dir }), socketPath: join(dir, 'run', 'aio.sock') };
    const logs: { level: string; msg: string }[] = [];
    const gw = await Gateway.start({ config, harness: new FakeHarness(), log: new MemorySessionLog(), channels: [], logger: (level, msg) => void logs.push({ level, msg }) });
    cleanups.push(() => gw.stop());
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', msg: expect.stringMatching(/not persistent|in memory/i) }));
  });
});
