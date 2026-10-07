import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { daemon, tmp, until } from './helpers.js';

const RAW_CHILD = fileURLToPath(new URL('../../../channel/jsonl-bridge/test/fixtures/raw_child.mjs', import.meta.url));

describe('a bridge channel whose first hello fails', () => {
  it('does not stop the daemon: status shows it failed with the reason, and it connects once the peer works', async () => {
    const gate = join(tmp(), 'gate');
    const w = await daemon({
      console: true,
      raw: { channels: [{ type: 'bridge', id: 'raw', account: 'b1', command: process.execPath, args: [RAW_CHILD], env: { MODE: 'gated', GATE_FILE: gate } }] },
    });
    const st = () => w.gw.adminStatus().channels.find((c) => c.account === 'b1');
    expect(st()).toMatchObject({ id: 'raw', state: 'failed', error: expect.stringMatching(/retrying/) });
    // The HTTP status reports the same.
    const res = await fetch(`${w.gw.console!.url}/api/status`, { headers: { Authorization: `Bearer ${w.gw.token}` } });
    const body = (await res.json()) as { channels: { account: string; state: string; error?: string }[] };
    expect(body.channels.find((c) => c.account === 'b1')).toMatchObject({ state: 'failed', error: expect.any(String) });
    // Other channels run regardless.
    expect(w.gw.adminStatus().channels.find((c) => c.id === 'fake')).toMatchObject({ state: 'running' });
    writeFileSync(gate, 'open');
    await until(() => st()?.state === 'running', 8000);
    expect(st()).toEqual({ id: 'raw', account: 'b1', state: 'running' });
  });

  it('a bridge whose command cannot be run still fails the start', async () => {
    await expect(daemon({ raw: { channels: [{ type: 'bridge', account: 'b3', command: join(tmp(), 'missing-binary') }] } })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a bridge that connects at once is running, as before', async () => {
    const gate = join(tmp(), 'gate');
    writeFileSync(gate, 'open');
    const w = await daemon({ raw: { channels: [{ type: 'bridge', account: 'b2', command: process.execPath, args: [RAW_CHILD], env: { MODE: 'gated', GATE_FILE: gate } }] } });
    expect(w.gw.adminStatus().channels.find((c) => c.account === 'b2')).toEqual({ id: 'raw', account: 'b2', state: 'running' });
  });
});
