import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeChannel } from '@agents-io/testkit';
import { SOURCE_LOADER, tmp, until } from './helpers.js';
import { BrokenChannel, RAW_CHILD, alive, bridge, live } from './live-channels-helpers.js';

describe('console.liveChannels', () => {
  it('off (default): a channel added by PUT waits for a restart, as before #CF-2', async () => {
    const { doc, put, status } = await live({ liveChannels: false });
    const d = await doc();
    const r = await put({ ...d.config, channels: [bridge('b1')] });
    expect(r.applied).toBe('restart');
    expect(r.channels).toBeUndefined();
    expect(status().map((c) => c.account)).toEqual(['default']);
  });

  it('starts added channels, restarts changed ones, keeps unchanged ones, stops removed ones #CF-2', async () => {
    const pids = join(tmp(), 'pids');
    // Env values are credentials: the console takes references only.
    const { doc, put, status } = await live({ consoleEnv: { T_PIDS: pids } });
    const d = await doc();
    const one = bridge('b1', { env: { PIDS_FILE: 'env:T_PIDS' } });
    const two = bridge('b2', { env: { PIDS_FILE: 'env:T_PIDS' } });

    const r1 = await put({ ...d.config, channels: [one, two] });
    expect(r1).toMatchObject({ applied: 'live', channels: { started: [{ type: 'bridge', account: 'b1' }, { type: 'bridge', account: 'b2' }], stopped: [] } });
    await until(() => status().filter((c) => c.id === 'raw' && c.state === 'running').length === 2);
    await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim().split('\n').length === 2);
    const [p1, p2] = readFileSync(pids, 'utf8').trim().split('\n').map(Number);

    // Same document again: nothing to do.
    const again = await put((await doc()).config);
    expect(again).toMatchObject({ applied: 'live', channels: { started: [], stopped: [] } });

    // b1 changes (its args), b2 is removed.
    const r2 = await put({ ...(await doc()).config, channels: [bridge('b1', { env: { PIDS_FILE: 'env:T_PIDS' }, args: [...SOURCE_LOADER, RAW_CHILD, 'v2'] })] });
    expect(r2).toMatchObject({ applied: 'live', channels: { started: [{ type: 'bridge', account: 'b1' }], stopped: [{ type: 'bridge', account: 'b1' }, { type: 'bridge', account: 'b2' }] } });
    await until(() => !alive(p1!) && !alive(p2!), 5000);
    await until(() => readFileSync(pids, 'utf8').trim().split('\n').length === 3);
    expect(status().filter((c) => c.id === 'raw').map((c) => c.account)).toEqual(['b1']);
    // The in-process channel is never touched.
    expect(status().find((c) => c.id === 'fake')).toMatchObject({ state: 'running' });

    // Everything removed.
    const r3 = await put({ ...(await doc()).config, channels: [] });
    expect(r3.channels!.stopped).toEqual([{ type: 'bridge', account: 'b1' }]);
    expect(status().map((c) => c.id)).toEqual(['fake']);
  });

  it('with another change pending, channels still apply live and the answer says restart; undoing it says live #CF-2', async () => {
    const { doc, put, status } = await live();
    const d = await doc();
    const r = await put({ ...d.config, outputTools: false, channels: [bridge('b1')] });
    expect(r).toMatchObject({ applied: 'restart', channels: { started: [{ type: 'bridge', account: 'b1' }] } });
    await until(() => status().some((c) => c.account === 'b1' && c.state === 'running'));
    const { outputTools: _o, ...back } = (await doc()).config as Record<string, unknown>;
    expect(await put(back)).toMatchObject({ applied: 'live', channels: { started: [], stopped: [] } });
  });

  it('a rotated secret in the env file counts as a change: the channel restarts with the same config document #CF-2', async () => {
    const pids = join(tmp(), 'pids');
    const { w, doc, put } = await live({ consoleEnv: { T_PIDS: pids } });
    const envFile = (w.config as { source?: { envFile?: string } }).source!.envFile!;
    writeFileSync(envFile, 'T_SECRET=one\n', { mode: 0o600 });
    const r1 = await put({ ...(await doc()).config, channels: [bridge('b1', { env: { PIDS_FILE: 'env:T_PIDS', SECRET: 'env:T_SECRET' } })] });
    expect(r1.channels!.started).toEqual([{ type: 'bridge', account: 'b1' }]);
    await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim().split('\n').length === 1);
    // Unchanged file and env: nothing to do.
    expect((await put((await doc()).config)).channels).toEqual({ started: [], stopped: [] });
    writeFileSync(envFile, 'T_SECRET=two\n', { mode: 0o600 });
    const r2 = await put((await doc()).config);
    expect(r2).toMatchObject({ applied: 'live', channels: { started: [{ type: 'bridge', account: 'b1' }], stopped: [{ type: 'bridge', account: 'b1' }] } });
    await until(() => readFileSync(pids, 'utf8').trim().split('\n').length === 2);
  });

  it('a bridge whose first connect fails is reported failed (not started) and the file not applied, until it connects #CF-1 #CF-2', async () => {
    const gate = join(tmp(), 'gate');
    const { doc, put, status } = await live({ consoleEnv: { T_MODE: 'gated', T_GATE: gate } });
    const r = await put({ ...(await doc()).config, channels: [bridge('b1', { env: { MODE: 'env:T_MODE', GATE_FILE: 'env:T_GATE' } })] });
    expect(r.applied).toBe('restart');
    expect(r.channels).toMatchObject({ started: [], stopped: [], failed: [{ type: 'bridge', account: 'b1', error: expect.stringContaining('retrying') }] });
    expect(status().find((c) => c.account === 'b1')).toMatchObject({ state: 'failed' });
    // It keeps retrying; once it connects, the same file counts as applied.
    writeFileSync(gate, '');
    await until(() => status().some((c) => c.account === 'b1' && c.state === 'running'), 10_000);
    const again = await put((await doc()).config);
    expect(again).toMatchObject({ applied: 'live', channels: { started: [], stopped: [] } });
    expect(again.channels!.failed).toBeUndefined();
  }, 20_000);

  it('a channel whose start rejects is reported failed, forgotten, and started again by the next apply #CF-2', async () => {
    let broken = true;
    const made: FakeChannel[] = [];
    const { doc, put, status } = await live({
      channelAdapter: (ch) => (ch.type === 'bridge' ? (made.push(broken ? new BrokenChannel('extra') : new FakeChannel('extra')), made.at(-1)) : undefined),
    });
    const r = await put({ ...(await doc()).config, channels: [bridge('x1')] });
    expect(r).toMatchObject({ applied: 'restart', channels: { started: [], failed: [{ type: 'bridge', account: 'x1', error: 'invalid app secret' }] } });
    expect(status().map((c) => c.id)).toEqual(['fake']);
    broken = false;
    const r2 = await put((await doc()).config);
    expect(r2).toMatchObject({ applied: 'live', channels: { started: [{ type: 'bridge', account: 'x1' }] } });
    expect(made).toHaveLength(2);
    expect(status().find((c) => c.id === 'extra')).toMatchObject({ state: 'running' });
  });
});
