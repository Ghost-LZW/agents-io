import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEnvelope } from '@agents-io/testkit';
import type { Binding, BindingMatch, BindingTable, IdentityEntry, InboundEnvelope, InputRecord, Origin, Watch } from '@agents-io/protocol';
import { IdentityMap, Router, RouterError, matches, ownerIdentities, ownersTable, type AgentSpec, type CalloutAnswer, type RouterOptions } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDb = () => {
  const d = mkdtempSync(join(tmpdir(), 'aio-router-'));
  dirs.push(d);
  return join(d, 'r.sqlite');
};

const AGENTS: AgentSpec[] = [{ name: 'assistant' }, { name: 'ops', sessionPrefix: 'ops/', mainSession: 'ops-home' }, { name: 'executor', mode: 'task' }];
const OWNER: Origin = { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' };
const MEMBER: Origin = { ...OWNER, principal: { id: 'u-7', labels: ['member', 'oncall'] } };
const UNKNOWN: Origin = { ...OWNER, principal: null };
const SELF: Origin = { kind: 'agent', principal: null, self: true, evidence: 'platform_signed', via: 'fake:default:g1', adapter: 'fake' };
const group = { id: 'g1', kind: 'group' as const };

const table = (bindings: Binding[], extra: Partial<BindingTable> = {}): BindingTable => ({ version: 'v1', bindings, identities: [], ...extra });
const router = (o: Partial<RouterOptions> = {}) => new Router({ agents: AGENTS, defaultAgent: 'assistant', ...o });
const inputOf = (env: InboundEnvelope, origin: Origin, id = 'in1'): InputRecord => ({ inputId: id, origin, content: env.content, replyRoute: env.replyRoute, channelContext: {} });
const route = (r: Router, env: InboundEnvelope, origin: Origin = OWNER, id?: string) => r.route(env, origin, inputOf(env, origin, id));

describe('binding match fields', () => {
  const env = fakeEnvelope({
    channel: 'lark',
    account: 'bot1',
    conversation: { id: 'oc_1', kind: 'group', threadId: 't1' },
    sender: { channelUserId: 'ou_a', evidence: 'platform_signed' },
    text: 'The deploy is BROKEN',
    mentions: [{ id: 'ou_x' }, { id: 'ou_bot' }],
  });
  const m = (match: BindingMatch, origin: Origin = MEMBER, e: InboundEnvelope = env) => matches(match, e, origin, new Set(['lark:ou_bot']));

  it('channel, account, conversation, conversationKind, senders #RT-1', () => {
    expect(m({})).toBe(true);
    expect(m({ channel: 'lark' })).toBe(true);
    expect(m({ channel: 'mail' })).toBe(false);
    expect(m({ account: 'bot1' })).toBe(true);
    expect(m({ account: 'bot2' })).toBe(false);
    expect(m({ conversation: 'oc_1' })).toBe(true);
    expect(m({ conversation: 'oc_2' })).toBe(false);
    expect(m({ conversationKind: 'group' })).toBe(true);
    expect(m({ conversationKind: 'dm' })).toBe(false);
    expect(m({ senders: ['ou_b', 'ou_a'] })).toBe(true);
    expect(m({ senders: ['ou_b'] })).toBe(false);
    expect(m({ senders: [] })).toBe(true); // empty = unset
    // Every field must hold.
    expect(m({ channel: 'lark', conversationKind: 'dm' })).toBe(false);
  });

  it('labels and principal come from the stamped origin (identity map) #RT-1 #ID-4', () => {
    expect(m({ labels: ['oncall'] })).toBe(true);
    expect(m({ labels: ['owner', 'member'] })).toBe(true);
    expect(m({ labels: ['owner'] })).toBe(false);
    expect(m({ labels: ['member'] }, UNKNOWN)).toBe(false);
    expect(m({ principal: 'u-7' })).toBe(true);
    expect(m({ principal: 'u-8' })).toBe(false);
    expect(m({ known: false })).toBe(false);
    expect(m({ known: false }, UNKNOWN)).toBe(true);
  });

  it('mentions: platform ids, and `self` = one of our own accounts or the adapter saying it is addressed #RT-1', () => {
    expect(m({ mentions: ['ou_x'] })).toBe(true);
    expect(m({ mentions: ['ou_y'] })).toBe(false);
    expect(m({ mentions: ['self'] })).toBe(true); // @ou_bot is ours
    const other = { ...env, mentions: [{ id: 'ou_x' }], admission: 'observe' as const };
    expect(m({ mentions: ['self'] }, MEMBER, other)).toBe(false);
    expect(m({ mentions: ['self'] }, MEMBER, { ...other, admission: 'dispatch' })).toBe(true); // lark: @bot or DM
    const { admission: _a, ...noHint } = other;
    expect(m({ mentions: ['self'] }, MEMBER, noHint as InboundEnvelope)).toBe(true); // mail, bridges: no hint = for us
  });

  it('keywords are case-insensitive substrings, any of them #RT-1', () => {
    expect(m({ keywords: ['broken'] })).toBe(true);
    expect(m({ keywords: ['fine', 'DEPLOY'] })).toBe(true);
    expect(m({ keywords: ['fine'] })).toBe(false);
  });

  it('actionPrefix matches card clicks whose action id starts with it #RT-1', () => {
    const click = fakeEnvelope({ content: [{ type: 'event', name: 'action', data: { actionId: 'xwo:approve:42' } }] });
    expect(m({ actionPrefix: 'xwo:' }, MEMBER, click)).toBe(true);
    expect(m({ actionPrefix: 'other:' }, MEMBER, click)).toBe(false);
    expect(m({ actionPrefix: 'xwo:' })).toBe(false); // not a click
  });

  it('own echoes only with includeSelf #ID-5 #RT-1', () => {
    expect(m({}, SELF)).toBe(false);
    expect(m({ includeSelf: true }, SELF)).toBe(true);
  });
});

describe('Router.route', () => {
  const env = (p: Parameters<typeof fakeEnvelope>[0] = {}) => fakeEnvelope({ conversation: group, sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi', ...p });

  it('fans out to every matching rule; per session the strongest action wins #RT-1 #EX-1', async () => {
    const r = router({
      config: table([
        { id: 'ctx-a', match: {}, on: 'context', session: { key: 'A' } },
        { id: 'dispatch-a', match: { labels: ['owner'] }, on: 'dispatch', session: { key: 'A' } },
        { id: 'ctx-b', match: {}, on: 'context', agent: 'ops', session: 'per-conversation' },
        { id: 'digest-b', match: {}, on: 'digest', agent: 'ops', session: 'per-conversation', digest: { everyMs: 1000 } },
        { id: 'ctx-b2', match: {}, on: 'context', agent: 'ops', session: 'per-conversation' },
      ]),
    });
    const d = await route(r, env());
    expect(d.deliveries.map((x) => [x.bindingId, x.on, x.sessionKey, x.agent])).toEqual([
      ['dispatch-a', 'dispatch', 'A', 'assistant'],
      ['digest-b', 'digest', 'ops/fake:default:g1', 'ops'],
    ]);
    // Every match is explained, including the ones a stronger rule overrode.
    expect(d.explanation.matched.map((x) => x.bindingId)).toEqual(['ctx-a', 'dispatch-a', 'ctx-b', 'digest-b', 'ctx-b2']);
    expect(d.explanation.tableVersions).toEqual(['v1']);
  });

  it('on a tie the earlier rule wins (config before host before watches) #RT-1', async () => {
    const r = router({ config: table([{ id: 'first', match: {}, on: 'context', session: { key: 'S' } }]), hostConnected: true });
    r.putHostTable(table([{ id: 'second', match: {}, on: 'context', session: { key: 'S' } }], { version: 'h1' }));
    const d = await route(r, env());
    expect(d.deliveries.map((x) => x.bindingId)).toEqual(['first']);
    expect(d.explanation.matched.map((x) => [x.bindingId, x.source])).toEqual([
      ['first', 'config'],
      ['second', 'host'],
    ]);
    expect(d.explanation.tableVersions).toEqual(['v1', 'h1']);
  });

  it('host and drop are independent of the session deliveries #RT-1', async () => {
    const r = router({
      config: table([
        { id: 'to-host', match: { keywords: ['invoice'] }, on: 'host' },
        { id: 'to-host-2', match: {}, on: 'host' },
        { id: 'quiet', match: {}, on: 'drop' },
        { id: 'ctx', match: {}, on: 'context' },
      ]),
    });
    const d = await route(r, env({ text: 'invoice attached' }));
    expect(d.host).toEqual({ bindingId: 'to-host', source: 'config' });
    expect(d.deliveries.map((x) => x.bindingId)).toEqual(['ctx']);
    expect(d.explanation.dropped).toBeUndefined();
    const only = router({ config: table([{ id: 'quiet', match: {}, on: 'drop' }]) });
    expect((await route(only, env())).explanation).toMatchObject({ dropped: 'drop_rule', matched: [{ bindingId: 'quiet', on: 'drop' }] });
  });

  it('drops (and explains) an input no rule matches, and adapter drops before any rule #EX-1 #RT-1', async () => {
    const logs: string[] = [];
    const r = router({ config: table([{ id: 'mail', match: { channel: 'mail' }, on: 'dispatch' }]), log: (_l, m) => logs.push(m) });
    const d = await route(r, env(), UNKNOWN, 'in-x');
    expect(d).toMatchObject({ deliveries: [], explanation: { inputId: 'in-x', matched: [], dropped: 'no_match', principal: null, evidence: 'platform_signed' } });
    expect(d.host).toBeUndefined();
    expect(logs.some((l) => l.includes('in-x') && l.includes('matched no binding'))).toBe(true);
    const all = router({ config: table([{ id: 'all', match: {}, on: 'dispatch' }]) });
    expect((await route(all, env({ admission: 'drop' }))).explanation).toMatchObject({ dropped: 'adapter', matched: [] });
  });

  it('never dispatches our own echoes (a rule with includeSelf records them as context) #ID-5', async () => {
    const r = router({ config: table([{ id: 'echo', match: { includeSelf: true }, on: 'dispatch', session: { key: 'S' } }]) });
    const d = await route(r, env(), SELF);
    expect(d.deliveries.map((x) => x.on)).toEqual(['context']);
  });

  it('resolves session scopes per agent #RT-1', async () => {
    const r = router({
      config: table([
        { id: 'main', match: {}, on: 'context', session: 'main' },
        { id: 'conv', match: {}, on: 'context' }, // default per-conversation
        { id: 'thread', match: {}, on: 'context', session: 'per-thread' },
        { id: 'key', match: {}, on: 'context', session: { key: 'fixed' } },
        { id: 'ops-main', match: {}, on: 'context', agent: 'ops', session: 'main' },
        { id: 'ops-thread', match: {}, on: 'context', agent: 'ops', session: 'per-thread' },
      ]),
    });
    const d = await route(r, env({ conversation: { id: 'g1', kind: 'thread', threadId: 't9' } }));
    expect(Object.fromEntries(d.deliveries.map((x) => [x.bindingId, x.sessionKey]))).toEqual({
      main: 'assistant:main',
      conv: 'assistant:fake:default:g1',
      thread: 'assistant:fake:default:g1:t9',
      key: 'fixed',
      'ops-main': 'ops-home',
      'ops-thread': 'ops/fake:default:g1:t9',
    });
  });

  it('rejects tables that target task agents or unknown agents, and other invalid tables #RT-1', () => {
    expect(() => router({ config: table([{ id: 'x', match: {}, on: 'dispatch', agent: 'executor' }]) })).toThrow(/task agent.*run\.start/);
    try {
      router({ config: table([{ id: 'x', match: {}, on: 'context', agent: 'executor' }]) });
    } catch (e) {
      expect(e).toBeInstanceOf(RouterError);
      expect((e as RouterError).code).toBe('task_agent');
    }
    expect(() => router({ config: table([{ id: 'x', match: {}, on: 'host', callout: { onFailure: 'dispatch' } }]), defaultAgent: 'executor' })).toThrow(/task agent/);
    expect(() => router({ config: table([{ id: 'x', match: {}, on: 'dispatch', agent: 'nobody' }]) })).toThrow(/unknown agent "nobody"/);
    expect(() => new Router({ agents: AGENTS, config: table([{ id: 'x', match: {}, on: 'dispatch' }]) })).toThrow(/no agent named and no defaultAgent/);
    expect(() => router({ config: table([{ id: 'x', match: {}, on: 'host' }, { id: 'x', match: {}, on: 'drop' }]) })).toThrow(/id used twice/);
    expect(() => router({ config: table([{ id: 'd', match: {}, on: 'digest' }]) })).toThrow(/digest\.everyMs/);
    expect(() => router({ config: { version: 'v', bindings: [{ id: 'x', match: {}, on: 'loud' }] } as never })).toThrow(/invalid config table/);
    // host and drop rules need no agent.
    expect(() => new Router({ agents: [], config: table([{ id: 'h', match: {}, on: 'host' }]) })).not.toThrow();
    // A rejected host table leaves the current one in place.
    const r = router({ hostConnected: true });
    r.putHostTable(table([{ id: 'ok', match: {}, on: 'host' }], { version: 'h1' }));
    expect(() => r.putHostTable(table([{ id: 'bad', match: {}, on: 'dispatch', agent: 'executor' }], { version: 'h2' }))).toThrow(RouterError);
    expect(r.hostTable()?.table.version).toBe('h1');
  });
});

describe('identity map', () => {
  const args = (channelUserId: string, evidence: 'platform_signed' | 'dkim_pass' | 'none' = 'platform_signed', extra: { declared?: string; isBot?: boolean } = {}) => ({
    channel: 'mail',
    account: 'default',
    channelUserId,
    evidence,
    ...extra,
  });
  const entries: IdentityEntry[] = [
    { channel: 'mail', channelUserId: 'boss@x.com', principal: 'u-1', labels: ['owner'] },
    { channel: 'mail', channelUserId: 'ops@x.com', principal: 'u-2', labels: ['oncall'], evidence: ['dkim_pass', 'none'] },
  ];

  it('stamps principal and labels only with accepted evidence (default platform_signed, dkim_pass) #ID-4', () => {
    const m = new IdentityMap([entries]);
    expect(m.identify(args('boss@x.com', 'dkim_pass'))).toEqual({ kind: 'human', principal: { id: 'u-1', labels: ['owner'] } });
    expect(m.identify(args('boss@x.com', 'none'))).toEqual({ kind: 'human', principal: null });
    expect(m.identify(args('ops@x.com', 'none'))).toMatchObject({ principal: { id: 'u-2' } });
    expect(m.identify(args('ops@x.com', 'platform_signed'))).toMatchObject({ principal: null });
    expect(m.identify(args('stranger@y.com', 'dkim_pass', { isBot: true }))).toEqual({ kind: 'agent', principal: null });
  });

  it('keeps the safety rules: self echoes, declarations only from agent accounts, never naming a member #ID-4 #ID-5', () => {
    const m = new IdentityMap([entries], { selfAccounts: ['mail:me@x.com'], agentAccounts: ['mail:bot@x.com'], isSelfDeclared: (d) => d.startsWith('runner:me/') });
    expect(m.identify(args('me@x.com', 'dkim_pass', { declared: 'runner:me/1' }))).toEqual({ kind: 'agent', principal: null, self: true, declared: 'runner:me/1' });
    expect(m.identify(args('bot@x.com', 'dkim_pass', { declared: 'runner:other/1' }))).toEqual({ kind: 'agent', principal: { id: 'runner:other/1', labels: ['agent'] }, declared: 'runner:other/1', trustedAgent: true });
    expect(m.identify(args('bot@x.com', 'dkim_pass', { declared: 'runner:me/2' }))).toMatchObject({ self: true });
    // A host principal id or a mapped channel identity is never borrowed through a declaration.
    expect(m.identify(args('bot@x.com', 'dkim_pass', { declared: 'u-1' }))).toEqual({ kind: 'agent', principal: null, trustedAgent: true });
    expect(m.identify(args('bot@x.com', 'dkim_pass', { declared: 'mail:boss@x.com' }))).toEqual({ kind: 'agent', principal: null, trustedAgent: true });
    // Anyone else's declaration is ignored, even naming a member.
    expect(m.identify(args('stranger@y.com', 'dkim_pass', { declared: 'u-1' }))).toEqual({ kind: 'human', principal: null });
  });

  it('rejects a table mapping one channel identity twice #RT-1', () => {
    const twice = [...entries, { channel: 'mail', channelUserId: 'boss@x.com', principal: 'u-9', labels: [] }];
    expect(() => new IdentityMap([twice])).toThrow(/mapped twice/);
    expect(() => router({ config: table([], { identities: twice }) })).toThrow(expect.objectContaining({ code: 'conflict' }));
    // The same owner listed twice in config is one entry, not a conflict.
    expect(ownerIdentities(['fake:alice', 'fake:alice'])).toHaveLength(1);
  });

  it('owners config is the minimal map; a host map overrides it per channel identity and is suspended with its table #ID-4 #HQ-5', () => {
    const r = router({ config: ownersTable({ owners: ['mail:boss@x.com'], agent: 'assistant' }) });
    expect(r.identify(args('boss@x.com', 'dkim_pass')).principal).toEqual({ id: 'mail:boss@x.com', labels: ['owner'] });
    r.setHostConnected(true);
    r.putHostTable(table([], { version: 'h1', identities: entries }));
    expect(r.identify(args('boss@x.com', 'dkim_pass')).principal).toEqual({ id: 'u-1', labels: ['owner'] });
    r.setHostConnected(false); // default onHostDown: suspend
    expect(r.identify(args('boss@x.com', 'dkim_pass')).principal).toEqual({ id: 'mail:boss@x.com', labels: ['owner'] });
    expect(r.identify(args('ops@x.com', 'none')).principal).toBeNull();
  });
});

describe('host tables', () => {
  const env = fakeEnvelope({ conversation: group, text: 'x' });
  const hostRule = (v: string, extra: Partial<BindingTable> = {}) => table([{ id: `r-${v}`, match: {}, on: 'context', session: { key: `S-${v}` } }], { version: v, ...extra });

  it('atomic replace with version; the same version again is a no-op #HQ-5', async () => {
    const r = router({ hostConnected: true });
    expect(r.putHostTable(hostRule('1'))).toEqual({ version: '1', changed: true });
    expect(r.putHostTable(hostRule('1'))).toEqual({ version: '1', previous: '1', changed: false });
    expect(r.putHostTable(hostRule('2'))).toEqual({ version: '2', previous: '1', changed: true });
    expect((await route(r, env)).deliveries.map((d) => d.sessionKey)).toEqual(['S-2']);
    expect(r.clearHostTable()).toBe(true);
    expect((await route(r, env)).deliveries).toEqual([]);
  });

  it('a late older version does not replace a newer table #HQ-5', async () => {
    const r = router({ hostConnected: true });
    r.putHostTable(hostRule('2'));
    // pushed before '2', delivered after it
    expect(() => r.putHostTable(hostRule('1'))).toThrow(expect.objectContaining({ code: 'stale_version' }));
    expect(r.hostTable()?.table.version).toBe('2');
    expect((await route(r, env)).deliveries.map((d) => d.sessionKey)).toEqual(['S-2']);
    // Numerically ordered, not as strings; versions that are not decimal integers are opaque labels.
    expect(r.putHostTable(hostRule('10')).changed).toBe(true);
    expect(r.putHostTable(hostRule('b')).changed).toBe(true);
    expect(r.putHostTable(hostRule('a')).changed).toBe(true);
  });

  it('expires at expiresAt #HQ-5', async () => {
    let now = 1000;
    const r = router({ hostConnected: true, now: () => now });
    r.putHostTable(hostRule('1', { expiresAt: 2000 }));
    expect((await route(r, env)).deliveries).toHaveLength(1);
    now = 2000;
    expect((await route(r, env)).deliveries).toHaveLength(0);
    expect(r.hostTable()).toMatchObject({ active: false, suspended: 'expired' });
  });

  it('pull-only host lease: onHostDown keep + a periodic re-push with a fresh expiresAt routes without a host connection, and lapses when the re-push stops #HQ-5', async () => {
    let now = 1000;
    const r = router({ now: () => now }); // never connected: an `aio tail` consumer is not the host
    expect(r.putHostTable(hostRule('1', { onHostDown: 'keep', expiresAt: now + 2000 })).changed).toBe(true);
    expect((await route(r, env)).deliveries).toHaveLength(1);
    now = 2000; // re-push the same version with a fresh lease: a real change, not a no-op
    expect(r.putHostTable(hostRule('1', { onHostDown: 'keep', expiresAt: now + 2000 })).changed).toBe(true);
    now = 3500;
    expect((await route(r, env)).deliveries).toHaveLength(1);
    now = 4000; // the host stopped re-pushing
    expect((await route(r, env)).deliveries).toHaveLength(0);
    expect(r.hostTable()).toMatchObject({ active: false, suspended: 'expired' });
    // without keep the same pull-only host's table never routes
    const s = router({ now: () => now });
    s.putHostTable(hostRule('2', { expiresAt: now + 2000 }));
    expect(s.hostTable()).toMatchObject({ active: false, suspended: 'host_down' });
  });

  it('suspends while the host is down (default) or keeps routing with onHostDown: keep #HQ-5', async () => {
    const r = router({ hostConnected: true });
    r.putHostTable(hostRule('1'));
    r.setHostConnected(false);
    expect(r.hostTable()).toMatchObject({ active: false, suspended: 'host_down' });
    expect((await route(r, env)).deliveries).toHaveLength(0);
    r.setHostConnected(true);
    expect((await route(r, env)).deliveries).toHaveLength(1);
    r.putHostTable(hostRule('2', { onHostDown: 'keep' }));
    r.setHostConnected(false);
    expect(r.hostTable()).toMatchObject({ active: true });
    expect((await route(r, env)).deliveries.map((d) => d.sessionKey)).toEqual(['S-2']);
  });

  it('persists: a restart keeps the last table, suspended until the host reconnects (unless keep) #HQ-5 #RS-1', async () => {
    const path = tempDb();
    const one = router({ path, hostConnected: true });
    one.putHostTable(hostRule('7'));
    one.close();
    const two = router({ path });
    expect(two.hostTable()).toMatchObject({ table: { version: '7' }, active: false, suspended: 'host_down' });
    expect((await route(two, env)).deliveries).toHaveLength(0);
    two.setHostConnected(true);
    expect((await route(two, env)).deliveries.map((d) => d.bindingId)).toEqual(['r-7']);
    two.putHostTable(hostRule('8', { onHostDown: 'keep' }));
    two.close();
    const three = router({ path });
    expect(three.hostTable()).toMatchObject({ table: { version: '8' }, active: true });
    three.close();
  });
});

describe('rule callouts', () => {
  const env = fakeEnvelope({ conversation: group, text: 'please deploy', raw: { secret: 1 } });
  const rule = (callout: Binding['callout'] = {}): BindingTable => table([{ id: 'ask', match: {}, on: 'context', session: { key: 'S' }, callout }]);

  it('the answer replaces on / agent / session; the callout sees the input and the envelope without raw #RT-1 #EX-1', async () => {
    const seen: unknown[] = [];
    const answer: CalloutAnswer = { on: 'dispatch', agent: 'ops', session: 'per-conversation' };
    const r = router({
      config: rule(),
      hostConnected: true,
      routeCallout: async (id, input, envelope) => {
        seen.push([id, input.inputId, 'raw' in envelope]);
        return answer;
      },
    });
    const d = await route(r, env);
    expect(seen).toEqual([['ask', 'in1', false]]);
    expect(d.deliveries).toMatchObject([{ bindingId: 'ask', on: 'dispatch', agent: 'ops', sessionKey: 'ops/fake:default:g1' }]);
    expect(d.explanation.matched).toEqual([{ bindingId: 'ask', source: 'config', on: 'dispatch', agent: 'ops', sessionKey: 'ops/fake:default:g1', callout: { outcome: 'answered', on: 'dispatch' } }]);
  });

  it('timeout → onFailure (default host); error and a bad answer too; recorded #HQ-3 #EX-1', async () => {
    const slow = router({ config: rule({ timeoutMs: 20 }), hostConnected: true, routeCallout: () => new Promise(() => {}) });
    const t = await route(slow, env);
    expect(t.host).toEqual({ bindingId: 'ask', source: 'config' });
    expect(t.deliveries).toEqual([]);
    expect(t.explanation.matched[0]!.callout).toEqual({ outcome: 'timeout', on: 'host' });

    const failing = router({ config: rule({ onFailure: 'context' }), hostConnected: true, routeCallout: async () => Promise.reject(new Error('boom')) });
    const f = await route(failing, env);
    expect(f.deliveries.map((d) => d.on)).toEqual(['context']);
    expect(f.explanation.matched[0]!.callout).toEqual({ outcome: 'error', on: 'context' });

    const bad = router({ config: rule(), hostConnected: true, routeCallout: async () => ({ on: 'dispatch', agent: 'executor' }) });
    expect((await route(bad, env)).explanation.matched[0]!.callout).toEqual({ outcome: 'error', on: 'host' });
  });

  it('no host (none connected, or no callout function) → onFailure without calling #HQ-3', async () => {
    let calls = 0;
    const r = router({ config: rule({ onFailure: 'drop' }), routeCallout: async () => (calls++, { on: 'dispatch' }) });
    const d = await route(r, env);
    expect(calls).toBe(0);
    expect(d.explanation).toMatchObject({ matched: [{ callout: { outcome: 'no_host', on: 'drop' } }], dropped: 'drop_rule' });
    const none = router({ config: rule(), hostConnected: true });
    expect((await route(none, env)).explanation.matched[0]!.callout).toEqual({ outcome: 'no_host', on: 'host' });
  });
});

describe('session launch in callout answers (decision 7)', () => {
  const env = fakeEnvelope({ conversation: group, text: 'please deploy' });
  const rule = (o: Partial<Binding> = {}): BindingTable => table([{ id: 'ask', match: {}, on: 'dispatch', agent: 'assistant', callout: { onFailure: 'context' }, ...o }]);
  const launch = { cwd: '/w/a', env: { K: 'secret-v' } };
  const launches = (o: Partial<NonNullable<RouterOptions['launches']>> = {}): NonNullable<RouterOptions['launches']> => ({
    check: ({ launch: l }) => ({ ok: true, outcome: 'applied', launch: { ...l, cwd: `/real${l.cwd}` } }),
    pinned: () => false,
    ...o,
  });

  it('an accepted launch rides the delivery (as checked) and explain shows cwd and env keys, never values #FC-4 #SE-1 #EX-1', async () => {
    const checked: unknown[] = [];
    const r = router({
      config: rule(),
      hostConnected: true,
      routeCallout: async () => ({ on: 'dispatch', session: { key: 'S1' }, launch }),
      launches: launches({ check: (a) => (checked.push(a), { ok: true, outcome: 'applied', launch: { ...a.launch, cwd: '/real/w/a' } }) }),
    });
    const d = await route(r, env);
    expect(checked).toEqual([{ sessionKey: 'S1', agent: 'assistant', launch }]);
    expect(d.deliveries).toMatchObject([{ sessionKey: 'S1', on: 'dispatch', launch: { cwd: '/real/w/a', env: { K: 'secret-v' } } }]);
    expect(d.explanation.matched[0]).toMatchObject({ callout: { outcome: 'answered' }, launch: { cwd: '/w/a', envKeys: ['K'], outcome: 'applied' } });
    expect(JSON.stringify(d.explanation)).not.toContain('secret-v');
  });

  it('a refused launch counts as an error answer: onFailure applies without the launch, the reason is recorded #HQ-3 #FC-4', async () => {
    const r = router({
      config: rule(),
      hostConnected: true,
      routeCallout: async () => ({ on: 'dispatch', session: { key: 'S1' }, launch }),
      launches: launches({ check: () => ({ ok: false, code: 'launch_conflict', message: 'pinned otherwise' }) }),
    });
    const d = await route(r, env);
    expect(d.deliveries).toHaveLength(1);
    expect(d.deliveries[0]).toMatchObject({ on: 'context', sessionKey: 'assistant:fake:default:g1' });
    expect(d.deliveries[0]!.launch).toBeUndefined();
    expect(d.explanation.matched[0]).toMatchObject({ on: 'context', callout: { outcome: 'error', on: 'context', reason: 'launch_conflict' }, launch: { envKeys: ['K'], outcome: 'launch_conflict' } });

    // Default onFailure (host): into the queue.
    const h = router({ config: rule({ callout: {} }), hostConnected: true, routeCallout: async () => ({ on: 'dispatch', launch }), launches: launches({ check: () => ({ ok: false, code: 'bad_cwd', message: 'x' }) }) });
    const dh = await route(h, env);
    expect(dh.host).toEqual({ bindingId: 'ask', source: 'config' });
    expect(dh.deliveries).toEqual([]);
    expect(dh.explanation.matched[0]!.callout).toEqual({ outcome: 'error', on: 'host', reason: 'bad_cwd' });

    // Without `launches`, a launch is refused too.
    const none = router({ config: rule(), hostConnected: true, routeCallout: async () => ({ on: 'dispatch', launch }) });
    expect((await route(none, env)).explanation.matched[0]).toMatchObject({ callout: { outcome: 'error', reason: 'launch_unsupported' } });
  });

  it('a launch with an on that targets no session (host, drop) or a malformed one is a bad answer #HQ-3 #FC-4', async () => {
    for (const answer of [{ on: 'host', launch }, { on: 'drop', launch }, { on: 'dispatch', launch: { cwd: 3 } }] as unknown as CalloutAnswer[]) {
      const r = router({ config: rule(), hostConnected: true, routeCallout: async () => answer, launches: launches() });
      const d = await route(r, env);
      expect(d.explanation.matched[0]!.callout).toEqual({ outcome: 'error', on: 'context', reason: 'bad_launch' });
    }
  });

  it('two rules for one session: the launch rides whichever delivery wins #RT-1', async () => {
    const t = table([
      { id: 'ctx', match: {}, on: 'context', agent: 'assistant', session: { key: 'S' }, callout: {} },
      { id: 'run', match: {}, on: 'dispatch', agent: 'assistant', session: { key: 'S' } },
    ]);
    const r = router({ config: t, hostConnected: true, routeCallout: async () => ({ on: 'context', session: { key: 'S' }, launch }), launches: launches() });
    const d = await route(r, env);
    expect(d.deliveries).toHaveLength(1);
    expect(d.deliveries[0]).toMatchObject({ bindingId: 'run', on: 'dispatch', launch: { cwd: '/real/w/a' } });
  });

  it('skipWhenPinned: once the rule\'s own session is pinned the host is not asked; explain says skipped_pinned #LA-2 #EX-1', async () => {
    const pinned = new Set<string>();
    let calls = 0;
    const r = router({
      config: rule({ on: 'dispatch', session: 'per-conversation', callout: { skipWhenPinned: true } }),
      hostConnected: true,
      routeCallout: async () => (calls++, { on: 'dispatch', launch }),
      launches: launches({ pinned: (k) => pinned.has(k) }),
    });
    const first = await route(r, env);
    expect(calls).toBe(1);
    expect(first.explanation.matched[0]!.callout).toEqual({ outcome: 'answered', on: 'dispatch' });
    pinned.add('assistant:fake:default:g1');
    const later = await route(r, env);
    expect(calls).toBe(1);
    expect(later.deliveries).toMatchObject([{ sessionKey: 'assistant:fake:default:g1', on: 'dispatch' }]);
    expect(later.explanation.matched[0]!.callout).toEqual({ outcome: 'skipped_pinned', on: 'dispatch' });
    // Without the flag the host is asked every time.
    const always = router({ config: rule({ session: 'per-conversation' }), hostConnected: true, routeCallout: async () => (calls++, { on: 'dispatch' }), launches: launches({ pinned: () => true }) });
    await route(always, env);
    expect(calls).toBe(2);
  });
});

describe('explanations', () => {
  it('are persisted: explain(inputId) works across a restart #EX-1 #RS-1', async () => {
    const path = tempDb();
    const one = router({ path, config: ownersTable({ owners: ['fake:alice'], agent: 'assistant' }) });
    const d = await route(one, fakeEnvelope({ sender: { channelUserId: 'alice', evidence: 'platform_signed' } }), OWNER, 'in-42');
    one.record(d.explanation);
    one.close();
    const two = router({ path });
    expect(two.explain('in-42')).toMatchObject({ inputId: 'in-42', tableVersions: ['config'], principal: 'fake:alice', matched: [{ bindingId: 'default:owner-dm', on: 'dispatch', agent: 'assistant', sessionKey: 'assistant:fake:default:c1' }] });
    expect(two.explain('nope')).toBeUndefined();
    two.close();
  });
});

describe('the default table (formerly defaultPolicy.admit)', () => {
  const agents: AgentSpec[] = [{ name: 'default', sessionPrefix: '' }];
  const r = new Router({ agents, defaultAgent: 'default', config: ownersTable({ owners: ['fake:alice'], agent: 'default' }) });
  const dm = { id: 'c1', kind: 'dm' as const };
  const owner: Origin = { ...OWNER };
  const at = async (env: InboundEnvelope, o: Origin) => {
    const d = await route(r, env, o);
    return d.deliveries.map((x) => [x.on, x.sessionKey]);
  };

  it('owner DM → dispatch; owner addressing us in a group → dispatch; unknown in a group → context; unknown DM, self echoes, adapter drops → drop #RT-1 #ID-4 #ID-5', async () => {
    expect(await at(fakeEnvelope({ conversation: dm }), owner)).toEqual([['dispatch', 'fake:default:c1']]);
    expect(await at(fakeEnvelope({ conversation: group, modeHint: 'steer' }), owner)).toEqual([['dispatch', 'fake:default:g1']]);
    expect(await at(fakeEnvelope({ conversation: group, admission: 'dispatch' }), owner)).toEqual([['dispatch', 'fake:default:g1']]); // lark: @bot
    expect(await at(fakeEnvelope({ conversation: group, admission: 'observe' }), owner)).toEqual([['context', 'fake:default:g1']]); // lark: no @bot
    expect(await at(fakeEnvelope({ conversation: group }), UNKNOWN)).toEqual([['context', 'fake:default:g1']]);
    expect(await at(fakeEnvelope({ conversation: { id: 'g1', kind: 'thread', threadId: 't' } }), UNKNOWN)).toEqual([['context', 'fake:default:g1:t']]);
    expect(await at(fakeEnvelope({ conversation: { id: 'r', kind: 'mail' } }), owner)).toEqual([['dispatch', 'fake:default:r']]);
    expect(await at(fakeEnvelope({ conversation: dm }), UNKNOWN)).toEqual([]);
    expect(await at(fakeEnvelope({ conversation: group }), { ...owner, self: true })).toEqual([]);
    expect(await at(fakeEnvelope({ conversation: dm, admission: 'drop' }), owner)).toEqual([]);
  });
});

describe('watches as runtime bindings', () => {
  const w = (p: Partial<Watch>): Watch => ({ id: 'w1', source: { channel: 'fake' }, target: { sessionKey: 'main' }, mode: 'context', createdBy: 'x', createdAt: 1, ...p });

  it('are matched with the tables and explained with source watch #RT-1', async () => {
    const r = router({ watches: { list: () => [w({ mode: 'trigger' })] }, config: table([{ id: 'ctx-main', match: {}, on: 'context', session: { key: 'main' } }]) });
    const d = await route(r, fakeEnvelope({ conversation: group }), UNKNOWN);
    expect(d.deliveries).toEqual([expect.objectContaining({ bindingId: 'watch:w1', source: 'watch', watchId: 'w1', on: 'dispatch', sessionKey: 'main' })]);
    expect(d.deliveries[0]!.agent).toBeUndefined();
  });
});
