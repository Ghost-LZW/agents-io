import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';

/* `type: "module"` channels: path and exports resolution of the config entry (fixtures/chan-*). */

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, 'fixtures');

const resolve = (channels: unknown[], env: Record<string, string> = {}) => resolveConfig({ channels }, { env, baseDir: here, cwd: here });

describe('module channel config', () => {
  it('resolves a relative path against the config dir to the package entry', () => {
    const c = resolve([{ type: 'module', module: './fixtures/chan-pkg', account: 'lan' }]);
    expect(c.channels[0]).toMatchObject({ type: 'module', account: 'lan', module: join(fx, 'chan-pkg', 'index.mjs') });
  });

  it('resolves an exports map with only an import condition, an absolute path, and a file', () => {
    expect(resolve([{ type: 'module', module: './fixtures/chan-import-only' }]).channels[0]).toMatchObject({ module: join(fx, 'chan-import-only', 'main.mjs') });
    expect(resolve([{ type: 'module', module: join(fx, 'chan-pkg') }]).channels[0]).toMatchObject({ module: join(fx, 'chan-pkg', 'index.mjs') });
    expect(resolve([{ type: 'module', module: './fixtures/chan-default-only.mjs' }]).channels[0]).toMatchObject({ module: join(fx, 'chan-default-only.mjs'), account: 'default' });
  });

  it('substitutes env in config, and a missing variable fails naming it', () => {
    const c = resolve([{ type: 'module', module: './fixtures/chan-pkg', config: { token: 'env:PLUG_TOKEN' } }], { PLUG_TOKEN: 's3' });
    expect(c.channels[0]).toMatchObject({ config: { token: 's3' } });
    expect(() => resolve([{ type: 'module', module: './fixtures/chan-pkg', config: { token: 'env:PLUG_TOKEN' } }])).toThrow(/PLUG_TOKEN/);
  });

  it('reports a missing module and unknown keys; clients skip channels', () => {
    expect(() => resolve([{ type: 'module', module: './fixtures/nope' }])).toThrow(/channels\[0\]\.module: .*nope does not exist/);
    expect(() => resolve([{ type: 'module', module: 'no-such-package-xyz' }])).toThrow(/cannot resolve "no-such-package-xyz"/);
    expect(() => resolve([{ type: 'module', module: './fixtures/chan-pkg', extra: 1 }])).toThrow(/invalid config/);
    expect(() => resolve([{ type: 'module' }])).toThrow(/invalid config/);
    expect(resolveConfig({ channels: [{ type: 'module', module: './nope' }] }, { env: {}, baseDir: here, cwd: here, channels: false }).channels).toEqual([]);
  });
});
