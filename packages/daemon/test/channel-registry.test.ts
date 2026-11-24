import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { ADMIN_REDACTED, type ChannelModule } from '@agents-io/protocol';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { builtinChannels } from '../src/bundle.js';
import { ChannelRegistry, type GatewayOptions, type HarnessInstance } from '@agents-io/kernel';
import { ConfigStore, Gateway, InstanceHarness, resolveConfig } from '../src/defaults.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * The gateway builds configured channels through the channel registry (core-slimming G2): the
 * evidence an entry gives without a grant is what the composition root registered its type with
 * (never the module's own claim), an entry's channel id belongs to its type, and the console's
 * credentials in a channel entry are the ones its type marks.
 */

/** A type whose adapter is a FakeChannel with channel id `id` (default the type), kept in `made`. */
function fakeType(type: string, o: { id?: string; ids?: string[]; owner?: string; extra?: Record<string, unknown> } = {}) {
  const made: FakeChannel[] = [];
  const m: ChannelModule = {
    type,
    ...(o.ids ? { ids: o.ids } : {}),
    entry: {},
    resolve: (entry) => entry,
    ...(o.owner !== undefined ? { owner: () => o.owner! } : {}),
    create: () => {
      const ch = new FakeChannel(o.id ?? type);
      made.push(ch);
      return { adapter: ch };
    },
    ...o.extra,
  };
  return { m, made };
}

async function start(channels: unknown[], o: { registry?: ChannelRegistry; owners?: string[]; env?: Record<string, string>; channelAdapter?: GatewayOptions['channelAdapter'] } = {}) {
  const dir = tmp('aio-creg-');
  mkdirSync(join(dir, 'work'), { recursive: true });
  const raw = { dataDir: dir, policy: { owners: o.owners ?? [] }, local: { principal: 'me' }, cwd: join(dir, 'work'), channels };
  const base = resolveConfig(raw, { env: o.env ?? {}, baseDir: dir, cwd: dir, ...(o.registry ? { channelRegistry: o.registry } : {}) });
  const gw = await Gateway.start({
    config: { ...base, socketPath: join(dir, 'run', 'aio.sock') },
    buildHarness: (i: HarnessInstance) => new InstanceHarness(i, new FakeHarness()),
    ...(o.registry ? { channelRegistry: o.registry } : {}),
    ...(o.channelAdapter ? { channelAdapter: o.channelAdapter } : {}),
    logger: () => {},
    listen: false,
  });
  cleanups.push(() => gw.stop());
  return gw;
}

const signed = (id: string) => ({ id, sender: { channelUserId: 'alice', evidence: 'platform_signed' as const }, conversation: { id: 'dm1', kind: 'dm' as const }, text: 'hi' });

describe('the default evidence grant is the composition root\'s (channel-stamping E3)', () => {
  it('built-in: lark-bot and mail are registered with their caps; bridge and module without; a lark-bot entry gives its caps #ID-3 #ID-4', async () => {
    expect(builtinChannels.types.map((t) => [t, builtinChannels.defaultEvidence(t)])).toEqual([
      ['lark-bot', 'caps'],
      ['mail', 'caps'],
      ['bridge', 'ungranted'],
      ['module', 'ungranted'],
    ]);
    const lark = new FakeChannel('lark-bot');
    const gw = await start([{ type: 'lark-bot' }], {
      owners: ['lark-bot:alice'],
      env: { LARK_APP_ID: 'cli_x', LARK_APP_SECRET: 'sec' },
      channelAdapter: (ch) => (ch.type === 'lark-bot' ? lark : undefined),
    });
    await lark.inject(signed('ev-l'));
    await until(() => gw.records.verify('channel:lark-bot/ev-l').found);
    expect(gw.records.verify('channel:lark-bot/ev-l').records).toEqual([expect.objectContaining({ evidence: 'platform_signed', principal: 'lark-bot:alice' })]);
  });

  it('a type registered with caps gives them; one registered without gives device_only, also when its module claims caps itself #ID-3 #ID-4', async () => {
    const trusted = fakeType('trusted');
    const plain = fakeType('plain');
    // A module has no say in its trust: a field of its own is not the registration's.
    const selfish = fakeType('selfish', { extra: { defaultEvidence: 'caps' } });
    const registry = new ChannelRegistry([trusted.m, plain.m, selfish.m], { defaultEvidence: { trusted: 'caps' } });
    expect(registry.defaultEvidence('selfish')).toBe('ungranted');
    const gw = await start([{ type: 'trusted' }, { type: 'plain' }, { type: 'selfish' }], { registry, owners: ['trusted:alice', 'plain:alice', 'selfish:alice'] });
    for (const [t, x] of [
      ['trusted', trusted],
      ['plain', plain],
      ['selfish', selfish],
    ] as const) {
      expect((await x.made[0]!.inject(signed(`ev-${t}`))).accepted).toBe(true);
      await until(() => gw.records.verify(`channel:${t}/ev-${t}`).found);
    }
    expect(gw.records.verify('channel:trusted/ev-trusted').records).toEqual([expect.objectContaining({ evidence: 'platform_signed', principal: 'trusted:alice' })]);
    expect(gw.records.verify('channel:plain/ev-plain').records).toEqual([expect.objectContaining({ evidence: 'none', principal: null })]);
    expect(gw.records.verify('channel:selfish/ev-selfish').records).toEqual([expect.objectContaining({ evidence: 'none', principal: null })]);
    const capped = (id: string) => gw.adminStatus().channels.find((c) => c.id === id)?.evidenceCapped;
    expect([capped('trusted'), capped('plain'), capped('selfish')]).toEqual([undefined, 1, 1]);
    // The entry's own grant still opens it (∩ caps).
    const granted = fakeType('plain');
    const gw2 = await start([{ type: 'plain', evidence: ['platform_signed'] }], { registry: new ChannelRegistry([granted.m]), owners: ['plain:alice'] });
    await granted.made[0]!.inject(signed('ev-g'));
    await until(() => gw2.records.verify('channel:plain/ev-g').found);
    expect(gw2.records.verify('channel:plain/ev-g').records).toEqual([expect.objectContaining({ evidence: 'platform_signed', principal: 'plain:alice' })]);
  });

  it('the keys every entry has are the host\'s: what a module\'s resolve returns for evidence, type or ack, or what its create does to the entry, does not count #ID-3 #ID-4', async () => {
    // resolve grants itself, renames its type and turns ack on; create grants itself on the entry it got.
    const resolving = fakeType('resolving', { extra: { resolve: (e: Record<string, unknown>) => ({ ...e, type: 'trusted', evidence: ['platform_signed'], ack: true, mine: 1 }) } });
    const creating = fakeType('creating');
    const create = creating.m.create;
    creating.m = {
      ...creating.m,
      create: (entry, init) => {
        (entry as { evidence?: string[] }).evidence = ['platform_signed'];
        return create(entry, init);
      },
    };
    const trusted = fakeType('trusted');
    const registry = new ChannelRegistry([resolving.m, creating.m, trusted.m], { defaultEvidence: { trusted: 'caps' } });
    const raw = { policy: { owners: ['resolving:alice', 'creating:alice'] }, channels: [{ type: 'resolving' }, { type: 'resolving', account: 'b', evidence: ['device_only'] }, { type: 'creating' }] };
    const config = resolveConfig(raw, { env: {}, baseDir: '/base', cwd: '/work', channelRegistry: registry });
    expect(config.channels).toEqual([
      { type: 'resolving', account: 'default', mine: 1 },
      { type: 'resolving', account: 'b', evidence: ['device_only'], mine: 1 },
      { type: 'creating', account: 'default' },
    ]);
    const gw = await start(raw.channels, { registry, owners: raw.policy.owners });
    await resolving.made[0]!.inject(signed('ev-r'));
    await creating.made[0]!.inject(signed('ev-c'));
    await until(() => gw.records.verify('channel:resolving/ev-r').found && gw.records.verify('channel:creating/ev-c').found);
    expect(gw.records.verify('channel:resolving/ev-r').records).toEqual([expect.objectContaining({ evidence: 'none', principal: null })]);
    expect(gw.records.verify('channel:creating/ev-c').records).toEqual([expect.objectContaining({ evidence: 'none', principal: null })]);
    expect(gw.config.channels.map((c) => c.evidence)).toEqual([undefined, ['device_only'], undefined]);
  });
});

describe('an entry\'s channel id belongs to its type (channel-stamping F4)', () => {
  it('owners are named by type: two types saying the same owner still conflict on one id; a declared id is only its type\'s #ID-3', async () => {
    const a = fakeType('a', { id: 'shared', owner: 'p' });
    const b = fakeType('b', { id: 'shared', owner: 'p' });
    await expect(start([{ type: 'a' }, { type: 'b', account: 'x' }], { registry: new ChannelRegistry([a.m, b.m]) })).rejects.toThrow('channel id "shared" belongs to a:p; b:p cannot use it too (one channel id is one adapter, only accounts differ)');
    // One type, one owner: several accounts.
    const gw = await start([{ type: 'a' }, { type: 'a', account: 'x' }], { registry: new ChannelRegistry([fakeType('a', { id: 'shared', owner: 'p' }).m]) });
    expect(gw.adminStatus().channels.filter((c) => c.id === 'shared').map((c) => c.account)).toEqual(['default', 'x']);
    // `chat` is declared by its type: another type's adapter may not take it, the declaring type's may.
    const chat = fakeType('chat', { ids: ['chat'] });
    const thief = fakeType('thief', { id: 'chat' });
    await expect(start([{ type: 'thief' }], { registry: new ChannelRegistry([chat.m, thief.m]) })).rejects.toThrow('channel id "chat" is a built-in channel id; thief cannot use it');
    await expect(start([{ type: 'thief' }], { registry: new ChannelRegistry([chat.m, fakeType('thief', { id: 'agent' }).m]) })).rejects.toThrow('channel id "agent" is a built-in channel id; thief cannot use it');
    expect((await start([{ type: 'chat' }], { registry: new ChannelRegistry([fakeType('chat', { ids: ['chat'] }).m]) })).adminStatus().channels).toEqual([expect.objectContaining({ id: 'chat', state: 'running' })]);
  });

  it('a type name cannot say another type\'s owner or share its state directory: one with ":", ".", "/" or a space is refused at registration #ID-3', () => {
    // `a:b` with owner `c` would name the owner `a:b:c`, as `a` with owner `b:c` does; `a.b` with account `c` would share `channels/a.b.c` with `a`'s account `b.c`.
    for (const type of ['a:b', 'a.b', 'a/b', '..', 'a b', '-a', 'ä']) {
      expect(() => new ChannelRegistry([fakeType(type).m]), type).toThrow(`channel type ${JSON.stringify(type)}: a type name is ASCII letters, digits, "-" and "_", starting with a letter or digit (it names owners "<type>:<owner>" and state directories "<type>.<account>")`);
    }
    for (const type of ['chat', 'Chat_2', 'web-hook', '0x']) expect(new ChannelRegistry([fakeType(type).m]).types).toEqual([type]);
    // So an owner's type is the part before its first ":".
    const r = new ChannelRegistry([fakeType('a', { owner: 'b:c' }).m, fakeType('a-b', { owner: 'c' }).m]);
    expect([r.owner({ type: 'a' }), r.owner({ type: 'a-b' })]).toEqual(['a:b:c', 'a-b:c']);
  });

  it('two type names that differ only in letter case would share a state directory on a case-insensitive file system: the second is refused at registration #ID-3', () => {
    // `channels/Chat.default` and `channels/chat.default` are one directory on macOS's default file system.
    for (const [first, second] of [['chat', 'Chat'], ['Web-Hook', 'web-hook'], ['a_B', 'A_b']]) {
      expect(() => new ChannelRegistry([fakeType(first!).m, fakeType(second!).m]), second).toThrow(`channel type ${JSON.stringify(second)}: differs from the registered type ${JSON.stringify(first)} only in letter case (their state directories "<type>.<account>" are one on a case-insensitive file system)`);
    }
    // Against the built-in types too; names that differ otherwise are fine.
    expect(() => new ChannelRegistry([...builtinChannels.types.map((t) => builtinChannels.get(t)!), fakeType('Bridge').m])).toThrow('channel type "Bridge": differs from the registered type "bridge" only in letter case');
    expect(new ChannelRegistry([fakeType('chat').m, fakeType('chat2').m, fakeType('chat_').m]).types).toEqual(['chat', 'chat2', 'chat_']);
  });
});

describe('credentials in a channel entry are the ones its type marks', () => {
  it('x-credential marks (a string, a map, under a union) and isCredential: GET redacts them, PUT refuses literals there and keeps the rest readable #SE-1', async () => {
    const vault: ChannelModule = {
      type: 'vault',
      entry: {
        code: Type.Optional(Type.String({ 'x-credential': true })),
        host: Type.Optional(Type.String()),
        secrets: Type.Optional(Type.Record(Type.String(), Type.String(), { 'x-credential': true })),
        login: Type.Optional(Type.Union([Type.String(), Type.Object({ user: Type.String(), pin: Type.String({ 'x-credential': true }) })])),
        argv: Type.Optional(Type.Array(Type.String())),
      },
      // The argument after `--key`: a schema cannot say that.
      isCredential: (path, entry) => path[0] === 'argv' && (entry as { argv?: unknown[] }).argv?.[Number(path[1]) - 1] === '--key',
      resolve: (entry) => entry,
      create: () => ({ adapter: new FakeChannel('vault') }),
    };
    const registry = new ChannelRegistry([vault]);
    const dir = tmp('aio-creg-');
    const path = join(dir, 'aio.config.json');
    // None of these keys looks like a secret: only the type's marks make them credentials.
    const entry = { type: 'vault', code: 'tok-1', host: 'vault.lan', secrets: { A: 'sa-2' }, login: { user: 'me', pin: 'pw-3' }, argv: ['--key', 'k-4', '--verbose'] };
    writeFileSync(path, JSON.stringify({ channels: [entry] }), { mode: 0o600 });
    const s = new ConfigStore({ path, env: {}, channelRegistry: registry });
    const doc = await s.document();
    expect(JSON.stringify(doc)).not.toMatch(/tok-1|sa-2|pw-3|k-4/);
    expect(doc.config.channels).toEqual([{ type: 'vault', code: ADMIN_REDACTED, host: 'vault.lan', secrets: { A: ADMIN_REDACTED }, login: { user: 'me', pin: ADMIN_REDACTED }, argv: ['--key', ADMIN_REDACTED, '--verbose'] }]);
    expect(doc.issues.filter((i) => i.code === 'inline_secret').map((i) => [i.path, i.severity])).toEqual([
      ['/channels/0/code', 'warning'],
      ['/channels/0/secrets/A', 'warning'],
      ['/channels/0/login/pin', 'warning'],
      ['/channels/0/argv/1', 'warning'],
    ]);
    const before = readFileSync(path, 'utf8');
    for (const [where, set] of [
      ['/channels/0/code', (c: any) => (c.channels[0].code = 'new')],
      ['/channels/0/secrets/B', (c: any) => (c.channels[0].secrets.B = 'new')],
      ['/channels/0/login/pin', (c: any) => (c.channels[0].login.pin = 'new')],
      ['/channels/0/argv/1', (c: any) => (c.channels[0].argv[1] = 'new')],
    ] as const) {
      const next = structuredClone(doc.config) as any;
      set(next);
      const r = await s.put(next, doc.revision);
      expect(r.status, where).toBe(422);
      expect(r.status === 422 && r.body.issues, where).toContainEqual(expect.objectContaining({ path: where, code: 'inline_secret', severity: 'error' }));
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
    // Not marked: a literal is fine, and the marker cannot copy a stored secret there.
    const moved = structuredClone(doc.config) as any;
    moved.channels[0].host = ADMIN_REDACTED;
    expect((await s.validate(moved)).issues).toContainEqual(expect.objectContaining({ path: '/channels/0/host', code: 'redacted_without_value' }));
    // Sent back as GET showed it, every stored value is kept.
    expect((await s.put(structuredClone(doc.config) as any, doc.revision)).status).toBe(200);
    expect(JSON.parse(readFileSync(path, 'utf8')).channels[0]).toEqual(entry);
  });
});
