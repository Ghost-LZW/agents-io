import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { resolveConfig, type HarnessInstance } from '../src/config.js';
import { Gateway, InstanceHarness } from '../src/gateway.js';
import { cleanups, tmp, until } from './helpers.js';

/* `type: "module"` channels and `use: "module"` harnesses: adapters loaded from an external ES module (fixtures/chan-*, fixtures/harness-*). */

const here = dirname(fileURLToPath(import.meta.url));

type Rec = { via: string; init: { account: string; config: unknown }; closed: boolean; startConfig?: unknown; blobs?: unknown; inject?: (p: object) => Promise<{ accepted: boolean }>; sent: unknown[] };
const recs = () => ((globalThis as { __chan?: Record<string, Rec> }).__chan ??= {});

async function start(channels: unknown[], o: { env?: Record<string, string>; extra?: { adapter: FakeChannel; account?: string }[] } = {}) {
  const dir = tmp('aio-mc-');
  mkdirSync(join(dir, 'work'), { recursive: true });
  const raw = { dataDir: dir, policy: { owners: ['plug:alice'] }, local: { principal: 'me' }, cwd: join(dir, 'work'), channels };
  const base = resolveConfig(raw, { env: o.env ?? {}, baseDir: here, cwd: dir });
  const harness = new FakeHarness();
  const gw = await Gateway.start({
    config: { ...base, socketPath: join(dir, 'run', 'aio.sock') },
    buildHarness: (i: HarnessInstance) => new InstanceHarness(i, harness),
    ...(o.extra ? { channels: o.extra } : {}),
    logger: () => {},
    listen: false,
  });
  cleanups.push(() => gw.stop());
  return gw;
}

describe('module channel gateway', () => {
  it('start() gets account, substituted config and the blob store; its inbound is accepted; close() runs at stop #CF-4 #ID-3', async () => {
    // A module gives platform_signed only when the entry grants it (channel-stamping E3).
    const gw = await start([{ type: 'module', module: './fixtures/chan-pkg', account: 'lan', evidence: ['platform_signed'], config: { id: 'plug', token: 'env:PLUG_TOKEN' } }], { env: { PLUG_TOKEN: 's3' } });
    const r = recs()['plug:lan']!;
    expect(r.via).toBe('createChannel');
    expect(r.init).toMatchObject({ account: 'lan', config: { token: 's3' } });
    await until(() => r.inject);
    expect(r.startConfig).toMatchObject({ token: 's3' });
    expect(r.blobs).toBeDefined();
    const res = await r.inject!({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    expect(res.accepted).toBe(true);
    await until(() => r.sent.length > 0);
    await gw.stop();
    expect(r.closed).toBe(true);
  });

  it('export option picks a named export; default is the fallback; import-only package works #CF-4', async () => {
    await start([
      { type: 'module', module: './fixtures/chan-pkg', export: 'other', config: { id: 'a' } },
      { type: 'module', module: './fixtures/chan-pkg', export: 'missing', config: { id: 'b' } },
      { type: 'module', module: './fixtures/chan-default-only.mjs', config: { id: 'c' } },
      { type: 'module', module: './fixtures/chan-import-only', config: { id: 'd' } },
    ]);
    expect(['a', 'b', 'c', 'd'].map((id) => recs()[`${id}:default`]?.via)).toEqual(['other', 'default', 'default-only', 'import-only']);
  });

  it('fails the start for a non-function export, a bad adapter shape, and a throwing factory #CF-4', async () => {
    await expect(start([{ type: 'module', module: './fixtures/chan-not-fn.mjs' }])).rejects.toThrow(/channels\[0\].*"createChannel" \(or default\) is not a function/);
    await expect(start([{ type: 'module', module: './fixtures/chan-bad-shape.mjs' }])).rejects.toThrow(/did not return a ChannelAdapter \(bad start\)/);
    await expect(start([{ type: 'module', module: './fixtures/chan-throws.mjs' }])).rejects.toThrow(/factory failed: boom/);
  });

  it('fails when two entries give the same (channel, account), also against another channel #ID-3', async () => {
    await expect(
      start([
        { type: 'module', module: './fixtures/chan-pkg', config: { id: 'dup1' } },
        { type: 'module', module: './fixtures/chan-pkg', config: { id: 'dup1' } },
      ]),
    ).rejects.toThrow(/same \(channel, account\)/);
    // Different accounts of one id are fine.
    await start([
      { type: 'module', module: './fixtures/chan-pkg', account: 'a', config: { id: 'dup2' } },
      { type: 'module', module: './fixtures/chan-pkg', account: 'b', config: { id: 'dup2' } },
    ]);
    // One channel id is one adapter (F4): a module may not share an id with another adapter, whatever the account.
    await expect(start([{ type: 'module', module: './fixtures/chan-pkg', config: { id: 'fake' } }], { extra: [{ adapter: new FakeChannel('fake') }] })).rejects.toThrow(/channel id "fake" belongs to module:.*embedded adapter FakeChannel cannot use it too/);
    await expect(start([{ type: 'module', module: './fixtures/chan-pkg', config: { id: 'fake' } }], { extra: [{ adapter: new FakeChannel('fake'), account: 'other' }] })).rejects.toThrow(/one channel id is one adapter/);
    await expect(
      start([
        { type: 'module', module: './fixtures/chan-pkg', account: 'a', config: { id: 'dup3' } },
        { type: 'module', module: './fixtures/chan-default-only.mjs', account: 'b', config: { id: 'dup3' } },
      ]),
    ).rejects.toThrow(/channel id "dup3" belongs to module:/);
    // Nor take a built-in id.
    await expect(start([{ type: 'module', module: './fixtures/chan-pkg', config: { id: 'lark-bot' } }])).rejects.toThrow(/"lark-bot" is a built-in channel id/);
  });

  it('without an evidence grant its platform_signed is capped to none (stranger, counted in status, recorded as none) #ID-3 #ID-4', async () => {
    const gw = await start([{ type: 'module', module: './fixtures/chan-pkg', account: 'cap', config: { id: 'plug' } }]);
    const r = recs()['plug:cap']!;
    await until(() => r.inject);
    const res = await r.inject!({ id: 'cap-1', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    expect(res.accepted).toBe(true);
    expect(gw.records.verify('channel:plug/cap-1').records).toEqual([expect.objectContaining({ evidence: 'none', principal: null })]);
    expect(gw.adminStatus().channels.find((c) => c.id === 'plug')).toMatchObject({ evidenceCapped: 1 });
  });
});

describe('module harness (use: "module")', () => {
  /** Gateway.start with instance `plug` (the default harness) loaded from `module`; no buildHarness, so the gateway loads the module itself. */
  async function startHarness(module: string) {
    const dir = tmp('aio-mh-');
    mkdirSync(join(dir, 'work'), { recursive: true });
    const raw = { dataDir: dir, local: { principal: 'me' }, cwd: join(dir, 'work'), harnesses: { plug: { use: 'module', module } }, defaultHarness: 'plug' };
    const base = resolveConfig(raw, { env: {}, baseDir: here, cwd: dir });
    const gw = await Gateway.start({ config: { ...base, socketPath: join(dir, 'run', 'aio.sock') }, logger: () => {}, listen: false });
    cleanups.push(() => gw.stop());
    return gw;
  }

  it('a missing module, a non-function export, a throwing factory and a value that is not an adapter each fail the start, naming the instance #CF-4', async () => {
    // A missing module is a config error, caught while resolving the config (before Gateway.start).
    await expect(startHarness('./fixtures/harness-nope.mjs')).rejects.toThrow(/harnesses\.plug\.module: .*harness-nope\.mjs does not exist/);
    await expect(startHarness('./fixtures/harness-not-fn.mjs')).rejects.toThrow(/harnesses\.plug \(module .*harness-not-fn\.mjs\): export "createHarness" \(or default\) is not a function/);
    await expect(startHarness('./fixtures/harness-throws.mjs')).rejects.toThrow(/harnesses\.plug \(module .*\): factory failed: boom/);
    await expect(startHarness('./fixtures/harness-bad-shape.mjs')).rejects.toThrow(/harnesses\.plug \(module .*\): the factory did not return a HarnessAdapter \(bad open\)/);
  });
});
