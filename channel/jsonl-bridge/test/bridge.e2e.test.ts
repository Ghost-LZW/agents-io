import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnChannel } from '../src/index.js';
import { alive, closeAll, fakeChild, hasPython, here, pidLog, rawChild, route, run, track, waitFor } from './bridge-helpers.js';

afterEach(closeAll);

describe('robustness', () => {
  it('restarts a crashed child with backoff and keeps delivering #CF-1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
    const ch = await fakeChild({ CRASH_FILE: join(dir, 'crashed') }, { backoff: { minMs: 20, maxMs: 100 } });
    const r = run(ch);
    await r.until(() => r.inbound.length === 2);
    expect(r.inbound.map((e) => (e.content[0] as { text: string }).text)).toEqual(['before-crash', 'after-restart']);
    expect(r.logs.some((l) => l.includes('restarting'))).toBe(true);
    expect((await ch.send(route, { text: 'after' }, { operationId: 'o' })).providerMessageId).toBeTruthy();
    await r.stop();
  });
});

describe('lifecycle', () => {
  it('stops and kills the new child when aborted during a reconnect #RS-8', async () => {
    const { file, pids } = pidLog();
    const flaky = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'flaky');
    const ch = await rawChild('flaky', { backoff: { minMs: 10, maxMs: 50 } }, { PIDS_FILE: file, FLAKY_FILE: flaky });
    const r = run(ch);
    await waitFor(() => pids().length === 2); // second launch is still inside its slow hello
    const stopped = r.stop().then(() => 'stopped');
    expect(await Promise.race([stopped, new Promise((res) => setTimeout(() => res('hung'), 3000))])).toBe('stopped');
    await waitFor(() => !alive(pids()[1]!), 3000);
    expect(pids()).toHaveLength(2);
  });

  it('close() during start stops the restart loop instead of respawning #RS-8', async () => {
    const { file, pids } = pidLog();
    const ch = await rawChild('mute', { backoff: { minMs: 5, maxMs: 10 } }, { PIDS_FILE: file });
    const r = run(ch);
    await new Promise((res) => setTimeout(res, 50));
    await ch.close();
    await new Promise((res) => setTimeout(res, 300));
    expect(pids()).toHaveLength(1);
    await r.stop();
  });

  it('close() while a reconnect is in flight kills the child being connected #RS-8', async () => {
    const { file, pids } = pidLog();
    const flaky = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'flaky');
    const ch = await rawChild('flaky', { backoff: { minMs: 10, maxMs: 50 } }, { PIDS_FILE: file, FLAKY_FILE: flaky });
    const r = run(ch);
    await waitFor(() => pids().length === 2);
    await ch.close();
    // The child's hello is still 300ms away; close() must not leave it running until then.
    await waitFor(() => !alive(pids()[1]!), 150);
    await r.stop();
    expect(pids()).toHaveLength(2);
  });

  it('does not accumulate abort listeners across restarts #CF-1', async () => {
    const { getEventListeners } = await import('node:events');
    const { file, pids } = pidLog();
    const ch = await rawChild('flap', { backoff: { minMs: 5, maxMs: 10 } }, { PIDS_FILE: file });
    const ctl = new AbortController();
    const started = ch.start({ account: 'default', config: undefined, signal: ctl.signal, emit: async () => ({ accepted: true }), log: () => {} });
    await waitFor(() => pids().length >= 6);
    expect(getEventListeners(ctl.signal, 'abort').length).toBeLessThanOrEqual(2);
    ctl.abort();
    await started;
  });

  it('restarts a wedged child after repeated request timeouts #CF-1 #DL-1', async () => {
    const { file, pids } = pidLog();
    const ch = await rawChild('mute', { requestTimeoutMs: 50, timeoutsBeforeRestart: 2, backoff: { minMs: 5, maxMs: 10 } }, { PIDS_FILE: file });
    const r = run(ch);
    for (let i = 0; i < 2; i++) await expect(ch.send(route, { text: 'x' }, { operationId: `o${i}` })).rejects.toMatchObject({ code: 'timeout' });
    await waitFor(() => pids().length === 2);
    expect(alive(pids()[0]!)).toBe(false);
    expect(r.logs.some((l) => l.includes('not answering'))).toBe(true);
    await r.stop();
  });

  it("restarts the child after a 'fatal' log #CF-1", async () => {
    const { file, pids } = pidLog();
    const ch = await rawChild('fatal', { backoff: { minMs: 5, maxMs: 10 } }, { PIDS_FILE: file });
    const r = run(ch);
    await waitFor(() => pids().length >= 2);
    expect(r.logs.some((l) => l.includes('cannot log in'))).toBe(true);
    await r.stop();
  });
});

describe.skipIf(!hasPython)('python adapter', () => {
  it('is bridged by the same protocol #CN-1', async () => {
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
