import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCredential } from '../src/console-config.js';
import { resolveConfig } from '../src/config.js';
import { TokenError, loadOrCreateTokenFile, tokenPath } from '../src/token.js';
import { daemon, tmp } from './helpers.js';

describe('operator-set host token (host.tokenFile / --token-file)', () => {
  it('generates the file (0600, directory 0700) when missing, then reads it at every later start', async () => {
    const dir = tmp();
    const file = join(dir, 'secrets', 'host.token');
    const w = await daemon({ dir, raw: { host: { tokenFile: file } } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'secrets')).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8').trim()).toBe(w.gw.token);
    // The CLI's copy next to the socket holds the same token.
    expect(readFileSync(tokenPath(w.config.socketPath), 'utf8').trim()).toBe(w.gw.token);
    const c = await w.client();
    await expect(c.hello({ token: w.gw.token, name: 'ops' })).resolves.toMatchObject({ name: 'ops' });
    const t1 = w.gw.token;
    await w.stop();
    // The operator's file stays; the socket copy goes.
    expect(existsSync(file)).toBe(true);
    expect(existsSync(tokenPath(w.config.socketPath))).toBe(false);
    const w2 = await daemon({ dir, raw: { host: { tokenFile: file } } });
    expect(w2.gw.token).toBe(t1);
  });

  it('uses a token the operator wrote', async () => {
    const dir = tmp();
    const file = join(dir, 'host.token');
    writeFileSync(file, 'operator-chosen-token-0123456789\n', { mode: 0o600 });
    const w = await daemon({ dir, raw: { host: { tokenFile: file } } });
    expect(w.gw.token).toBe('operator-chosen-token-0123456789');
  });

  it('refuses files others can read, short tokens, and directories others can write; the daemon does not start', async () => {
    const dir = tmp();
    const loose = join(dir, 'loose.token');
    writeFileSync(loose, 'x'.repeat(40), { mode: 0o644 });
    chmodSync(loose, 0o644);
    expect(() => loadOrCreateTokenFile(loose)).toThrow(TokenError);
    await expect(daemon({ dir, raw: { host: { tokenFile: loose } } })).rejects.toThrow(/accessible to other users/);

    const short = join(dir, 'short.token');
    writeFileSync(short, 'abc', { mode: 0o600 });
    expect(() => loadOrCreateTokenFile(short)).toThrow(/shorter than 16/);
    const empty = join(dir, 'empty.token');
    writeFileSync(empty, '\n', { mode: 0o600 });
    expect(() => loadOrCreateTokenFile(empty)).toThrow(/no token/);

    const open = join(dir, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    expect(() => loadOrCreateTokenFile(join(open, 'host.token'))).toThrow(/writable by other users/);
    expect(existsSync(join(open, 'host.token'))).toBe(false);
  });

  it('config: relative to the config file; the path is not a credential', () => {
    const dir = tmp();
    const c = resolveConfig({ host: { tokenFile: 'run/host.token' } }, { env: {}, baseDir: dir });
    expect(c.host).toEqual({ tokenFile: join(dir, 'run', 'host.token') });
    expect(resolveConfig({}, { env: {}, baseDir: dir }).host).toEqual({});
    expect(isCredential({ host: { tokenFile: '/x' } }, ['host', 'tokenFile'])).toBe(false);
  });

  it('GatewayOptions.tokenFile (aio serve --token-file) wins over the config', async () => {
    const dir = tmp();
    const a = join(dir, 'a.token');
    const b = join(dir, 'b.token');
    writeFileSync(a, 'a'.repeat(32), { mode: 0o600 });
    writeFileSync(b, 'b'.repeat(32), { mode: 0o600 });
    const { Gateway } = await import('../src/gateway.js');
    const config = resolveConfig({ dataDir: dir, logPath: ':memory:', host: { tokenFile: a } }, { env: {}, baseDir: dir, cwd: dir });
    const gw = await Gateway.start({ config, listen: false, tokenFile: b, logger: () => {} });
    expect(gw.token).toBe('b'.repeat(32));
    await gw.stop();
  });
});
