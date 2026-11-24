import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadChannelModule, loadHarnessModule } from '../../kernel/src/module-loader.js';

/*
 * One loader for both kinds of plugin module, each with its own export rule: a channel module's
 * named export falls back to `default`; a harness module's named export does not (without a name,
 * both take `default` when the conventional export is missing).
 */

const fx = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const log = () => {};

const channel = (file: string, exp?: string) => loadChannelModule({ file: join(fx, file), ...(exp ? { export: exp } : {}), index: 0, account: 'a', config: undefined, log });
const harness = (file: string, exp?: string) =>
  loadHarnessModule({
    name: 'plug',
    module: { file: join(fx, file), ...(exp ? { export: exp } : {}) },
    log,
    harness: () => {
      throw new Error('no other instances');
    },
    blobs: {
      stat: async () => undefined,
      get: async () => {
        throw new Error('no blobs');
      },
    },
    env: {},
    profiles: {},
  });

describe('module loader', () => {
  it('a channel module: without a name createChannel, else default; a missing named export falls back to default too', async () => {
    expect((await channel('chan-default-only.mjs')).id).toBeTruthy();
    expect((await channel('chan-default-only.mjs', 'other')).id).toBeTruthy();
    await expect(channel('chan-not-fn.mjs')).rejects.toThrow(/^channels\[0\] \(module .*chan-not-fn\.mjs\): export "createChannel" \(or default\) is not a function$/);
  });

  it('a harness module: without a name createHarness, else default; a named export never falls back', async () => {
    expect((await harness('harness-default-only.mjs')).id).toBe('default-only-plug');
    await expect(harness('harness-default-only.mjs', 'other')).rejects.toThrow(/^harnesses\.plug \(module .*harness-default-only\.mjs\): export "other" is not a function$/);
    await expect(harness('harness-not-fn.mjs')).rejects.toThrow(/^harnesses\.plug \(module .*harness-not-fn\.mjs\): export "createHarness" \(or default\) is not a function$/);
  });

  it('an import failure names the entry and the file', async () => {
    await expect(channel('no-such-file.mjs')).rejects.toThrow(/^channels\[0\] \(module .*no-such-file\.mjs\): cannot import: /);
    await expect(harness('no-such-file.mjs')).rejects.toThrow(/^harnesses\.plug \(module .*no-such-file\.mjs\): cannot import: /);
  });
});
