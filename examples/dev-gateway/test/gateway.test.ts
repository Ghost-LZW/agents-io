import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { FrameDecoder, encodeFrame, type Policy, type SessionEvent } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness, assertConformingStream, type FakeTurnScript } from '@agents-io/testkit';
import { runAttach } from '../src/attach.js';
import { CommandError, LocalClient } from '../src/client.js';
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

async function setup(o: { script?: FakeTurnScript; policy?: Partial<Policy> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-gw-'));
  const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me' } }, { env: {}, baseDir: dir, cwd: dir });
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  const harness = new FakeHarness(o.script);
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], ...(o.policy ? { policy: o.policy } : {}), logger: () => {} });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => gw.stop());
  const client = async () => {
    const c = await LocalClient.connect(config.socketPath);
    cleanups.push(() => c.close());
    return c;
  };
  const collect = async (c: LocalClient, sessionKey: string, tier: 'full' | 'final' = 'full') => {
    const events: SessionEvent[] = [];
    const sub = await c.subscribe({ sessionKey, tier, fromSeq: 0 });
    void (async () => {
      for await (const e of sub) events.push(e);
    })();
    return events;
  };
  return { gw, chat, harness, config, client, collect, dir };
}

const of = (evs: SessionEvent[], t: string) => evs.filter((e) => e.body.t === t).map((e) => e.body as never as Record<string, unknown>);

describe('gateway wiring', () => {
  it('channel input → ingress → lane → harness → compositor card back on the route; local subscriber sees the stream', async () => {
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

  it('two local ends on one session: both see every event and both can talk', async () => {
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

  it('human approval reaches a second subscriber at final tier and is resolved through it', async () => {
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

  it('interrupt from a local end ends the turn interrupted', async () => {
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

  it('reconnecting with fromSeq replays exactly what was missed', async () => {
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

  it('socket is private, rejects bad frames, and tells subscribers when the gateway stops', async () => {
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

  it('attach end: prints the stream and turns lines into commands', async () => {
    const w = await setup();
    const c = await w.client();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (d) => (text += d.toString()));
    const done = runAttach({ client: c, sessionKey: 's', tier: 'full', input, output, color: false });
    await until(() => text.includes('attached to s'));
    input.write('hello\n');
    await until(() => text.includes('turn') && text.includes('completed'));
    input.write('/bogus\n');
    input.write('/sessions\n');
    await until(() => text.includes('* s  idle'));
    input.write('/quit\n');
    await done;
    expect(text).toContain('echo: hello');
    expect(text).toContain('(input: new_turn)');
    expect(text).toContain('unknown command /bogus');
  });
});
