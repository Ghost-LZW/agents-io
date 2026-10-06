import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelAdapter, InboundEnvelope } from '@agents-io/protocol';
import { FakeChannel, runChannelConformance } from '@agents-io/testkit';
import { ChannelBridgeError, connectChannel, serveChannel, spawnChannel, type BridgedChannel } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => join(here, 'fixtures', n);
const route = { channel: 'fake-child', account: 'default', conversationId: 'c1' };
const hasPython = spawnSync('python3', ['--version']).status === 0;

beforeAll(() => {
  if (!existsSync(join(here, '..', 'dist', 'index.js'))) throw new Error('run `npx tsc -b channel/jsonl-bridge` first: fixtures import dist/');
});

/** Starts the adapter and collects what it emits; `stop` aborts and waits for start to return. */
function run(adapter: ChannelAdapter, account = 'default') {
  const ctl = new AbortController();
  const inbound: InboundEnvelope[] = [];
  const logs: string[] = [];
  const waiters: (() => void)[] = [];
  const started = adapter.start({
    account,
    config: undefined,
    signal: ctl.signal,
    emit: async (env) => {
      inbound.push(env);
      waiters.splice(0).forEach((w) => w());
      return { accepted: true, inputId: `in-${inbound.length}` };
    },
    log: (level, msg) => logs.push(`${level}: ${msg}`),
  });
  const until = async (pred: () => boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out; inbound=${inbound.length} logs=${logs.join(' | ')}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 25);
      });
    }
  };
  return { inbound, logs, until, stop: async () => (ctl.abort(), await started) };
}

let open: BridgedChannel[] = [];
afterEach(async () => {
  await Promise.all(open.map((c) => c.close()));
  open = [];
});
const track = async (p: Promise<BridgedChannel>) => {
  const c = await p;
  open.push(c);
  return c;
};
const fakeChild = (env: Record<string, string> = {}, extra = {}) =>
  track(spawnChannel({ command: process.execPath, args: [fixture('fake_child.mjs')], env, account: 'default', ...extra }));
const rawChild = (mode: string, extra = {}) =>
  track(spawnChannel({ command: process.execPath, args: [fixture('raw_child.mjs')], env: { MODE: mode }, account: 'default', ...extra }));

describe('serveChannel <-> spawnChannel', () => {
  it('performs hello and exposes only declared methods', async () => {
    const ch = await fakeChild();
    expect(ch.id).toBe('fake-child');
    expect(ch.caps('default').edit).toBe(true);
    expect(ch.edit && ch.finalize).toBeTruthy();
    expect(ch.speak).toBeUndefined();
    expect(ch.typing).toBeUndefined();
    expect(ch.reconcile).toBeUndefined();
  });

  it('round-trips inbound, send, edit and finalize', async () => {
    const ch = await fakeChild({ INJECT: '1' });
    const r = run(ch);
    await r.until(() => r.inbound.length === 1);
    expect(r.inbound[0]?.content).toEqual([{ type: 'text', text: 'msg-0' }]);
    const a = await ch.send(route, { text: 'hi' }, { operationId: 'op1' });
    const b = await ch.send(route, { text: 'hi' }, { operationId: 'op1' });
    expect(a.providerMessageId).toBeTruthy();
    expect(b).toEqual(a);
    await ch.edit!(route, a.providerMessageId!, { text: 'hi 2' }, { operationId: 'op2', sequence: 1 });
    await ch.finalize!(route, a.providerMessageId!, { text: 'done' });
    await expect(ch.finalize!(route, 'nope', { text: 'x' })).rejects.toMatchObject({ code: 'adapter_error', retryable: false });
    await r.stop();
  });

  it('passes channel conformance', async () => {
    const ch = await fakeChild({ INJECT: '1' });
    const report = await runChannelConformance({ adapter: ch, account: 'default', triggerInbound: async () => {}, route });
    expect(report.failed).toEqual([]);
    expect(report.passed).toEqual(expect.arrayContaining(['inbound.emit', 'inbound.schema', 'outbound.idempotent', 'outbound.edit']));
  });

  it('holds inbound frames sent before start until a context exists', async () => {
    const ch = await fakeChild({ INJECT: '2' });
    await new Promise((r) => setTimeout(r, 200)); // child has already emitted
    const r = run(ch);
    await r.until(() => r.inbound.length === 2);
    await r.stop();
  });
});

describe('robustness', () => {
  it('drops malformed, unknown and invalid frames without crashing', async () => {
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

  it('serveChannel answers invalid host frames and ignores garbage', async () => {
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

  it('restarts a crashed child with backoff and keeps delivering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
    const ch = await fakeChild({ CRASH_FILE: join(dir, 'crashed') }, { backoff: { minMs: 20, maxMs: 100 } });
    const r = run(ch);
    await r.until(() => r.inbound.length === 2);
    expect(r.inbound.map((e) => (e.content[0] as { text: string }).text)).toEqual(['before-crash', 'after-restart']);
    expect(r.logs.some((l) => l.includes('restarting'))).toBe(true);
    expect((await ch.send(route, { text: 'after' }, { operationId: 'o' })).providerMessageId).toBeTruthy();
    await r.stop();
  });

  it('rejects pending requests retryably when the child dies', async () => {
    const ch = await rawChild('die');
    const err = await ch.send(route, { text: 'x' }, { operationId: 'o' }).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelBridgeError);
    expect(err).toMatchObject({ code: 'peer_closed', retryable: true });
    // With the child gone and no start loop, requests fail fast and retryably.
    await expect(ch.send(route, { text: 'y' }, { operationId: 'p' })).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('times out unanswered requests with a retryable error', async () => {
    const ch = await rawChild('mute', { requestTimeoutMs: 100 });
    const t0 = Date.now();
    await expect(ch.send(route, { text: 'x' }, { operationId: 'o' })).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('fails spawnChannel when the command does not exist or never says hello', async () => {
    await expect(spawnChannel({ command: '/nonexistent/adapter', account: 'a' })).rejects.toThrow();
    await expect(
      spawnChannel({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], account: 'a', helloTimeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('connectChannel', () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  it('talks to an adapter served over a unix socket', async () => {
    const fake = new FakeChannel('sock');
    const path = join(mkdtempSync(join(tmpdir(), 'bridge-')), 's.sock');
    server = createServer((s) => void serveChannel(fake, { input: s, output: s }));
    await new Promise<void>((r) => server!.listen(path, r));
    const ch = await track(connectChannel({ path, account: 'default' }));
    const r = run(ch);
    await r.until(() => (fake as any).ctx !== undefined);
    await fake.inject({ text: 'over socket' });
    await r.until(() => r.inbound.length === 1);
    expect((await ch.send({ ...route, channel: 'sock' }, { text: 'x' }, { operationId: 'o' })).providerMessageId).toBe('m1');
    await r.stop();
  });
});

describe.skipIf(!hasPython)('python adapter', () => {
  it('is bridged by the same protocol', async () => {
    const record = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'record.jsonl');
    const ch = await track(
      spawnChannel({
        command: 'python3',
        args: [join(here, '..', 'examples', 'echo_channel.py')],
        env: { ECHO_RECORD: record },
        account: 'acct',
      }),
    );
    expect(ch.id).toBe('echo-py');
    expect(ch.edit).toBeUndefined();
    const r = run(ch, 'acct');
    await r.until(() => r.inbound.length === 1);
    expect(r.inbound[0]).toMatchObject({ channel: 'echo-py', account: 'acct', content: [{ type: 'text', text: 'hello from python' }] });
    const rt = r.inbound[0]!.replyRoute!;
    const a = await ch.send(rt, { text: 'echo: hello from python' }, { operationId: 'py-op' });
    expect(await ch.send(rt, { text: 'echo: hello from python' }, { operationId: 'py-op' })).toEqual(a);
    await r.stop();
    const lines = readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ providerMessageId: a.providerMessageId, text: 'echo: hello from python', operationId: 'py-op' }]);
  });
});
