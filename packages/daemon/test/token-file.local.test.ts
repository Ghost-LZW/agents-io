import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCredential } from '../src/console-config.js';
import { resolveConfig } from '../src/config.js';
import { daemon, tmp } from './helpers.js';

describe('operator-set host token (host.tokenFile / --token-file)', () => {
  it('uses a token the operator wrote', async () => {
    const dir = tmp();
    const file = join(dir, 'host.token');
    writeFileSync(file, 'operator-chosen-token-0123456789\n', { mode: 0o600 });
    const w = await daemon({ dir, raw: { host: { tokenFile: file } } });
    expect(w.gw.token).toBe('operator-chosen-token-0123456789');
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
