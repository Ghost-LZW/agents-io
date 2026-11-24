import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { ConfigError, resolveConfig } from '../src/config.js';
import { coreRegistries } from '../src/core.js';
import { Gateway } from '../src/gateway.js';
import { cleanups, tmp } from './helpers.js';

/*
 * The kernel has no console of its own (core-slimming §4 P2 item 4): the console API and the
 * config file it edits are `@agents-io/console`'s, handed in as `GatewayOptions.consoleFactory`.
 */

function config(dir: string) {
  const path = join(dir, 'aio.config.json');
  writeFileSync(path, '{}\n', { mode: 0o600 });
  const registries = coreRegistries();
  const c = resolveConfig({ dataDir: dir, local: { principal: 'me' }, cwd: dir, console: { port: 0 } }, { env: {}, baseDir: dir, cwd: dir, ...registries });
  return { config: { ...c, socketPath: join(dir, 'run', 'aio.sock'), source: { path } }, ...registries, harness: new FakeHarness(), channels: [{ adapter: new FakeChannel('fake') }], logger: () => {} };
}

describe('the console seam', () => {
  it('console: true without a consoleFactory fails the start before anything runs, naming the option', async () => {
    const dir = tmp('aio-cs-');
    const o = config(dir);
    await expect(Gateway.start({ ...o, console: true })).rejects.toThrow(ConfigError);
    await expect(Gateway.start({ ...o, console: true })).rejects.toThrow(/GatewayOptions\.consoleFactory/);
  });

  it('without one, a gateway with a config file has no config store and no console', async () => {
    const dir = tmp('aio-cs-');
    const gw = await Gateway.start(config(dir));
    cleanups.push(() => gw.stop());
    expect(gw.configStore).toBeUndefined();
    expect(gw.console).toBeUndefined();
  });

  it('with one, the gateway makes its config store and its server through it', async () => {
    const dir = tmp('aio-cs-');
    const made: string[] = [];
    const store = { path: join(dir, 'aio.config.json') } as never;
    const gw = await Gateway.start({
      ...config(dir),
      console: true,
      consoleFactory: {
        configStore: (o) => {
          made.push(`store ${o.path}`);
          return store;
        },
        server: (o) => {
          made.push(`server ${o.host.configStore === store} ${o.config.port}`);
          return { url: 'http://127.0.0.1:1', listen: async () => {}, close: (reason) => void made.push(`closed ${reason}`) };
        },
      },
    });
    expect(gw.configStore).toBe(store);
    expect(gw.console?.url).toBe('http://127.0.0.1:1');
    await gw.stop();
    expect(made).toEqual([`store ${join(dir, 'aio.config.json')}`, 'server true 0', 'closed gateway stopping']);
  });
});
