import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import type { ChannelContext, ChannelInit, ChannelModule, ChannelResolveContext, ChannelValidateEntry } from '@agents-io/protocol';
import { bridgeChannelModule } from '@agents-io/channel-jsonl-bridge';
import { larkBotChannelModule } from '@agents-io/channel-lark-bot';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { builtinChannels, builtinHarnesses } from '../src/bundle.js';
import { ChannelRegistry, CORE_CHANNEL_IDS } from '../src/channel-registry.js';
import { ConfigError, ConfigFile, configFileSchema, RESERVED_CHANNEL_IDS, resolveConfig, type HarnessInstance } from '../src/config.js';
import { exitCodeFor } from '../src/cli.js';
import { ConfigStore, isCredential } from '../src/console-config.js';
import { Gateway, InstanceHarness } from '../src/gateway.js';
import { cleanups, tmp } from './helpers.js';

/*
 * Channel types come from a registry (`ChannelModule`s; bundle.ts registers lark-bot, mail, bridge
 * and module): the config's `channels[].type`, each type's keys (closed), how an entry resolves and
 * the rules across a type's entries, and the channel ids no other entry may take.
 */

type ChatEntry = { type: 'chat'; room: string; token?: string };
const resolved: ChannelResolveContext[] = [];
const validated: ChannelValidateEntry<ChatEntry, ChatEntry>[][] = [];

const chat: ChannelModule<ChatEntry> = {
  type: 'chat',
  ids: ['chat'],
  entry: { room: Type.String(), token: Type.Optional(Type.String()) },
  resolve: (entry, ctx) => {
    resolved.push(ctx);
    if (entry.room === '') ctx.fail(`${ctx.where}.room must not be empty`);
    // Keys it leaves out (room, the common ones) are kept; the host sets `account`.
    return entry.token !== undefined ? { type: 'chat', room: entry.room, token: ctx.substitute(entry.token, `${ctx.where}.token`) as string } : entry;
  },
  validateAll: (all, ctx) => {
    validated.push([...all]);
    const rooms = new Set<string>();
    for (const x of all) {
      if (rooms.has(x.resolved.room)) ctx.fail(`channels[${x.index}]: room ${x.resolved.room} twice`);
      rooms.add(x.resolved.room);
    }
    if (all.length === 1) ctx.warn(`channels[${all[0]!.index}]: one chat only`);
  },
  create: () => ({ adapter: new FakeChannel() }),
};
const registry = new ChannelRegistry([chat, bridgeChannelModule]);
const resolve = (channels: unknown[], env: Record<string, string> = {}) => resolveConfig({ channels }, { env, baseDir: '/base', cwd: '/work', channelRegistry: registry });
const message = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('no error');
};

describe('channel registry', () => {
  it('the built-in registry is lark-bot, mail, bridge, module; its ids and the daemon\'s are reserved; ConfigFile is its schema', () => {
    expect(builtinChannels.types).toEqual(['lark-bot', 'mail', 'bridge', 'module']);
    expect(CORE_CHANNEL_IDS).toEqual(['local', 'agent']);
    expect(builtinChannels.reservedIds).toEqual(['lark-bot', 'mail', 'local', 'agent']);
    expect(RESERVED_CHANNEL_IDS).toBe(builtinChannels.reservedIds);
    expect(configFileSchema(builtinHarnesses)).toBe(ConfigFile);
    expect(configFileSchema(builtinHarnesses, builtinChannels)).toBe(ConfigFile);
    expect(configFileSchema(builtinHarnesses, registry)).toBe(configFileSchema(builtinHarnesses, registry));
    expect(configFileSchema(builtinHarnesses, registry)).not.toBe(ConfigFile);
  });

  it('an entry resolves through its type: substitution with the entry\'s place, kept keys, the account; the type\'s rules see its entries only', () => {
    resolved.length = 0;
    validated.length = 0;
    const c = resolve([{ type: 'chat', room: 'r', token: 'env:T', tier: 'final' }, { type: 'bridge', command: 'peer', id: 'p' }, { type: 'chat', room: 'q', account: 'b' }], { T: 'tok' });
    expect(c.channels).toEqual([
      { type: 'chat', room: 'r', token: 'tok', tier: 'final', account: 'default' },
      { type: 'bridge', command: 'peer', id: 'p', account: 'default' },
      { type: 'chat', room: 'q', account: 'b' },
    ]);
    expect(resolved.map((x) => [x.index, x.where])).toEqual([
      [0, 'channels[0]'],
      [2, 'channels[2]'],
    ]);
    expect(resolved[0]!.path('x')).toBe('/base/x');
    expect(validated).toHaveLength(1);
    expect(validated[0]!.map((x) => [x.index, x.entry, x.resolved.account])).toEqual([
      [0, { type: 'chat', room: 'r', token: 'env:T', tier: 'final' }, 'default'],
      [2, { type: 'chat', room: 'q', account: 'b' }, 'b'],
    ]);
    expect(c.warnings).toBeUndefined();
    expect(resolve([{ type: 'chat', room: 'r' }]).warnings).toEqual(['channels[0]: one chat only']);
  });

  it('the schema is the registry\'s: closed entries, only its types; resolve and validateAll fail the config', () => {
    expect(message(() => resolve([{ type: 'chat', room: 'r', extra: 1 }]))).toMatch(/^invalid config/);
    expect(message(() => resolve([{ type: 'chat' }]))).toMatch(/^invalid config/);
    expect(message(() => resolve([{ type: 'lark-bot' }]))).toMatch(/^invalid config/);
    expect(message(() => resolve([{ type: 'chat', room: '' }]))).toBe('channels[0].room must not be empty');
    expect(message(() => resolve([{ type: 'chat', room: 'r', token: 'env:NOPE' }]))).toBe('channels[0].token: environment variable NOPE is not set');
    expect(message(() => resolve([{ type: 'chat', room: 'r' }, { type: 'chat', room: 'r', account: 'b' }]))).toBe('channels[1]: room r twice');
    // The built-in registry knows none of this registry's types.
    expect(() => resolveConfig({ channels: [{ type: 'chat', room: 'r' }] }, { env: {}, baseDir: '/base' })).toThrow(/^invalid config/);
  });

  it('a registered type\'s ids are reserved: a bridge cannot take one', () => {
    expect(registry.reservedIds).toEqual(['chat', 'local', 'agent']);
    expect(message(() => resolve([{ type: 'bridge', command: 'peer', id: 'chat' }]))).toBe('channels[0]: bridge id "chat" is a built-in channel id; a bridge cannot use it');
    expect(message(() => resolve([{ type: 'bridge', command: 'peer', id: 'agent' }]))).toBe('channels[0]: bridge id "agent" is a built-in channel id; a bridge cannot use it');
    // Not registered here, so not reserved here.
    expect(resolve([{ type: 'bridge', command: 'peer', id: 'mail' }]).channels).toHaveLength(1);
  });

  it('refuses a type twice, an id that is the daemon\'s or another type\'s, and an entry key every entry has', () => {
    expect(() => new ChannelRegistry([chat, chat])).toThrow('channel type "chat" is registered twice');
    expect(() => new ChannelRegistry([{ ...chat, ids: ['local'] }])).toThrow('channel type "chat": channel id "local" is the daemon\'s own');
    expect(() => new ChannelRegistry([chat, { ...chat, type: 'chat2' }])).toThrow('channel types "chat" and "chat2" both declare channel id "chat"');
    expect(() => new ChannelRegistry([{ ...chat, type: '' }])).toThrow('a channel module needs a non-empty type');
    const taken = new ChannelRegistry([{ ...chat, entry: { ...chat.entry, account: Type.String() } }]);
    expect(() => configFileSchema(builtinHarnesses, taken)).toThrow('channel type "chat": every channel entry has "account"; its module cannot declare it');
  });

  it('refuses a module whose members are not a ChannelModule\'s, so what passes the config can be built', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ create: undefined }, 'create (a function)'],
      [{ resolve: 'entry' }, 'resolve (a function)'],
      [{ entry: undefined }, 'entry (an object of schemas)'],
      [{ owner: 'me' }, 'owner (a function when present)'],
      [{ credentialHint: 'use env' }, 'credentialHint (a function when present)'],
      [{ ids: 'chat' }, 'ids (an array of non-empty strings when present)'],
      [{ ids: [''] }, 'ids (an array of non-empty strings when present)'],
    ];
    for (const [members, what] of cases) expect(() => new ChannelRegistry([{ ...chat, ...members } as unknown as ChannelModule]), what).toThrow(`channel type "chat": bad ${what}`);
  });
});

describe('the gateway builds configured channels through the registry', () => {
  class Probe extends FakeChannel {
    config: unknown;
    closed = false;
    override async start(ctx: ChannelContext): Promise<void> {
      this.config = ctx.config;
      return super.start(ctx);
    }
  }

  it('create gets the resolved entry with its account, its index, its config and a state directory per type and account; the built config reaches start; close runs at stop', async () => {
    const calls: { entry: unknown; init: ChannelInit }[] = [];
    const made: Probe[] = [];
    const probe: ChannelModule<{ type: 'probe'; config?: unknown }> = {
      type: 'probe',
      entry: { config: Type.Optional(Type.Unknown()) },
      resolve: (entry, ctx) => ({ ...entry, ...(entry.config !== undefined ? { config: ctx.substitute(entry.config, `${ctx.where}.config`) } : {}) }),
      create(entry, init) {
        calls.push({ entry, init });
        const adapter = new Probe('probe');
        made.push(adapter);
        return { adapter, config: { built: entry.account }, close: async () => void (adapter.closed = true) };
      },
    };
    const registry = new ChannelRegistry([bridgeChannelModule, probe as ChannelModule]);
    const dir = tmp('aio-creg-');
    mkdirSync(join(dir, 'work'), { recursive: true });
    const base = resolveConfig(
      { dataDir: dir, local: { principal: 'me' }, cwd: join(dir, 'work'), channels: [{ type: 'probe', config: { k: 'env:K' } }, { type: 'probe', account: 'a b', tier: 'final' }] },
      { env: { K: 'v' }, baseDir: dir, cwd: dir, channelRegistry: registry },
    );
    const gw = await Gateway.start({ config: { ...base, socketPath: join(dir, 'run', 'aio.sock') }, buildHarness: (i: HarnessInstance) => new InstanceHarness(i, new FakeHarness()), channelRegistry: registry, logger: () => {}, listen: false });
    cleanups.push(() => gw.stop());
    expect(gw.channelRegistry).toBe(registry);
    expect(calls.map((c) => c.entry)).toEqual([
      { type: 'probe', config: { k: 'v' }, account: 'default' },
      { type: 'probe', account: 'a b', tier: 'final' },
    ]);
    expect(calls.map((c) => [c.init.index, c.init.account, c.init.config, c.init.stateDir])).toEqual([
      [0, 'default', { k: 'v' }, join(dir, 'channels', 'probe.default')],
      [1, 'a b', undefined, join(dir, 'channels', 'probe.a%20b')],
    ]);
    expect(made.map((m) => m.config)).toEqual([{ built: 'default' }, { built: 'a b' }]);
    expect(gw.adminStatus().channels.filter((c) => c.id === 'probe').map((c) => c.account)).toEqual(['default', 'a b']);
    await gw.stop();
    expect(made.map((m) => m.closed)).toEqual([true, true]);
  });

  it('an entry the gateway cannot build fails the start as a config error (exit 2), naming the entry and its type', async () => {
    const start = async (create: ChannelModule['create'], o: { gatewayRegistry?: boolean } = {}) => {
      const dir = tmp('aio-creg-');
      const registry = new ChannelRegistry([bridgeChannelModule, { type: 'probe', entry: {}, resolve: (e) => e, create }]);
      const base = resolveConfig({ dataDir: dir, local: { principal: 'me' }, channels: [{ type: 'bridge', command: 'peer', id: 'peer' }, { type: 'probe' }] }, { env: {}, baseDir: dir, cwd: dir, channelRegistry: registry });
      const gw = await Gateway.start({
        config: { ...base, socketPath: join(dir, 'run', 'aio.sock') },
        buildHarness: (i: HarnessInstance) => new InstanceHarness(i, new FakeHarness()),
        ...(o.gatewayRegistry === false ? {} : { channelRegistry: registry }),
        // The bridge is the embedder's here: only the probe entry is built by its type.
        channelAdapter: (ch) => (ch.type === 'bridge' ? new FakeChannel('peer') : undefined),
        logger: () => {},
        listen: false,
      });
      await gw.stop();
    };
    const configError = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect(exitCodeFor(e)).toBe(2);
        return (e as Error).message;
      }
      throw new Error('started');
    };
    const ok = () => ({ adapter: new FakeChannel('probe') });
    await start(ok);
    // Resolved with a registry that has the type, started with one that lacks it (the built-in one).
    expect(await configError(start(ok, { gatewayRegistry: false }))).toBe('channels[1]: channel type "probe" is not registered with the gateway; give Gateway.start the channel registry the config was resolved with');
    const bad = (what: string) => `channels[1]: channel type "probe": create did not return a channel (bad ${what})`;
    expect(await configError(start((() => undefined) as never))).toBe(bad('value (an object with an adapter)'));
    expect(await configError(start((() => ({})) as never))).toBe(bad('adapter.id (a non-empty string)'));
    expect(await configError(start((() => ({ adapter: { id: 'probe', caps: () => ({}), start: async () => {} } })) as never))).toBe(bad('adapter.send'));
    let closed = 0;
    expect(await configError(start((() => ({ adapter: new FakeChannel('probe'), close: async () => void closed++, idKnown: true })) as never))).toBe(bad('idKnown (a function when present)'));
    // What it built is closed when it can be.
    expect(closed).toBe(1);
    expect(await configError(start((() => ({ adapter: new FakeChannel('probe'), close: 'later' })) as never))).toBe(bad('close (a function when present)'));
    // A create that throws fails the start with its own error.
    await expect(start(() => Promise.reject(new TypeError('no probe here')))).rejects.toThrow(new TypeError('no probe here'));
  });

  it('an entry of a type the gateway\'s registry lacks fails the start, naming the entry', async () => {
    const registry = new ChannelRegistry([{ type: 'probe', entry: {}, resolve: (e) => e, create: () => ({ adapter: new FakeChannel('probe') }) }]);
    const dir = tmp('aio-creg-');
    const base = resolveConfig({ dataDir: dir, local: { principal: 'me' }, channels: [{ type: 'probe' }] }, { env: {}, baseDir: dir, cwd: dir, channelRegistry: registry });
    await expect(Gateway.start({ config: { ...base, socketPath: join(dir, 'run', 'aio.sock') }, buildHarness: (i: HarnessInstance) => new InstanceHarness(i, new FakeHarness()), logger: () => {}, listen: false })).rejects.toThrow(
      'channels[0]: channel type "probe" is not registered with the gateway; give Gateway.start the channel registry the config was resolved with',
    );
  });
});

describe('what the registry says of an entry', () => {
  it('owner: `<type>:<owner>`, else the type; idOf: the module\'s, else the one declared id; mayUse: reserved ids only for their type', () => {
    expect(builtinChannels.owner({ type: 'lark-bot' })).toBe('lark-bot');
    expect(builtinChannels.owner({ type: 'bridge', command: 'node', args: ['peer.js'] })).toBe('bridge:["node",["peer.js"]]');
    expect(builtinChannels.owner({ type: 'bridge', command: 'node' })).toBe('bridge:["node",[]]');
    expect(builtinChannels.owner({ type: 'module', module: '/m.js' })).toBe('module:["/m.js",null]');
    expect(builtinChannels.owner({ type: 'module', module: '/m.js', export: 'x' })).toBe('module:["/m.js","x"]');
    expect(['lark-bot', 'mail', 'module'].map((type) => builtinChannels.idOf({ type }))).toEqual(['lark-bot', 'mail', undefined]);
    expect([builtinChannels.idOf({ type: 'bridge', id: 'web' }), builtinChannels.idOf({ type: 'bridge' })]).toEqual(['web', undefined]);
    expect(builtinChannels.mayUse('lark-bot', 'lark-bot')).toBe(true);
    expect(builtinChannels.mayUse('lark-bot', 'mail')).toBe(false);
    expect(builtinChannels.mayUse('bridge', 'lark-bot')).toBe(false);
    expect(builtinChannels.mayUse('module', 'local')).toBe(false);
    expect(builtinChannels.mayUse('module', 'web')).toBe(true);
  });

  it('defaultEvidence: only for a registered type, only caps or ungranted', () => {
    expect(() => new ChannelRegistry([chat], { defaultEvidence: { other: 'caps' } })).toThrow('defaultEvidence: channel type "other" is not registered');
    expect(() => new ChannelRegistry([chat], { defaultEvidence: { chat: 'all' as never } })).toThrow('defaultEvidence: channel type "chat": "all" is neither "caps" nor "ungranted"');
    expect(new ChannelRegistry([chat]).defaultEvidence('chat')).toBe('ungranted');
    expect(new ChannelRegistry([chat], { defaultEvidence: { chat: 'caps' } }).defaultEvidence('chat')).toBe('caps');
  });

  it('credentials of the built-in types: a bridge\'s env (marked) and an argument after a secret flag, mail auth, a Lark app\'s secrets; not in another type\'s entry', () => {
    const doc = {
      channels: [
        { type: 'bridge', command: 'p', args: ['--token', 'a', '--api-key=b', '-v', 'c'], env: { X: 'x' } },
        { type: 'mail', config: { imap: { auth: { pass: 'p', user: 'u' } }, smtp: { auth: { accessToken: 't' } } } },
        { type: 'lark-bot', config: { appId: 'i', appSecret: 's', encryptKey: 'e', verificationToken: 'v', look: 'chat' } },
        { type: 'module', module: 'm', config: { encryptKey: 'e', env: { X: 'x' } } },
      ],
    };
    const at = (...p: (string | number)[]) => isCredential(doc, ['channels', ...p]);
    expect([at(0, 'args', 1), at(0, 'args', 2), at(0, 'args', 3), at(0, 'args', 4), at(0, 'env', 'X'), at(0, 'env'), at(0, 'command')]).toEqual([true, true, false, false, true, true, false]);
    expect([at(1, 'config', 'imap', 'auth', 'pass'), at(1, 'config', 'imap', 'auth', 'user'), at(1, 'config', 'smtp', 'auth', 'accessToken')]).toEqual([true, false, true]);
    expect(['appId', 'appSecret', 'encryptKey', 'verificationToken', 'look'].map((k) => at(2, 'config', k))).toEqual([false, true, true, true, false]);
    // A module's config is free-form: only secret-looking keys.
    expect([at(3, 'config', 'encryptKey'), at(3, 'config', 'env', 'X')]).toEqual([false, false]);
    // Another registry: its types' marks only (a lark-bot entry there is just free-form).
    const other = new ChannelRegistry([bridgeChannelModule]);
    expect([isCredential(doc, ['channels', 0, 'env', 'X'], other), isCredential(doc, ['channels', 2, 'config', 'encryptKey'], other)]).toEqual([true, false]);
    expect(isCredential(doc, ['channels', 2, 'config', 'encryptKey'], new ChannelRegistry([larkBotChannelModule]))).toBe(true);
  });

  it('a literal credential is answered with its type\'s advice where it has one (credentialHint: a bridge argument), else the host\'s', () => {
    const vault: ChannelModule = {
      type: 'vault',
      entry: { code: Type.String({ 'x-credential': true }), pin: Type.Optional(Type.String({ 'x-credential': true })) },
      credentialHint: (path) => (path[0] === 'code' ? 'vault codes come from the vault agent' : undefined),
      resolve: (e) => e,
      create: () => ({ adapter: new FakeChannel('vault') }),
    };
    const dir = tmp('aio-creg-');
    const path = join(dir, 'aio.config.json');
    const channels = [
      { type: 'bridge', command: 'p', args: ['--token', 'a'] },
      { type: 'vault', code: 'c-1', pin: 'p-2' },
    ];
    writeFileSync(path, JSON.stringify({ channels }), { mode: 0o600 });
    const s = new ConfigStore({ path, env: {}, channelRegistry: new ChannelRegistry([bridgeChannelModule, vault]) });
    const inline = (issues: { code: string; path: string; message: string; severity: string }[]) => issues.filter((i) => i.code === 'inline_secret').map((i) => [i.path, i.severity, i.message]);
    const bridgeArg = 'a secret on the bridge command line is visible to other local users (ps); pass it in the bridge env ("env": { "NAME": "env:NAME" })';
    // Stored in the file: warnings.
    expect(inline(s.document().issues)).toEqual([
      ['/channels/0/args/1', 'warning', bridgeArg],
      ['/channels/1/code', 'warning', 'vault codes come from the vault agent'],
      ['/channels/1/pin', 'warning', 'a literal secret is stored in the config file; move it to the env file and reference it as "env:NAME"'],
    ]);
    // New ones: errors, the same advice.
    expect(inline(s.validate({ channels }).issues)).toEqual([
      ['/channels/0/args/1', 'error', bridgeArg],
      ['/channels/1/code', 'error', 'vault codes come from the vault agent'],
      ['/channels/1/pin', 'error', 'secrets do not go into the config file: put the value in the env file (or the environment) and write "env:NAME"'],
    ]);
  });
});
