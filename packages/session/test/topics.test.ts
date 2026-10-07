import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import type { InputRecord, Origin } from '@agents-io/protocol';
import {
  Hub,
  Ingress,
  Lane,
  MemorySessionLog,
  Router,
  SqliteSessionLog,
  TOPIC_KEY,
  TopicError,
  TopicRegistry,
  defaultBindings,
  defaultPolicy,
  formatTopics,
  newTurnView,
  ownersTable,
  parseTopicCommand,
  renderTurn,
  titleFrom,
  type AgentSpec,
  type SessionPolicy,
} from '../src/index.js';
import { RUN, bodies, until } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDb = () => {
  const d = mkdtempSync(join(tmpdir(), 'aio-topics-'));
  dirs.push(d);
  return join(d, 'log.sqlite');
};

const CONV = 'fake:default:c1';
const key = ({ topicId, first }: { topicId: string; first: boolean }) => (first ? CONV : `${CONV}#${topicId}`);
let ids = 0;
const newId = () => `tp_${++ids}`;

describe('TopicRegistry', () => {
  it('creates the first topic lazily, parks the current one on create, and never deletes', () => {
    const r = new TopicRegistry({ newId });
    const a = r.ensureCurrent(CONV, 'default', key, { title: 'Rust CLI' });
    expect(a.created).toBe(true);
    expect(a.topic).toMatchObject({ conversation: CONV, sessionKey: CONV, state: 'current', title: 'Rust CLI' });
    expect(r.ensureCurrent(CONV, 'default', key)).toEqual({ topic: a.topic, created: false });
    const b = r.create(CONV, 'default', key, { title: 'Capitals', summary: 'user builds a Rust CLI' }, 'agent');
    expect(b.created).toBe(true);
    expect(b.previous?.id).toBe(a.topic.id);
    expect(b.topic.sessionKey).toBe(`${CONV}#${b.topic.id}`);
    expect(r.get(a.topic.id)?.state).toBe('parked');
    expect(r.current(CONV, 'default')?.id).toBe(b.topic.id);
    expect(r.list({ conversation: CONV }).map((t) => t.id).sort()).toEqual([a.topic.id, b.topic.id].sort());
    // Another agent has its own topic list in the same conversation.
    expect(r.current(CONV, 'ops')).toBeUndefined();
    expect(r.siblings(CONV).map((t) => t.id).sort()).toEqual([a.topic.id, b.topic.id].sort());
    expect(r.siblings('nope')).toEqual([]);
  });

  it('switches back, persists across reopen (same database as the log), and keeps native ids', () => {
    const path = tempDb();
    const log = new SqliteSessionLog({ path });
    let now = 1000;
    const r = new TopicRegistry({ db: log.db, newId, now: () => now });
    const a = r.ensureCurrent(CONV, 'default', key).topic;
    now = 2000;
    const b = r.create(CONV, 'default', key, { title: 'B' }, 'user').topic;
    r.setNativeId(a.sessionKey, 'claude-session-a');
    now = 3000;
    const back = r.switchTo(a.id, 'agent');
    expect(back).toMatchObject({ created: false, previous: { id: b.id } });
    expect(r.switchTo(a.id, 'agent').previous).toBeUndefined(); // already current: no change
    expect(() => r.switchTo('tp_zz', 'user')).toThrow(TopicError);
    log.close();

    const log2 = new SqliteSessionLog({ path });
    const r2 = new TopicRegistry({ db: log2.db });
    expect(r2.current(CONV, 'default')).toMatchObject({ id: a.id, nativeId: 'claude-session-a', lastActiveAt: 3000 });
    expect(r2.get(b.id)).toMatchObject({ state: 'parked', title: 'B' });
    expect(r2.bySession(b.sessionKey)?.id).toBe(b.id);
    // Newest activity first.
    expect(r2.list({ conversation: CONV }).map((t) => t.id)).toEqual([a.id, b.id]);
    log2.close();
  });

  it('records topic.changed in the session left and the one now current', () => {
    const hub = new Hub(new MemorySessionLog());
    const r = new TopicRegistry({ hub, newId });
    const a = r.ensureCurrent(CONV, 'default', key, { title: 'A' }).topic;
    expect(bodies(hub.log.read(a.sessionKey, 0), 'topic.changed')).toEqual([{ t: 'topic.changed', conversation: CONV, to: a.id, title: 'A', reason: 'system' }]);
    const b = r.create(CONV, 'default', key, { title: 'B' }, 'agent').topic;
    const want = { t: 'topic.changed', conversation: CONV, from: a.id, to: b.id, title: 'B', reason: 'agent' };
    expect(bodies(hub.log.read(a.sessionKey, 0), 'topic.changed').at(-1)).toEqual(want);
    expect(bodies(hub.log.read(b.sessionKey, 0), 'topic.changed')).toEqual([want]);
  });

  it('titles: trimmed and bounded; a first message gives a short title, a command none', () => {
    const r = new TopicRegistry({ newId });
    const t = r.create(CONV, 'default', key, { title: `  ${'x'.repeat(200)} ` }, 'user').topic;
    expect(t.title!.length).toBe(80);
    r.setTitle(t.id, '  renamed  ');
    expect(r.get(t.id)!.title).toBe('renamed');
    expect(titleFrom('hello there\nsecond line')).toBe('hello there');
    expect(titleFrom('/new x')).toBeUndefined();
    expect(titleFrom('a'.repeat(60))!.length).toBe(40);
  });
});

const AGENTS: AgentSpec[] = [{ name: 'assistant', sessionPrefix: '' }];
const OWNER: Origin = { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: CONV, adapter: 'fake' };
const inputOf = (env: ReturnType<typeof fakeEnvelope>, origin: Origin = OWNER): InputRecord => ({ inputId: 'in1', origin, content: env.content, replyRoute: env.replyRoute, channelContext: {} });

describe('router: session "topic"', () => {
  const table = { version: 'v', bindings: [{ id: 'dm', match: { conversationKind: 'dm' as const }, on: 'dispatch' as const, session: 'topic' as const }], identities: [] };

  it('resolves to the current topic, creating the first one (with the conversation key) on first use', async () => {
    const topics = new TopicRegistry({ newId });
    const r = new Router({ agents: AGENTS, defaultAgent: 'assistant', config: table, topics });
    const env = fakeEnvelope({ text: 'Tell me about Rust' });
    const d1 = await r.route(env, OWNER, inputOf(env));
    expect(d1.deliveries[0]).toMatchObject({ sessionKey: CONV, topic: { conversation: CONV, title: 'Tell me about Rust' } });
    const first = topics.current(CONV, 'assistant')!;
    const b = r.newTopic('assistant', CONV, { title: 'B' }, 'user');
    expect(b.topic.sessionKey).toBe(`${CONV}#${b.topic.id}`);
    const d2 = await r.route(env, OWNER, inputOf(env));
    expect(d2.deliveries[0]).toMatchObject({ sessionKey: b.topic.sessionKey, topic: { id: b.topic.id, title: 'B' } });
    expect(d2.explanation.matched[0]!.sessionKey).toBe(b.topic.sessionKey);
    topics.switchTo(first.id, 'user');
    expect((await r.route(env, OWNER, inputOf(env))).deliveries[0]!.sessionKey).toBe(CONV);
  });

  it('a threaded conversation keeps one session per thread; without a topic table a topic is the conversation', async () => {
    const topics = new TopicRegistry({ newId });
    const r = new Router({ agents: AGENTS, defaultAgent: 'assistant', config: table, topics });
    const threaded = fakeEnvelope({ conversation: { id: 'c1', kind: 'dm', threadId: 't9' } });
    const d = await r.route(threaded, OWNER, inputOf(threaded));
    expect(d.deliveries[0]!.sessionKey).toBe(`${CONV}:t9`);
    expect(d.deliveries[0]!.topic).toBeUndefined();
    expect(topics.list()).toEqual([]);
    const plain = new Router({ agents: AGENTS, defaultAgent: 'assistant', config: table });
    const env = fakeEnvelope({});
    expect((await plain.route(env, OWNER, inputOf(env))).deliveries[0]).toMatchObject({ sessionKey: CONV });
    expect(() => plain.newTopic('assistant', CONV, {}, 'user')).toThrow(/no topic table/);
  });

  it('the default owner-DM rule uses topics; groups stay per thread', () => {
    const b = defaultBindings({ agent: 'default' });
    expect(b.find((x) => x.id === 'default:owner-dm')!.session).toBe('topic');
    expect(b.filter((x) => x.id !== 'default:owner-dm').every((x) => x.session === 'per-thread')).toBe(true);
    expect(defaultBindings({ agent: 'default', ownerSessionKey: 'me' }).find((x) => x.id === 'default:owner-dm')!.session).toEqual({ key: 'me' });
  });
});

function world(extra: Partial<SessionPolicy> = {}) {
  const hub = new Hub(new MemorySessionLog());
  const policy: SessionPolicy = { ...defaultPolicy({ owners: ['fake:alice', 'fake:bob'], run: RUN }), ...extra };
  const topics = new TopicRegistry({ hub, newId });
  const router = new Router({ agents: [{ name: 'default', sessionPrefix: '' }], defaultAgent: 'default', config: ownersTable({ agent: 'default', owners: ['fake:alice'] }), topics });
  const lanes = new Map<string, Lane>();
  const seen: { sessionKey: string; inputs: InputRecord[] }[] = [];
  const replies: { text: string; sessionKey: string; operationId: string }[] = [];
  const ingress = new Ingress({
    policy: { ...policy, identify: async (a) => router.identify(a) },
    router,
    lanes: (sessionKey) => {
      let l = lanes.get(sessionKey);
      if (!l) {
        const harness = new FakeHarness(async (t) => {
          seen.push({ sessionKey, inputs: t.inputs });
        });
        lanes.set(sessionKey, (l = new Lane({ sessionKey, harness, hub, policy, thinkingHeadline: null })));
      }
      return l;
    },
    systemReply: async (a) => {
      replies.push({ text: a.text, sessionKey: a.sessionKey, operationId: a.operationId });
    },
  });
  return { hub, ingress, topics, lanes, seen, replies };
}

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const say = (w: ReturnType<typeof world>, text: string, sender: { channelUserId: string; evidence: 'platform_signed' } = alice) => w.ingress.accept(fakeEnvelope({ sender, text }));

describe('topic commands (Ingress)', () => {
  it('parses /new [title], /topics, /switch <n|id>; anything else is a message', () => {
    expect(parseTopicCommand([{ type: 'text', text: '/new' }])).toEqual({ name: 'new' });
    expect(parseTopicCommand([{ type: 'text', text: ' /NEW  Trip   to Kyoto ' }])).toEqual({ name: 'new', arg: 'Trip to Kyoto' });
    expect(parseTopicCommand([{ type: 'text', text: '/topics' }])).toEqual({ name: 'topics' });
    expect(parseTopicCommand([{ type: 'text', text: '/switch 2' }])).toEqual({ name: 'switch', arg: '2' });
    expect(parseTopicCommand([{ type: 'text', text: '/topics please' }])).toBeUndefined();
    expect(parseTopicCommand([{ type: 'text', text: '/newer' }])).toBeUndefined();
    expect(parseTopicCommand([{ type: 'text', text: 'please /new' }])).toBeUndefined();
    expect(parseTopicCommand([{ type: 'text', text: '/new' }, { type: 'text', text: 'x' }])).toBeUndefined();
  });

  it('/new starts a topic the next message goes to; /topics lists; /switch goes back', async () => {
    const w = world();
    const r1 = await say(w, 'Remember: my codename is HERON');
    expect(r1).toMatchObject({ action: 'dispatch', sessionKey: CONV });
    const first = w.topics.current(CONV, 'default')!;
    expect(first.title).toBe('Remember: my codename is HERON');

    const cmd = await say(w, '/new Groceries');
    expect(cmd).toMatchObject({ accepted: true, action: 'command', command: { name: 'new', ok: true } });
    const second = w.topics.current(CONV, 'default')!;
    expect(second).toMatchObject({ title: 'Groceries', sessionKey: `${CONV}#${second.id}` });
    expect(w.replies.at(-1)).toMatchObject({ sessionKey: second.sessionKey, operationId: `topic-cmd:${cmd.inputId}` });
    expect(w.replies.at(-1)!.text).toMatch(/^New topic: Groceries\./);
    // The command itself never reached a harness.
    await w.lanes.get(CONV)!.whenIdle();
    expect(w.seen.flatMap((s) => s.inputs).some((i) => JSON.stringify(i.content).includes('/new'))).toBe(false);

    const r2 = await say(w, 'milk and eggs');
    expect(r2.sessionKey).toBe(second.sessionKey);
    await until(() => w.seen.some((s) => s.sessionKey === second.sessionKey));
    expect(w.seen.find((s) => s.sessionKey === second.sessionKey)!.inputs[0]!.channelContext).toMatchObject({ topic: second.id, topicTitle: 'Groceries' });

    const list = await say(w, '/topics');
    expect(list.command).toMatchObject({ name: 'topics', ok: true });
    expect(w.replies.at(-1)!.text).toMatch(/▶ 1\. Groceries/);
    expect(w.replies.at(-1)!.text).toMatch(/ 2\. Remember: my codename is HERON/);

    const sw = await say(w, '/switch 2');
    expect(sw).toMatchObject({ action: 'command', sessionKey: CONV, command: { name: 'switch', ok: true, topic: first.id } });
    expect(w.replies.at(-1)!.text).toMatch(/^Switched to topic 2: Remember/);
    expect((await say(w, 'what is my codename?')).sessionKey).toBe(CONV);
    expect(bodies(w.hub.log.read(CONV, 0), 'topic.changed').map((b) => (b as { reason: string }).reason)).toEqual(['system', 'user', 'user']);

    expect((await say(w, `/switch ${first.id}`)).command).toMatchObject({ ok: true });
    expect(w.replies.at(-1)!.text).toMatch(/^Already in topic/);
    expect((await say(w, '/switch 9')).command).toMatchObject({ ok: false });
    expect(w.replies.at(-1)!.text).toMatch(/No topic 9/);
  });

  it('Policy.control decides who may use them (owner by default)', async () => {
    const calls: string[] = [];
    const w = world({ control: async (a) => (calls.push(`${a.op}:${a.sessionKey}`), 'deny') });
    await say(w, 'hello');
    const r = await say(w, '/new X');
    expect(r.command).toMatchObject({ name: 'new', ok: false });
    expect(w.replies.at(-1)!.text).toMatch(/only for the owner/);
    expect(calls).toEqual([`reset:${CONV}`]);
    expect(w.topics.list({ conversation: CONV })).toHaveLength(1);
  });

  it('formats an empty and a populated list', () => {
    expect(formatTopics([])).toBe('No topics yet.');
    const now = 10 * 60_000;
    const text = formatTopics([{ id: 'a', agent: 'x', conversation: CONV, sessionKey: CONV, state: 'current', createdAt: 0, lastActiveAt: now - 5 * 60_000 }], now);
    expect(text).toMatch(/▶ 1\. \(untitled\) · 5m ago/);
  });
});

describe('topic title on cards', () => {
  it('card and full renders carry the topic title; headline and final do not', () => {
    const v = newTurnView('t1');
    expect(renderTurn(v, 'card', { title: 'Groceries' }).channelData).toEqual({ [TOPIC_KEY]: { title: 'Groceries' } });
    expect(renderTurn(v, 'full', { title: 'Groceries' }).channelData).toEqual({ [TOPIC_KEY]: { title: 'Groceries' } });
    expect(renderTurn(v, 'card').channelData).toBeUndefined();
    expect(renderTurn(v, 'final', { title: 'Groceries' }).channelData).toBeUndefined();
    expect(renderTurn(v, 'headline', { title: 'Groceries' }).channelData).toBeUndefined();
  });
});
