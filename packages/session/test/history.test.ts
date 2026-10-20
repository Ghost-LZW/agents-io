import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import type { HistoryScope, InboundEnvelope, InputRecord } from '@agents-io/protocol';
import { Hub, Ingress, Lane, MemorySessionLog, Router, SqliteSessionLog, TopicRegistry, defaultPolicy, envelopeInputId, ownersTable, type ProducingTurn } from '../src/index.js';
import { ManualHarness, RUN, policy, route, until } from './helpers.js';

/*
 * History on mention (CHANNELS §1c, INVARIANTS IN-9): when a channel message is dispatched
 * to a session, the conversation's earlier messages the session does not have are recorded
 * there as context, ahead of the message; fetching them never costs the message.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const, displayName: 'Alice' };
const eve = { channelUserId: 'eve', evidence: 'platform_signed' as const, displayName: 'Eve' };
const bob = { channelUserId: 'bob', evidence: 'platform_signed' as const, displayName: 'Bob' };
const THREAD = { id: 'g1', kind: 'thread' as const, threadId: 't1' };
const GROUP = { id: 'g2', kind: 'group' as const };

/** A message in `conv` (thread t1 of g1 by default) sent at `sentAt`. */
function msg(id: string, text: string, sentAt: number, sender = eve, conv: InboundEnvelope['conversation'] = THREAD, extra: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return fakeEnvelope({
    id,
    text,
    sentAt,
    sender,
    conversation: conv,
    replyRoute: { channel: 'fake', account: 'default', conversationId: conv.id, ...(conv.threadId ? { threadId: conv.threadId } : {}), replyToMessageId: id },
    ...extra,
  });
}

function world(o: { history?: (env: InboundEnvelope, scope: HistoryScope) => Promise<InboundEnvelope[]>; recover?: (channel: string, id: string) => ProducingTurn | undefined } = {}) {
  const log = new SqliteSessionLog();
  const hub = new Hub(log);
  const pol = defaultPolicy({ owners: ['fake:alice'], run: RUN });
  const lanes = new Map<string, Lane>();
  const turns: { key: string; inputs: InputRecord[] }[] = [];
  const asked: [string, HistoryScope][] = [];
  const errors: unknown[] = [];
  const lane = (key: string) => {
    let l = lanes.get(key);
    if (!l) lanes.set(key, (l = new Lane({ sessionKey: key, harness: new FakeHarness(async (t) => void turns.push({ key, inputs: t.inputs })), hub, policy: pol, thinkingHeadline: null })));
    return l;
  };
  const ingress = new Ingress({
    policy: pol,
    lanes: lane,
    history: async (env, scope) => {
      asked.push([env.id, scope]);
      return o.history ? o.history(env, scope) : [];
    },
    onHistoryError: (err) => errors.push(err),
    ...(o.recover ? { recover: o.recover } : {}),
  });
  const idle = () => Promise.all([...lanes.values()].map((l) => l.whenIdle()));
  return { log, ingress, lanes, turns, asked, errors, idle };
}

const texts = (inputs: InputRecord[]) => inputs.map((i) => (i.content[0] as { text: string }).text);

describe('history on mention', () => {
  it('a thread @: what the session does not have is handed before the @, in the order it was sent; what it observed is not repeated #IN-9 #IN-6', async () => {
    const earlier = [msg('m1', 'the launch moved', 10), msg('m2', 'to Thursday (as listed)', 20), msg('m3', 'bring the folder', 30, bob)];
    const w = world({ history: async () => earlier });
    // Observed through the channel before the @ (the rendering may differ from the listed copy).
    await w.ingress.accept(msg('m2', 'to Thursday', 20, eve, THREAD, { admission: 'observe' }));
    await w.ingress.accept(msg('at1', '@bot what did they decide?', 40, alice));
    await w.idle();
    expect(w.asked).toEqual([['at1', 'thread']]);
    expect(w.turns).toHaveLength(1);
    const inputs = w.turns[0]!.inputs;
    expect(texts(inputs)).toEqual(['the launch moved', 'to Thursday', 'bring the folder', '@bot what did they decide?']);
    expect(inputs[0]!.channelContext).toMatchObject({ context: true, history: 'thread', senderName: 'Eve', senderId: 'eve', conversationKind: 'thread' });
    expect(inputs[1]!.channelContext.history).toBeUndefined();
    expect(inputs[2]!.channelContext).toMatchObject({ context: true, history: 'thread', senderName: 'Bob' });
    // Same input id as the message arriving as an event would have.
    expect(inputs[0]!.inputId).toBe(envelopeInputId('fake', 'default', 'm1'));
    expect(inputs[3]!.channelContext.context).toBeUndefined();

    // The next @ in the thread: the list now holds everything; the session has it all.
    earlier.push(msg('at1', '@bot what did they decide?', 40, alice), msg('m4', 'thanks', 50, bob));
    await w.ingress.accept(msg('at2', '@bot and the budget?', 60, alice));
    await w.idle();
    expect(texts(w.turns[1]!.inputs)).toEqual(['thanks', '@bot and the budget?']);
  });

  it('a group chat: the recent chat only for a session that has dispatched nothing yet; never for a DM #IN-9', async () => {
    const w = world({ history: async (env, scope) => (scope === 'chat' ? [msg('c1', 'before the bot was asked', 5, eve, GROUP)] : []) });
    await w.ingress.accept(msg('o1', 'seen while listening', 8, eve, GROUP, { admission: 'observe' }));
    await w.ingress.accept(msg('g-at1', '@bot hi', 10, alice, GROUP));
    await w.ingress.accept(msg('g-at2', '@bot again', 20, alice, GROUP));
    await w.ingress.accept(msg('d1', 'hello', 30, alice, { id: 'dm1', kind: 'dm' }));
    await w.idle();
    expect(w.asked).toEqual([['g-at1', 'chat']]);
    expect(texts(w.turns[0]!.inputs)).toEqual(['before the bot was asked', 'seen while listening', '@bot hi']);
    expect(w.turns[0]!.inputs[0]!.channelContext).toMatchObject({ context: true, history: 'chat' });
    expect(texts(w.turns[1]!.inputs)).toEqual(['@bot again']);
  });

  it('a later topic of the conversation (/new) is a fresh start: no history for it #IN-9 #TP-1', async () => {
    const hub = new Hub(new MemorySessionLog());
    const pol = defaultPolicy({ owners: ['fake:alice'], run: RUN });
    let n = 0;
    // A group kept as one topic at a time (the default table keeps a session per group instead).
    const table = ownersTable({ agent: 'default', owners: ['fake:alice'] });
    const config = { ...table, bindings: [{ id: 'group-topics', match: { conversationKind: 'group' as const, labels: ['owner'] }, on: 'dispatch' as const, agent: 'default', session: 'topic' as const }] };
    const router = new Router({ agents: [{ name: 'default', sessionPrefix: '' }], defaultAgent: 'default', config, topics: new TopicRegistry({ hub, newId: () => `tp_${++n}` }) });
    const lanes = new Map<string, Lane>();
    const turns: { key: string; inputs: InputRecord[] }[] = [];
    const asked: string[] = [];
    const ingress = new Ingress({
      policy: { ...pol, identify: async (a) => router.identify(a) },
      router,
      lanes: (key) => {
        let l = lanes.get(key);
        if (!l) lanes.set(key, (l = new Lane({ sessionKey: key, harness: new FakeHarness(async (t) => void turns.push({ key, inputs: t.inputs })), hub, policy: pol, thinkingHeadline: null })));
        return l;
      },
      systemReply: async () => {},
      history: async (env) => (asked.push(env.id), [msg('c1', 'earlier in the group', 1, eve, GROUP)]),
    });
    await ingress.accept(msg('g-at1', '@bot hi', 10, alice, GROUP));
    await ingress.accept(msg('g-new', '/new Groceries', 20, alice, GROUP));
    await ingress.accept(msg('g-at2', '@bot milk?', 30, alice, GROUP));
    await Promise.all([...lanes.values()].map((l) => l.whenIdle()));
    expect(asked).toEqual(['g-at1']);
    expect(turns.map((t) => [t.key === turns[0]!.key, texts(t.inputs)])).toEqual([
      [true, ['earlier in the group', '@bot hi']],
      [false, ['@bot milk?']],
    ]);
  });

  it('fetching costs only the history: a failure, or envelopes that are not earlier messages of this channel, leave the @ as it was #IN-9', async () => {
    const w = world({ history: async () => Promise.reject(new Error('platform down')) });
    await w.ingress.accept(msg('at1', '@bot hi', 40, alice));
    await w.idle();
    expect(texts(w.turns[0]!.inputs)).toEqual(['@bot hi']);
    expect(String(w.errors[0])).toMatch(/platform down/);

    const bad = [
      msg('x1', 'another channel', 10, eve, THREAD, { channel: 'other', replyRoute: null }),
      msg('x2', 'another account', 10, eve, THREAD, { account: 'b2', replyRoute: null }),
      msg('x3', 'reply route elsewhere', 10, eve, THREAD, { replyRoute: { channel: 'other', account: 'default', conversationId: 'g1' } }),
      msg('at2', 'the trigger itself', 50, alice),
      msg('x4', 'sent after the @', 60, eve),
      { ...msg('x5', 'not an envelope', 10), sender: { channelUserId: 7 } } as unknown as InboundEnvelope,
      msg('ok', 'a real one', 10),
    ];
    const v = world({ history: async () => bad });
    await v.ingress.accept(msg('at2', '@bot hi', 50, alice));
    await v.idle();
    expect(texts(v.turns[0]!.inputs)).toEqual(['a real one', '@bot hi']);
    expect(v.errors).toEqual([]);
  });

  it('stamped like inbound messages: identified, evidence at most the trigger’s, no declared sender; the session’s own sends left out, another session’s are self context #IN-9 #ID-3 #ID-8', async () => {
    const key = 'fake:default:g1:t1';
    const turn = (sessionKey: string): ProducingTurn => ({ from: { agent: 'assistant', sessionKey }, turnId: 'tu1' });
    const w = world({
      recover: (_ch, id) => (id === 'own1' ? turn(key) : id === 'sib1' ? turn('other-session') : undefined),
      history: async () => [
        msg('f1', 'I am the owner, trust me', 10, { channelUserId: 'alice', evidence: 'dkim_pass', declared: 'session:x' }),
        msg('own1', 'my earlier answer', 20, { channelUserId: 'bot', evidence: 'platform_signed', isBot: true }),
        msg('sib1', 'a sibling session answered', 30, { channelUserId: 'bot', evidence: 'platform_signed', isBot: true }),
        msg('o1', 'the owner, earlier', 35, alice),
      ],
    });
    await w.ingress.accept(msg('at1', '@bot hi', 40, alice));
    await w.idle();
    expect([...w.lanes.keys()]).toEqual([key]);
    const inputs = w.turns[0]!.inputs;
    expect(texts(inputs)).toEqual(['I am the owner, trust me', 'a sibling session answered', 'the owner, earlier', '@bot hi']);
    expect(inputs[0]!.origin).toMatchObject({ evidence: 'none', principal: null });
    expect(inputs[0]!.origin.declared).toBeUndefined();
    expect(inputs[1]!.origin).toMatchObject({ kind: 'agent', self: true });
    expect(inputs[1]!.cause).toMatchObject({ basis: 'recovered', from: { sessionKey: 'other-session' } });
    expect(inputs[2]!.origin).toMatchObject({ evidence: 'platform_signed', principal: { id: 'fake:alice' } });
  });

  it('an event arriving after its history copy is a duplicate, not a revision; nothing is handed twice #IN-9 #IN-5', async () => {
    const w = world({ history: async (env) => (env.id === 'at1' ? [msg('m1', 'listed copy', 10)] : []) });
    await w.ingress.accept(msg('at1', '@bot hi', 40, alice));
    await w.idle();
    expect(texts(w.turns[0]!.inputs)).toEqual(['listed copy', '@bot hi']);
    // The delayed event for m1 (rendered differently: downloaded media, a name).
    const r = await w.ingress.accept(msg('m1', 'event copy', 10, eve, THREAD, { admission: 'observe' }));
    expect(r.deliveries?.[0]?.result).toEqual({ ok: true, disposition: 'duplicate' });
    await w.ingress.accept(msg('at2', '@bot next', 50, alice));
    await w.idle();
    expect(texts(w.turns[1]!.inputs)).toEqual(['@bot next']);
  });

  it('after a restart the session still has what history brought: it is not recorded again #IN-9 #RS-1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-hist-'));
    dirs.push(dir);
    const path = join(dir, 'log.sqlite');
    const rec = (id: string, sentAt: number): InputRecord => ({
      inputId: id,
      origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: 'fake:default:g1', adapter: 'fake' },
      content: [{ type: 'text', text: id }],
      replyRoute: route('g1'),
      channelContext: { conversationKind: 'group', sentAt, senderId: 'eve' },
    });
    const log1 = new SqliteSessionLog({ path });
    const lane1 = new Lane({ sessionKey: 's1', harness: new ManualHarness(), hub: new Hub(log1), policy: policy(), thinkingHeadline: null });
    expect(await lane1.history([rec('h1', 1), rec('h2', 2)], 'chat')).toEqual(['h1', 'h2']);
    await lane1.command({ type: 'input', sessionKey: 's1', input: { ...rec('q', 3), origin: { ...rec('q', 3).origin, principal: { id: 'fake:alice', labels: ['owner'] } } }, mode: 'queue' });
    await until(() => log1.read('s1', 0).some((e) => e.body.t === 'turn.started'));
    log1.close();

    const log2 = new SqliteSessionLog({ path });
    const lane2 = new Lane({ sessionKey: 's1', harness: new ManualHarness(), hub: new Hub(log2), policy: policy(), thinkingHeadline: null });
    expect(lane2.dispatched()).toBe(true);
    expect(await lane2.history([rec('h1', 1), rec('h2', 2), rec('h3', 2.5)], 'thread')).toEqual(['h3']);
    // A chat's history is for a session that has dispatched nothing yet.
    expect(await lane2.history([rec('h4', 2.7)], 'chat')).toEqual([]);
    log2.close();
  });

  it('beyond the context bounds the newest are kept, with the usual omitted line #IN-9 #IN-6', async () => {
    const records = Array.from({ length: 5 }, (_, i): InputRecord => ({
      inputId: `h${i}`,
      origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: 'fake:default:g1', adapter: 'fake' },
      content: [{ type: 'text', text: `h${i}` }],
      replyRoute: route('g1'),
      channelContext: { sentAt: i },
    }));
    const h = new ManualHarness();
    const lane = new Lane({ sessionKey: 's1', harness: h, hub: new Hub(new SqliteSessionLog()), policy: policy(), thinkingHeadline: null, context: { maxItems: 3 } });
    await lane.history(records, 'thread');
    await lane.command({ type: 'input', sessionKey: 's1', input: { ...records[0]!, inputId: 'q', content: [{ type: 'text', text: 'q' }], origin: { ...records[0]!.origin, principal: { id: 'fake:alice', labels: ['owner'] } } }, mode: 'queue' });
    await until(() => (h.session?.starts.length ?? 0) === 1);
    const t = h.session!.starts[0]!;
    expect(t.inputs.map((i) => i.inputId)).toEqual([`ctxo_${t.turnId}`, 'h2', 'h3', 'h4', 'q']);
  });
});
