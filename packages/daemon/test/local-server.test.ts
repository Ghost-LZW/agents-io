import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarness } from '@agents-io/testkit';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { LocalServer, type LocalHost } from '../src/local-server.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aio-ls-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const host = {} as LocalHost;
const mode = (p: string) => statSync(p).mode & 0o7777;

describe('LocalServer socket path', () => {
  it('creates a missing socket directory 0700 and the socket 0600 #SE-2', async () => {
    const d = tmp();
    const s = new LocalServer(host, join(d, 'run', 'aio.sock'));
    await s.listen();
    cleanups.push(() => s.close('test'));
    expect(mode(join(d, 'run'))).toBe(0o700);
    expect(mode(join(d, 'run', 'aio.sock'))).toBe(0o600);
  });

  it('does not chmod an existing directory it did not create; refuses one other users can reach #SE-2', async () => {
    const d = tmp();
    const proj = join(d, 'proj');
    mkdirSync(proj);
    chmodSync(proj, 0o755);
    await expect(new LocalServer(host, join(proj, 'aio.sock')).listen()).rejects.toThrow(/accessible to other users/);
    expect(mode(proj)).toBe(0o755);
    expect(existsSync(join(proj, 'aio.sock'))).toBe(false);
  });

  it('never unlinks a file that is not a socket #SE-2', async () => {
    const d = tmp();
    const dir = join(d, 'state');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'log.sqlite');
    writeFileSync(file, 'precious');
    await expect(new LocalServer(host, file).listen()).rejects.toThrow(/not a socket/);
    expect(readFileSync(file, 'utf8')).toBe('precious');
  });

  it('replaces a stale socket left by a killed process #SE-2', async () => {
    const d = tmp();
    const p = join(d, 'run', 'aio.sock');
    mkdirSync(join(d, 'run'), { mode: 0o700 });
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(p)}, () => console.log('up'))`]);
    await new Promise((r) => child.stdout.once('data', r));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(statSync(p).isSocket()).toBe(true);
    const s = new LocalServer(host, p);
    await s.listen();
    cleanups.push(() => s.close('test'));
    expect(mode(p)).toBe(0o600);
  });
});

describe('gateway data files', () => {
  it('the SQLite session log (and its -wal/-shm) is 0600 even in an existing 0755 directory; existing files are tightened #SE-2', async () => {
    const d = tmp();
    const dir = join(d, 'repo');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, 'old.sqlite'), '');
    chmodSync(join(dir, 'old.sqlite'), 0o644);
    const warnings: string[] = [];
    for (const name of ['log.sqlite', 'old.sqlite']) {
      const base = resolveConfig({ logPath: join(dir, name), blobs: { dir: join(d, 'blobs') } }, { env: {}, baseDir: d, cwd: d });
      const gw = await Gateway.start({ config: base, harness: new FakeHarness(), listen: false, logger: (lvl, msg) => lvl === 'warn' && warnings.push(msg) });
      await gw.stop();
      for (const f of [name, `${name}-wal`, `${name}-shm`]) if (existsSync(join(dir, f))) expect([f, mode(join(dir, f))]).toEqual([f, 0o600]);
      expect(mode(join(dir, name))).toBe(0o600);
    }
    // The user's directory is not chmodded behind their back, but they are told.
    expect(mode(dir)).toBe(0o755);
    expect(warnings.some((w) => w.includes(dir) && /other users/.test(w))).toBe(true);
  });
});
