import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEnvelope } from '@agents-io/testkit';
import type { Binding, BindingMatch, BindingTable, IdentityEntry, InboundEnvelope, InputRecord, Origin, Watch } from '@agents-io/protocol';
import { IdentityMap, Router, RouterError, defaultBindings, matches, ownerIdentities, ownersTable, watchBinding, type AgentSpec, type CalloutAnswer, type RouterOptions } from '../src/index.js';

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

  it('channel, account, conversation, conversationKind, senders', () => {
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

  it('labels and principal come from the stamped origin (identity map)', () => {
    expect(m({ labels: ['oncall'] })).toBe(true);
    expect(m({ labels: ['owner', 'member'] })).toBe(true);
    expect(m({ labels: ['owner'] })).toBe(false);
    expect(m({ labels: ['member'] }, UNKNOWN)).toBe(false);
    expect(m({ principal: 'u-7' })).toBe(true);
    expect(m({ principal: 'u-8' })).toBe(false);
    expect(m({ known: false })).toBe(false);
    expect(m({ known: false }, UNKNOWN)).toBe(true);
  });

  it('mentions: platform ids, and `self` = one of our own accounts or the adapter saying it is addressed', () => {
    expect(m({ mentions: ['ou_x'] })).toBe(true);
    expect(m({ mentions: ['ou_y'] })).toBe(false);
    expect(m({ mentions: ['self'] })).toBe(true); // @ou_bot is ours
    const other = { ...env, mentions: [{ id: 'ou_x' }], admission: 'observe' as const };
    expect(m({ mentions: ['self'] }, MEMBER, other)).toBe(false);
    expect(m({ mentions: ['self'] }, MEMBER, { ...other, admission: 'dispatch' })).toBe(true); // lark: @bot or DM
    const { admission: _a, ...noHint } = other;
    expect(m({ mentions: ['self'] }, MEMBER, noHint as InboundEnvelope)).toBe(true); // mail, bridges: no hint = for us
  });

  it('keywords are case-insensitive substrings, any of them', () => {
    expect(m({ keywords: ['broken'] })).toBe(true);
    expect(m({ keywords: ['fine', 'DEPLOY'] })).toBe(true);
    expect(m({ keywords: ['fine'] })).toBe(false);
  });

  it('actionPrefix matches card clicks whose action id starts with it', () => {
    const click = fakeEnvelope({ content: [{ type: 'event', name: 'action', data: { actionId: 'xwo:approve:42' } }] });
    expect(m({ actionPrefix: 'xwo:' }, MEMBER, click)).toBe(true);
    expect(m({ actionPrefix: 'other:' }, MEMBER, click)).toBe(false);
    expect(m({ actionPrefix: 'xwo:' })).toBe(false); // not a click
  });

  it('own echoes only with includeSelf', () => {
    expect(m({}, SELF)).toBe(false);
    expect(m({ includeSelf: true }, SELF)).toBe(true);
  });
});

describe('Router.route', () => {
  const env = (p: Parameters<typeof fakeEnvelope>[0] = {}) => fakeEnvelope({ conversation: group, sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi', ...p });

  it('fans out to every matching rule; per session the strongest action wins', async () => {
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

  it('on a tie the earlier rule wins (config before host before watches)', async () => {
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

  it('host and drop are independent of the session deliveries', async () => {
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

  it('drops (and explains) an input no rule matches, and adapter drops before any rule', async () => {
    const logs: string[] = [];
    const r = router({ config: table([{ id: 'mail', match: { channel: 'mail' }, on: 'dispatch' }]), log: (_l, m) => logs.push(m) });
    const d = await route(r, env(), UNKNOWN, 'in-x');
    expect(d).toMatchObject({ deliveries: [], explanation: { inputId: 'in-x', matched: [], dropped: 'no_match', principal: null, evidence: 'platform_signed' } });
    expect(d.host).toBeUndefined();
    expect(logs.some((l) => l.includes('in-x') && l.includes('matched no binding'))).toBe(true);
    const all = router({ config: table([{ id: 'all', match: {}, on: 'dispatch' }]) });
    expect((await route(all, env({ admission: 'drop' }))).explanation).toMatchObject({ dropped: 'adapter', matched: [] });
  });

  it('never dispatches our own echoes (a rule with includeSelf records them as context)', async () => {
    const r = router({ config: table([{ id: 'echo', match: { includeSelf: true }, on: 'dispatch', session: { key: 'S' } }]) });
    const d = await route(r, env(), SELF);
    expect(d.deliveries.map((x) => x.on)).toEqual(['context']);
  });

  it('resolves session scopes per agent', async () => {
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

  it('rejects tables that target task agents or unknown agents, and other invalid tables', () => {
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

  it('stamps principal and labels only with accepted evidence (default platform_signed, dkim_pass)', () => {
    const m = new IdentityMap([entries]);
    expect(m.identify(args('boss@x.com', 'dkim_pass'))).toEqual({ kind: 'human', principal: { id: 'u-1', labels: ['owner'] } });
    expect(m.identify(args('boss@x.com', 'none'))).toEqual({ kind: 'human', principal: null });
    expect(m.identify(args('ops@x.com', 'none'))).toMatchObject({ principal: { id: 'u-2' } });
    expect(m.identify(args('ops@x.com', 'platform_signed'))).toMatchObject({ principal: null });
    expect(m.identify(args('stranger@y.com', 'dkim_pass', { isBot: true }))).toEqual({ kind: 'agent', principal: null });
  });

  it('keeps the safety rules: self echoes, declarations only from agent accounts, never naming a member', () => {
    const m = new IdentityMap([entries], { selfAccounts: ['mail:me@x.com'], agentAccounts: ['mail:bot@x.com'], isSelfDeclared: (d) => d.startsWith('runner:me/') });
    expect(m.identify(args('me@x.com', 'dkim_pass', { declared: 'runner:me/1' }))).toEqual({ kind: 'agent', principal: null, self: true, declared: 'runner:me/1' });
    expect(m.identify(args('bot@x.com', 'dkim_pass', { declared: 'runner:other/1' }))).toEqual({ kind: 'agent', principal: { id: 'runner:other/1', labels: ['agent'] }, declared: 'runner:other/1' });
    expect(m.identify(args('bot@x.com', 'dkim_pass', { declared: 'runner:me/2' }))).toMatchObject({ self: true });
    // A host principal id or a mapped channel identity is never borrowed through a declaration.
    expect(m.identify(args('bot@x.com', 'dkim_pass', { declared: 'u-1' }))).toEqual({ kind: 'agent', principal: null });
    expect(m.identify(args('bot@x.com', 'dkim_pass', { declared: 'mail:boss@x.com' }))).toEqual({ kind: 'agent', principal: null });
    // Anyone else's declaration is ignored, even naming a member.
    expect(m.identify(args('stranger@y.com', 'dkim_pass', { declared: 'u-1' }))).toEqual({ kind: 'human', principal: null });
  });

  it('rejects a table mapping one channel identity twice', () => {
    const twice = [...entries, { channel: 'mail', channelUserId: 'boss@x.com', principal: 'u-9', labels: [] }];
    expect(() => new IdentityMap([twice])).toThrow(/mapped twice/);
    expect(() => router({ config: table([], { identities: twice }) })).toThrow(expect.objectContaining({ code: 'conflict' }));
    // The same owner listed twice in config is one entry, not a conflict.
    expect(ownerIdentities(['fake:alice', 'fake:alice'])).toHaveLength(1);
  });

  it('owners config is the minimal map; a host map overrides it per channel identity and is suspended with its table', () => {
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

  it('atomic replace with version; the same version again is a no-op', async () => {
    const r = router({ hostConnected: true });
    expect(r.putHostTable(hostRule('1'))).toEqual({ version: '1', changed: true });
    expect(r.putHostTable(hostRule('1'))).toEqual({ version: '1', previous: '1', changed: false });
    expect(r.putHostTable(hostRule('2'))).toEqual({ version: '2', previous: '1', changed: true });
    expect((await route(r, env)).deliveries.map((d) => d.sessionKey)).toEqual(['S-2']);
    expect(r.clearHostTable()).toBe(true);
    expect((await route(r, env)).deliveries).toEqual([]);
  });

  it('expires at expiresAt', async () => {
    let now = 1000;
    const r = router({ hostConnected: true, now: () => now });
    r.putHostTable(hostRule('1', { expiresAt: 2000 }));
    expect((await route(r, env)).deliveries).toHaveLength(1);
    now = 2000;
    expect((await route(r, env)).deliveries).toHaveLength(0);
    expect(r.hostTable()).toMatchObject({ active: false, suspended: 'expired' });
  });

  it('suspends while the host is down (default) or keeps routing with onHostDown: keep', async () => {
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

  it('persists: a restart keeps the last table, suspended until the host reconnects (unless keep)', async () => {
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

  it('the answer replaces on / agent / session; the callout sees the input and the envelope without raw', async () => {
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

  it('timeout → onFailure (default host); error and a bad answer too; recorded', async () => {
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

  it('no host (none connected, or no callout function) → onFailure without calling', async () => {
    let calls = 0;
    const r = router({ config: rule({ onFailure: 'drop' }), routeCallout: async () => (calls++, { on: 'dispatch' }) });
    const d = await route(r, env);
    expect(calls).toBe(0);
    expect(d.explanation).toMatchObject({ matched: [{ callout: { outcome: 'no_host', on: 'drop' } }], dropped: 'drop_rule' });
    const none = router({ config: rule(), hostConnected: true });
    expect((await route(none, env)).explanation.matched[0]!.callout).toEqual({ outcome: 'no_host', on: 'host' });
  });
});

describe('explanations', () => {
  it('are persisted: explain(inputId) works across a restart', async () => {
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

  it('owner DM → dispatch; owner addressing us in a group → dispatch; unknown in a group → context; unknown DM, self echoes, adapter drops → drop', async () => {
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

  it('can merge owner DMs into one session (ownerSessionKey)', async () => {
    const q = new Router({ agents, defaultAgent: 'default', config: ownersTable({ owners: ['fake:alice'], agent: 'default', ownerSessionKey: 'main' }) });
    expect(await route(q, fakeEnvelope({ conversation: dm }), owner).then((d) => d.deliveries.map((x) => x.sessionKey))).toEqual(['main']);
    // Only DMs: the owner in a group stays in the group's session.
    expect(await route(q, fakeEnvelope({ conversation: group }), owner).then((d) => d.deliveries.map((x) => x.sessionKey))).toEqual(['fake:default:g1']);
  });

  it('is a plain table: every rule targets the agent and names its session scope', () => {
    const b = defaultBindings({ agent: 'a' });
    expect(b.map((x) => x.id)).toContain('default:owner-dm');
    expect(b.every((x) => x.agent === 'a' && x.session !== undefined)).toBe(true);
  });

  it('legacy Policy.admit is honoured only while no table is configured', async () => {
    const legacyAdmit = async () => ({ action: 'dispatch' as const, sessionKey: 'legacy-session', mode: 'steer' as const });
    const legacy = new Router({ agents, legacyAdmit });
    const d = await route(legacy, fakeEnvelope({ conversation: dm }), UNKNOWN);
    expect(d.deliveries).toEqual([expect.objectContaining({ bindingId: 'legacy:admit', on: 'dispatch', sessionKey: 'legacy-session', mode: 'steer' })]);
    const withTable = new Router({ agents, defaultAgent: 'default', legacyAdmit, config: ownersTable({ owners: [], agent: 'default' }) });
    expect((await route(withTable, fakeEnvelope({ conversation: dm }), UNKNOWN)).deliveries).toEqual([]);
  });
});

describe('watches as runtime bindings', () => {
  const w = (p: Partial<Watch>): Watch => ({ id: 'w1', source: { channel: 'fake' }, target: { sessionKey: 'main' }, mode: 'context', createdBy: 'x', createdAt: 1, ...p });

  it('source + filter become the match, mode the action, target the session', () => {
    expect(watchBinding(w({ source: { channel: 'fake', account: 'a', conversation: 'g1', senders: ['eve'] }, filter: { keywords: ['k'], mentions: ['u9'], excludeSelf: false }, mode: 'trigger' }))).toEqual({
      id: 'watch:w1',
      match: { channel: 'fake', account: 'a', conversation: 'g1', senders: ['eve'], keywords: ['k'], mentions: ['u9'], includeSelf: true },
      on: 'dispatch',
      session: { key: 'main' },
    });
    // A conversation naming a kind matches that kind.
    expect(watchBinding(w({ source: { channel: 'fake', conversation: 'group' } })).match).toEqual({ channel: 'fake', conversationKind: 'group' });
    expect(watchBinding(w({ mode: 'digest', digest: { everyMs: 5 }, note: 'n' }))).toMatchObject({ on: 'digest', digest: { everyMs: 5 }, note: 'n' });
  });

  it('are matched with the tables and explained with source watch', async () => {
    const r = router({ watches: { list: () => [w({ mode: 'trigger' })] }, config: table([{ id: 'ctx-main', match: {}, on: 'context', session: { key: 'main' } }]) });
    const d = await route(r, fakeEnvelope({ conversation: group }), UNKNOWN);
    expect(d.deliveries).toEqual([expect.objectContaining({ bindingId: 'watch:w1', source: 'watch', watchId: 'w1', on: 'dispatch', sessionKey: 'main' })]);
    expect(d.deliveries[0]!.agent).toBeUndefined();
  });
});
