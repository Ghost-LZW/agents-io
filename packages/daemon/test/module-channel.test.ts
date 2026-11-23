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
  async function startHarness(module: string, config?: Record<string, unknown>, entry: Record<string, unknown> = {}) {
    const dir = tmp('aio-mh-');
    mkdirSync(join(dir, 'work'), { recursive: true });
    const raw = { dataDir: dir, local: { principal: 'me' }, cwd: join(dir, 'work'), harnesses: { plug: { use: 'module', module, ...(config ? { config } : {}), ...entry } }, defaultHarness: 'plug' };
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

  it('an adapter whose static declarations or lifecycle members are of the wrong type fails the start, naming the instance and the member; right ones start #CF-4', async () => {
    const declares = (members: Record<string, unknown>) => startHarness('./fixtures/harness-declares.mjs', { members });
    const bad = (what: string) => `: the factory did not return a HarnessAdapter (bad ${what})`;
    const cases: [Record<string, unknown>, string][] = [
      [{ displayName: 7 }, 'displayName (a non-empty string when present)'],
      [{ displayName: '' }, 'displayName (a non-empty string when present)'],
      [{ compact: '/compact' }, 'compact ({ command } with a non-empty string, when present)'],
      [{ compact: {} }, 'compact ({ command } with a non-empty string, when present)'],
      [{ modes: { $set: ['plan'] } }, "modes (an array of 'plan' when present)"],
      [{ modes: 'plan' }, "modes (an array of 'plan' when present)"],
      [{ modes: ['plan', 'review'] }, "modes (an array of 'plan' when present)"],
      [{ ownerProfileSwitch: 'yes' }, 'ownerProfileSwitch (true or false when present)'],
      [{ ephemeralOpen: 1 }, 'ephemeralOpen (true or false when present)'],
      [{ adopts: 'true' }, 'adopts (true or false when present)'],
      [{ sessionEnv: null }, "sessionEnv ('open', 'own-process' or { refused } with a non-empty string, when present)"],
      [{ sessionEnv: 'shared' }, "sessionEnv ('open', 'own-process' or { refused } with a non-empty string, when present)"],
      [{ sessionEnv: { refused: '' } }, "sessionEnv ('open', 'own-process' or { refused } with a non-empty string, when present)"],
      [{ sessionEnv: 'own-process' }, "sessionEnv ('own-process' needs ownProcess)"],
      [{ detach: true }, 'detach (a function when present)'],
      [{ dispose: {} }, 'dispose (a function when present)'],
      [{ ownProcess: 'own' }, 'ownProcess (a function when present)'],
    ];
    for (const [members, what] of cases) {
      const start = declares(members);
      await expect(start, JSON.stringify(members)).rejects.toThrow(/^harnesses\.plug \(module .*harness-declares\.mjs\)/);
      await expect(start, JSON.stringify(members)).rejects.toThrow(bad(what));
    }
    // Right ones (present or not) start, and the daemon reads them as declared.
    const gw = await declares({ displayName: 'Plug', compact: { command: '/squash' }, modes: ['plan'], ownerProfileSwitch: false, ephemeralOpen: false, adopts: false, sessionEnv: { refused: 'a shared test server' } });
    const plug = gw.harness('plug');
    expect([plug.displayName, plug.compact, plug.modes, plug.ownerProfileSwitch, plug.sessionEnv]).toEqual(['Plug', { command: '/squash' }, ['plan'], false, { refused: 'a shared test server' }]);
    await declares({ modes: [], sessionEnv: 'open' });
  });

  it('a module may export a HarnessModule descriptor: its schema checks the config (a bad one fails the start, naming the instance); create gets the init with launch, env and profiles #CF-4', async () => {
    const module = './fixtures/harness-descriptor.mjs';
    await expect(startHarness(module, { key: 'd0', extra: 1 })).rejects.toThrow(/^harnesses\.plug \(module .*harness-descriptor\.mjs\): invalid config: config\/extra: Unexpected property/);
    await expect(startHarness(module)).rejects.toThrow(/^harnesses\.plug \(module .*\): invalid config: config\/key: Expected required property/);
    await expect(startHarness(module, { key: 'd1', throws: true })).rejects.toThrow(/^harnesses\.plug \(module .*\): create failed: no adapter today/);
    const profiles = { tight: { sandbox: 'read-only' } };
    const gw = await startHarness(module, { key: 'd2' }, { env: { BASE: '1' }, profiles });
    const { init } = (globalThis as { __descriptor?: Record<string, { init: Record<string, unknown> }> }).__descriptor!.d2!;
    expect(init).toMatchObject({ name: 'plug', config: { key: 'd2' }, launch: { key: 'd2' }, env: { BASE: '1' }, profiles });
    expect(typeof (init.blobs as { stat?: unknown }).stat).toBe('function');
    expect(gw.harness('plug').displayName).toBe('Described');
  });
});
