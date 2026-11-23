import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import type { ChannelModule, ChannelResolveContext, ChannelValidateEntry } from '@agents-io/protocol';
import { bridgeChannelModule } from '@agents-io/channel-jsonl-bridge';
import { FakeChannel } from '@agents-io/testkit';
import { builtinChannels, builtinHarnesses } from '../src/bundle.js';
import { ChannelRegistry, CORE_CHANNEL_IDS } from '../src/channel-registry.js';
import { ConfigError, ConfigFile, configFileSchema, RESERVED_CHANNEL_IDS, resolveConfig } from '../src/config.js';

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
});
