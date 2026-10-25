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
  TOPIC_TOOLS_HINT,
  TopicError,
  TopicRegistry,
  defaultBindings,
  defaultPolicy,
  ownersTable,
  type AgentSpec,
  type IngressOptions,
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
  it('creates the first topic lazily, parks the current one on create, and never deletes #TP-1', () => {
    const r = new TopicRegistry({ newId });
    const a = r.ensureCurrent(CONV, 'default', key, { title: 'Rust CLI' });
    expect(a.created).toBe(true);
    expect(a.topic).toMatchObject({ conversation: CONV, sessionKey: CONV, state: 'current', title: 'Rust CLI' });
    expect(r.ensureCurrent(CONV, 'default', key)).toEqual({ topic: a.topic, created: false });
    const b = r.create(CONV, 'default', key, { title: 'Capitals' }, 'agent');
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

  it('switches back, persists across reopen (same database as the log), and keeps native ids #TP-1 #RS-1', () => {
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

  it('records topic.changed in the session left and the one now current #TP-1', () => {
    const hub = new Hub(new MemorySessionLog());
    const r = new TopicRegistry({ hub, newId });
    const a = r.ensureCurrent(CONV, 'default', key, { title: 'A' }).topic;
    expect(bodies(hub.log.read(a.sessionKey, 0), 'topic.changed')).toEqual([{ t: 'topic.changed', conversation: CONV, to: a.id, title: 'A', reason: 'system' }]);
    const b = r.create(CONV, 'default', key, { title: 'B' }, 'agent').topic;
    const want = { t: 'topic.changed', conversation: CONV, from: a.id, to: b.id, title: 'B', reason: 'agent' };
    expect(bodies(hub.log.read(a.sessionKey, 0), 'topic.changed').at(-1)).toEqual(want);
    expect(bodies(hub.log.read(b.sessionKey, 0), 'topic.changed')).toEqual([want]);
  });

  it('a rotate stores its summary on the topic it parks (the one it describes); the new topic starts without one #TP-1', () => {
    const path = tempDb();
    const log = new SqliteSessionLog({ path });
    const r = new TopicRegistry({ db: log.db, newId });
    const a = r.ensureCurrent(CONV, 'default', key, { title: 'Rust CLI' }).topic;
    const b = r.create(CONV, 'default', key, { title: 'Capitals' }, 'agent', { summaryOfPrevious: '  user builds a Rust CLI ' }).topic;
    expect(r.get(a.id)).toMatchObject({ state: 'parked', summary: 'user builds a Rust CLI' });
    expect(b.summary).toBeUndefined();
    log.close();
    const r2 = new TopicRegistry({ db: new SqliteSessionLog({ path }).db });
    expect(r2.get(a.id)?.summary).toBe('user builds a Rust CLI');
    expect(r2.get(b.id)?.summary).toBeUndefined();
  });

  it("a change a turn made is recorded under that turn in the turn's session #TP-1", () => {
    const hub = new Hub(new MemorySessionLog());
    const r = new TopicRegistry({ hub, newId });
    const a = r.ensureCurrent(CONV, 'default', key).topic;
    const b = r.create(CONV, 'default', key, { title: 'B' }, 'agent', { turn: { sessionKey: CONV, turnId: 'turn_1' } }).topic;
    expect(hub.log.read(a.sessionKey, 0).filter((e) => e.body.t === 'topic.changed').at(-1)!.turnId).toBe('turn_1');
    expect(hub.log.read(b.sessionKey, 0).find((e) => e.body.t === 'topic.changed')!.turnId).toBeUndefined();
    r.switchTo(a.id, 'agent', { turn: { sessionKey: b.sessionKey, turnId: 'turn_2' } });
    expect(hub.log.read(b.sessionKey, 0).filter((e) => e.body.t === 'topic.changed').at(-1)!.turnId).toBe('turn_2');
    expect(hub.log.read(a.sessionKey, 0).filter((e) => e.body.t === 'topic.changed').at(-1)!.turnId).toBeUndefined();
  });

});

const AGENTS: AgentSpec[] = [{ name: 'assistant', sessionPrefix: '' }];
const OWNER: Origin = { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: CONV, adapter: 'fake' };
const inputOf = (env: ReturnType<typeof fakeEnvelope>, origin: Origin = OWNER): InputRecord => ({ inputId: 'in1', origin, content: env.content, replyRoute: env.replyRoute, channelContext: {} });

describe('router: session "topic"', () => {
  const table = { version: 'v', bindings: [{ id: 'dm', match: { conversationKind: 'dm' as const }, on: 'dispatch' as const, session: 'topic' as const }], identities: [] };

  it('a threaded conversation keeps one session per thread; without a topic table a topic is the conversation #TP-1 #RT-1', async () => {
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

  it('context recorded by the default observe rule follows the current topic of a conversation that has topics #TP-1 #RT-1', async () => {
    const topics = new TopicRegistry({ newId });
    // The owner made the group's rule `topic` (the default observe rule stays `per-thread`).
    const bindings = defaultBindings({ agent: 'assistant' }).map((b) => (b.id === 'default:owner-group' ? { ...b, session: 'topic' as const } : b));
    const r = new Router({ agents: AGENTS, defaultAgent: 'assistant', config: { version: 'v', bindings, identities: [] }, topics });
    const G = 'fake:default:g1';
    const member: Origin = { kind: 'human', principal: { id: 'fake:bob', labels: [] }, evidence: 'platform_signed', via: G, adapter: 'fake' };
    const say = (id: string, text: string, conversation: { id: string; kind: 'group'; threadId?: string } = { id, kind: 'group' }) => {
      const env = fakeEnvelope({ conversation, text });
      return r.route(env, member, inputOf(env, member));
    };
    const first = r.newTopic('assistant', G, { title: 'A' }, 'user').topic;
    expect(first.sessionKey).toBe(G);
    expect((await say('g1', 'bob in topic 1')).deliveries).toEqual([expect.objectContaining({ on: 'context', sessionKey: G })]);
    const second = r.newTopic('assistant', G, { title: 'B' }, 'user').topic;
    expect((await say('g1', 'bob in topic 2')).deliveries).toEqual([expect.objectContaining({ on: 'context', sessionKey: second.sessionKey })]);
    // A thread stays its own session; a group without topics keeps its session and gets no topic table entry.
    expect((await say('g1', 'in a thread', { id: 'g1', kind: 'group', threadId: 't1' })).deliveries[0]!.sessionKey).toBe(`${G}:t1`);
    expect((await say('g2', 'elsewhere')).deliveries[0]!.sessionKey).toBe('fake:default:g2');
    expect(topics.list({ conversation: 'fake:default:g2' })).toEqual([]);
  });

});

function world(extra: Partial<SessionPolicy> = {}, more: Partial<IngressOptions> = {}) {
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
    ...more,
  });
  return { hub, ingress, topics, lanes, seen, replies };
}

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const say = (w: ReturnType<typeof world>, text: string, sender: { channelUserId: string; evidence: 'platform_signed' } = alice) => w.ingress.accept(fakeEnvelope({ sender, text }));

describe('topic commands (Ingress)', () => {
  it('/new starts a topic the next message goes to; /topics lists; /switch goes back #TP-1', async () => {
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

    // Case and spacing do not matter; anything that is not exactly a command is a message.
    expect((await say(w, ' /NEW  Trip   to Kyoto ')).command).toMatchObject({ name: 'new', ok: true });
    expect(w.topics.current(CONV, 'default')!.title).toBe('Trip to Kyoto');
    for (const text of ['/topics please', '/newer', 'please /new']) expect((await say(w, text)).action).toBe('dispatch');
  });

  it("an input rewritten into a parked topic's session is labelled with that topic, without the hint #TP-1", async () => {
    // A reply "2" to a question topic A asked goes back to A's session, though B is current.
    const w = world({}, { topicHint: TOPIC_TOOLS_HINT, rewrite: ({ env }) => (JSON.stringify(env.content).includes('"2"') ? { sessionKey: CONV } : undefined) });
    await say(w, 'Pick a colour');
    const a = w.topics.current(CONV, 'default')!;
    await say(w, '/new Groceries');
    const b = w.topics.current(CONV, 'default')!;
    await say(w, 'milk');
    await until(() => w.seen.some((s) => s.sessionKey === b.sessionKey));
    expect(w.seen.find((s) => s.sessionKey === b.sessionKey)!.inputs[0]!.channelContext).toMatchObject({ topic: b.id, topicTitle: 'Groceries', topicTools: TOPIC_TOOLS_HINT });
    const r = await say(w, '2');
    expect(r.sessionKey).toBe(CONV);
    await until(() => w.seen.filter((s) => s.sessionKey === CONV).length === 2);
    const ctx = w.seen.filter((s) => s.sessionKey === CONV).at(-1)!.inputs.at(-1)!.channelContext;
    expect(ctx).toMatchObject({ topic: a.id, topicTitle: 'Pick a colour' });
    // A parked topic's tools refuse to move anything: no hint to call them.
    expect(ctx.topicTools).toBeUndefined();
  });

  it('the hint is chosen per target agent (only agents with the session_* tools get it) #CF-6', async () => {
    const w = world({}, { topicHint: (agent) => (agent === 'tools' ? TOPIC_TOOLS_HINT : undefined) });
    await say(w, 'hello');
    await until(() => w.seen.length === 1);
    expect(w.seen[0]!.inputs[0]!.channelContext.topic).toBeDefined();
    expect(w.seen[0]!.inputs[0]!.channelContext.topicTools).toBeUndefined();
  });

  it('Policy.control decides who may use them (owner by default) #CT-1', async () => {
    const calls: string[] = [];
    const w = world({ control: async (a) => (calls.push(`${a.op}:${a.sessionKey}`), 'deny') });
    await say(w, 'hello');
    const r = await say(w, '/new X');
    expect(r.command).toMatchObject({ name: 'new', ok: false });
    expect(w.replies.at(-1)!.text).toMatch(/only for the owner/);
    expect(calls).toEqual([`reset:${CONV}`]);
    expect(w.topics.list({ conversation: CONV })).toHaveLength(1);
  });
});
