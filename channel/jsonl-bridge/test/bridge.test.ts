import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChannel, runChannelConformance } from '@agents-io/testkit';
import { ChannelBridgeError, serveChannel, spawnChannel } from '../src/index.js';
import { closeAll, fakeChild, pidLog, rawChild, route, run, waitFor } from './bridge-helpers.js';

afterEach(closeAll);

describe('serveChannel <-> spawnChannel', () => {
  it('performs hello and exposes only declared methods #CN-1', async () => {
    const ch = await fakeChild();
    expect(ch.id).toBe('fake-child');
    expect(ch.caps('default').edit).toBe(true);
    expect(ch.edit && ch.finalize).toBeTruthy();
    expect(ch.speak).toBeUndefined();
    expect(ch.typing).toBeUndefined();
    expect(ch.reconcile).toBeUndefined();
  });

  it('passes channel conformance #CN-1', async () => {
    const ch = await fakeChild({ INJECT: '1' });
    const report = await runChannelConformance({ adapter: ch, account: 'default', triggerInbound: async () => {}, route });
    expect(report.failed).toEqual([]);
    expect(report.passed).toEqual(expect.arrayContaining(['inbound.emit', 'inbound.schema', 'outbound.idempotent', 'outbound.edit']));
  });

  it('holds inbound frames sent before start until a context exists #CN-1', async () => {
    const ch = await fakeChild({ INJECT: '2' });
    await new Promise((r) => setTimeout(r, 200)); // child has already emitted
    const r = run(ch);
    await r.until(() => r.inbound.length === 2);
    await r.stop();
  });
});

describe('robustness', () => {
  it('drops malformed, unknown and invalid frames without crashing #PR-2', async () => {
    const early: string[] = [];
    const ch = await rawChild('noisy', { log: (l: string, m: string) => early.push(`${l}: ${m}`) });
    const r = run(ch);
    r.logs.push(...early);
    await r.until(() => r.inbound.length === 1);
    expect(r.inbound[0]?.id).toBe('ok-1');
    expect(await ch.send(route, { text: 'still alive' }, { operationId: 'o' })).toEqual({ providerMessageId: 'raw-1' });
    await r.until(() => r.logs.some((l) => l.includes('got-result bad ok=false code=invalid_frame')));
    expect(r.logs.some((l) => l.startsWith('warn: dropping malformed line'))).toBe(true);
    expect(r.logs.some((l) => l.includes('dropping invalid inbound frame'))).toBe(true);
    await r.stop();
  });

  it('serveChannel answers invalid host frames and ignores garbage #PR-2', async () => {
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: any[] = [];
    output.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l: string) => lines.push(JSON.parse(l))));
    const served = serveChannel(new FakeChannel('x'), { input, output });
    input.write('garbage\n{"v":1,"type":"send","id":"s1"}\n{"v":1,"type":"future","id":"f"}\n');
    input.write('{"v":1,"type":"shutdown"}\n');
    await served;
    expect(lines.find((l) => l.id === 's1')).toMatchObject({ ok: false, error: { code: 'invalid_frame' } });
    expect(lines.find((l) => l.id === 'f')).toBeUndefined();
  });

  it('rejects pending requests retryably when the child dies #DL-1', async () => {
    const ch = await rawChild('die');
    const err = await ch.send(route, { text: 'x' }, { operationId: 'o' }).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelBridgeError);
    expect(err).toMatchObject({ code: 'peer_closed', retryable: true });
    // With the child gone and no start loop, requests fail fast and retryably.
    await expect(ch.send(route, { text: 'y' }, { operationId: 'p' })).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('times out unanswered requests with a retryable error #DL-1', async () => {
    const ch = await rawChild('mute', { requestTimeoutMs: 100 });
    const t0 = Date.now();
    await expect(ch.send(route, { text: 'x' }, { operationId: 'o' })).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('fails spawnChannel when the command does not exist or never says hello #CF-1', async () => {
    await expect(spawnChannel({ command: '/nonexistent/adapter', account: 'a' })).rejects.toThrow();
    await expect(
      spawnChannel({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], account: 'a', helloTimeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('retryFirstConnect', () => {
  it('opens disconnected when the first hello fails, then connects with backoff once started #CF-1', async () => {
    const gate = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'gate');
    const states: { connected: boolean; error?: string }[] = [];
    const ch = await rawChild('gated', { retryFirstConnect: true, id: 'expected', backoff: { minMs: 20, maxMs: 40 }, onState: (s: { connected: boolean; error?: string }) => states.push(s) }, { GATE_FILE: gate });
    expect(ch.state().connected).toBe(false);
    expect(ch.state().error).toMatch(/exited|peer_closed|closed/);
    expect(states.at(-1)).toMatchObject({ connected: false });
    expect(ch.id).toBe('expected');
    expect(ch.caps().defaultTier).toBe('final');
    expect(ch.edit).toBeUndefined();
    await expect(ch.send(route, { text: 'x' } as never, { operationId: 'o1' } as never)).rejects.toMatchObject({ code: 'unavailable', retryable: true });
    const r = run(ch);
    // Still failing while the gate is closed: retried, not given up.
    await waitFor(() => r.logs.filter((l) => l.includes('channel connect failed')).length >= 2);
    expect(ch.state().connected).toBe(false);
    writeFileSync(gate, 'open');
    await waitFor(() => ch.state().connected);
    expect(ch.id).toBe('raw');
    expect(ch.state().error).toBeUndefined();
    expect(states.at(-1)).toEqual({ connected: true });
    await r.stop();
  });

  it('a command that cannot be run still rejects open (a config error, not a peer that is not up yet) #CF-1', async () => {
    await expect(spawnChannel({ command: join(tmpdir(), 'no-such-channel-binary'), account: 'default', retryFirstConnect: true })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('without it, a failed first hello still rejects open #CF-1', async () => {
    const gate = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'gate');
    await expect(rawChild('gated', {}, { GATE_FILE: gate })).rejects.toThrow();
  });

  it('reports a peer that goes away later #CF-1', async () => {
    const states: { connected: boolean; error?: string }[] = [];
    const ch = await rawChild('flap', { retryFirstConnect: true, backoff: { minMs: 500, maxMs: 1000 }, onState: (s: { connected: boolean; error?: string }) => states.push(s) });
    expect(states[0]).toEqual({ connected: true });
    const r = run(ch);
    await waitFor(() => states.some((s) => !s.connected));
    expect(ch.state()).toMatchObject({ connected: false, error: expect.stringMatching(/exited/) });
    await r.stop();
  });
});

describe('compatibility', () => {
  it('ignores optional methods it does not know in hello #PR-1', async () => {
    const ch = await rawChild('newer');
    expect(ch.edit).toBeTypeOf('function');
    expect((ch as unknown as Record<string, unknown>).react).toBeUndefined();
    await ch.edit!(route, 'm1', { text: 'x' }, { operationId: 'o', sequence: 1 });
  });

  it('fails a request at once, non-retryably, when its result frame is malformed #DL-1', async () => {
    const ch = await rawChild('badresult', { requestTimeoutMs: 5000 });
    const t0 = Date.now();
    const err = await ch.send(route, { text: 'x' }, { operationId: 'o' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'bad_result', retryable: false });
    expect(err.message).toContain('not found');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('FrameLink', () => {
  it('refuses to buffer without limit when the peer stops reading #PR-2', async () => {
    const { PassThrough, Writable } = await import('node:stream');
    const { FrameLink } = await import('../src/link.js');
    const stuck = new Writable({ write() {} }); // never calls back: a wedged reader
    const link = new FrameLink(new PassThrough(), stuck, () => {}, () => {}, () => {}, { maxBufferedBytes: 1000 });
    const frame = { v: 1, type: 'log', level: 'info', msg: 'x'.repeat(100) };
    let sent = 0;
    while (link.send(frame) && sent < 1000) sent++;
    expect(sent).toBeLessThan(20);
    expect(stuck.writableLength).toBeLessThan(2000);
  });
});

describe('channel id pinning (channel-stamping)', () => {
  it('expectId: a hello declaring another id is bad_hello; with retryFirstConnect the peer is restarted and stays refused #ID-3', async () => {
    await expect(rawChild('', { expectId: 'other' })).rejects.toMatchObject({ code: 'bad_hello', message: expect.stringMatching(/declares adapter id "raw", this channel is "other"/) });
    const { file, pids } = pidLog();
    const ch = await rawChild('', { expectId: 'other', retryFirstConnect: true, backoff: { minMs: 20, maxMs: 40 } }, { PIDS_FILE: file });
    expect(ch.id).toBe('other');
    expect(ch.state()).toMatchObject({ connected: false, error: expect.stringMatching(/this channel is "other"/) });
    const r = run(ch);
    await waitFor(() => pids().length >= 3);
    expect(ch.state().connected).toBe(false);
    expect(ch.id).toBe('other');
    await r.stop();
  });

  it('without expectId the first hello pins the id: a restarted peer declaring another is refused #ID-3', async () => {
    const idFile = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'id');
    const ch = await rawChild('flap', { backoff: { minMs: 20, maxMs: 40 } }, { ID_FILE: idFile, ADAPTER_ID_LATER: 'lark-bot' });
    expect(ch.id).toBe('raw');
    const r = run(ch);
    await r.until(() => r.logs.some((l) => l.includes('declares adapter id "lark-bot", this channel is "raw"')));
    expect(ch.id).toBe('raw');
    await r.stop();
  });

  it('acceptId can refuse a hello id (bad_hello) #ID-3', async () => {
    await expect(rawChild('', { acceptId: (id: string) => (id === 'raw' ? 'taken by another channel' : undefined) })).rejects.toMatchObject({
      code: 'bad_hello',
      message: expect.stringMatching(/refused: taken by another channel/),
    });
    const ok = await rawChild('', { acceptId: () => undefined });
    expect(ok.id).toBe('raw');
  });

  it('a refused inbound is answered ok:true with {accepted:false} #ID-3', async () => {
    const ch = await rawChild('', {}, { INBOUND: JSON.stringify({ channel: 'lark-bot' }) });
    const logs: string[] = [];
    const ctl = new AbortController();
    const started = ch.start({ account: 'default', config: undefined, signal: ctl.signal, emit: async () => ({ accepted: false }), log: (l, m) => logs.push(`${l}: ${m}`) });
    await waitFor(() => logs.some((l) => l.includes('got-result forged ok=true code=undefined accepted=false')));
    ctl.abort();
    await started;
  });
});
