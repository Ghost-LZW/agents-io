import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { resolveConfig, type HarnessInstance } from '../src/config.js';
import { Gateway, InstanceHarness } from '../src/gateway.js';
import { cleanups, tmp, until } from './helpers.js';

/* `type: "module"` channels: an adapter loaded from an external ES module (fixtures/chan-*). */

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, 'fixtures');

type Rec = { via: string; init: { account: string; config: unknown }; closed: boolean; startConfig?: unknown; blobs?: unknown; inject?: (p: object) => Promise<{ accepted: boolean }>; sent: unknown[] };
const recs = () => ((globalThis as { __chan?: Record<string, Rec> }).__chan ??= {});

const resolve = (channels: unknown[], env: Record<string, string> = {}) => resolveConfig({ channels }, { env, baseDir: here, cwd: here });

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

describe('module channel gateway', () => {
  it('start() gets account, substituted config and the blob store; its inbound is accepted; close() runs at stop', async () => {
    const gw = await start([{ type: 'module', module: './fixtures/chan-pkg', account: 'lan', config: { id: 'plug', token: 'env:PLUG_TOKEN' } }], { env: { PLUG_TOKEN: 's3' } });
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

  it('export option picks a named export; default is the fallback; import-only package works', async () => {
    await start([
      { type: 'module', module: './fixtures/chan-pkg', export: 'other', config: { id: 'a' } },
      { type: 'module', module: './fixtures/chan-pkg', export: 'missing', config: { id: 'b' } },
      { type: 'module', module: './fixtures/chan-default-only.mjs', config: { id: 'c' } },
      { type: 'module', module: './fixtures/chan-import-only', config: { id: 'd' } },
    ]);
    expect(['a', 'b', 'c', 'd'].map((id) => recs()[`${id}:default`]?.via)).toEqual(['other', 'default', 'default-only', 'import-only']);
  });

  it('fails the start for a non-function export, a bad adapter shape, and a throwing factory', async () => {
    await expect(start([{ type: 'module', module: './fixtures/chan-not-fn.mjs' }])).rejects.toThrow(/channels\[0\].*"createChannel" \(or default\) is not a function/);
    await expect(start([{ type: 'module', module: './fixtures/chan-bad-shape.mjs' }])).rejects.toThrow(/did not return a ChannelAdapter \(bad start\)/);
    await expect(start([{ type: 'module', module: './fixtures/chan-throws.mjs' }])).rejects.toThrow(/factory failed: boom/);
  });

  it('fails when two entries give the same (channel, account), also against another channel', async () => {
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
    await expect(start([{ type: 'module', module: './fixtures/chan-pkg', config: { id: 'fake' } }], { extra: [{ adapter: new FakeChannel('fake') }] })).rejects.toThrow(/same \(channel, account\)/);
  });
});
