import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AdminConfigDocument } from '@agents-io/protocol';
import { main } from '../src/cli.js';
import { consoleUrlPath } from '../src/token.js';
import { consoleDaemon } from './console-helpers.js';
import { daemon, tmp } from './helpers.js';

describe('console auth', () => {
  it('aio console-link prints a one-time login URL that logs in once', async () => {
    const w = await consoleDaemon();
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(s));
    try {
      expect(await main(['console-link', '--socket', w.config.socketPath])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(out[0]).toMatch(new RegExp(`^${w.url}/#login=`));
    const loginToken = out[0]!.split('#login=')[1];
    expect((await w.api('/api/login', { method: 'POST', json: { loginToken }, token: null })).status).toBe(200);
    expect((await w.api('/api/login', { method: 'POST', json: { loginToken }, token: null })).status).toBe(401);
  });
});

describe('console listening and origins', () => {
  it('a taken port is logged, not fatal', async () => {
    const a = await consoleDaemon();
    const port = Number(new URL(a.url).port);
    const b = await daemon({ console: true, raw: { console: { port } } });
    expect(b.gw.console).toBeUndefined();
    expect(Array.isArray(b.gw.sessions())).toBe(true);
  });
});

describe('console config', () => {
  it('PUT of the document the daemon started with applies live (nothing to restart)', async () => {
    const w = await consoleDaemon();
    const doc = (await w.api('/api/config')).body as AdminConfigDocument;
    expect(doc.issues).toEqual([]);
    const r = await w.api('/api/config', { method: 'PUT', json: { config: doc.config } });
    expect(r).toMatchObject({ status: 200, body: { applied: 'live', issues: [] } });
  });
});

describe('console URL file and console-link', () => {
  it('a stale console URL file is removed at start, also when the bind fails', async () => {
    const a = await consoleDaemon();
    const port = Number(new URL(a.url).port);
    const dir = tmp();
    const sock = join(dir, 'run', 'aio.sock');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(consoleUrlPath(sock), 'http://127.0.0.1:1\n', { mode: 0o600 });
    const b = await daemon({ dir, console: true, raw: { console: { port } } });
    expect(b.config.socketPath).toBe(sock);
    expect(b.gw.console).toBeUndefined();
    expect(existsSync(consoleUrlPath(sock))).toBe(false);
  });
});
