import { describe, expect, it } from 'vitest';
import { FakeChannel, defaultChannelCaps } from '@agents-io/testkit';
import { Compositor, Hub, MemorySessionLog, Outbox, TOPIC_KEY, TOPIC_TOOLS_HINT, TopicRegistry, formatTopics, newTurnView, renderTurn, titleFrom, topicContext } from '../src/index.js';
import { until } from './helpers.js';

const CONV = 'fake:default:c1';
const key = ({ topicId, first }: { topicId: string; first: boolean }) => (first ? CONV : `${CONV}#${topicId}`);
let ids = 0;
const newId = () => `tp_${++ids}`;

describe('TopicRegistry', () => {
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

describe('topic commands (Ingress)', () => {
  it('inputs routed to a topic carry the hint on how to move between topics when one is configured', () => {
    expect(topicContext({ id: 'tp_1', title: 'A' })).toEqual({ topic: 'tp_1', topicTitle: 'A' });
    expect(topicContext({ id: 'tp_1' }, TOPIC_TOOLS_HINT)).toEqual({ topic: 'tp_1', topicTools: TOPIC_TOOLS_HINT });
    expect(TOPIC_TOOLS_HINT).toMatch(/session_rotate/);
    expect(TOPIC_TOOLS_HINT).toMatch(/session_switch/);
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

describe('a turn handed to another topic', () => {
  const ROUTE = { channel: 'fake', account: 'default', conversationId: 'c1' };
  async function run(tier: 'card' | 'final', back = false) {
    const hub = new Hub(new MemorySessionLog());
    const channel = new FakeChannel('fake', { ...defaultChannelCaps, ...(tier === 'final' ? { edit: false, defaultTier: 'final' as const } : {}) });
    const c = new Compositor({ hub, sessionKey: CONV, adapter: channel, outbox: new Outbox({ hub, sleep: async () => {} }), throttleMs: 1, title: () => 'Rust CLI' });
    c.start();
    const ev = (body: Parameters<Hub['append']>[1]['body'], turnId?: string) =>
      hub.append(CONV, { ts: Date.now(), level: 'primary', audience: body.t === 'text.snapshot' ? 'answer' : 'status', durability: 'durable', ...(turnId ? { turnId } : {}), body });
    ev({ t: 'turn.started', turnId: 't1', inputIds: ['in1'], replyRoute: ROUTE });
    ev({ t: 'topic.changed', conversation: CONV, from: 'tp_a', to: 'tp_b', title: 'Capitals', reason: 'agent' }, 't1');
    // A failed handover switches back (reason system): the turn answers here after all.
    if (back) ev({ t: 'topic.changed', conversation: CONV, from: 'tp_b', to: 'tp_a', title: 'Rust CLI', reason: 'system' }, 't1');
    ev({ t: 'text.snapshot', text: back ? 'Canberra.' : '→ Capitals', final: true }, 't1');
    ev({ t: 'turn.completed', turnId: 't1', status: 'completed' }, 't1');
    if (tier === 'card') await until(() => channel.sent[0]?.finalized);
    else await new Promise((r) => setTimeout(r, 50));
    await c.stop();
    return channel.sent;
  }

  it('its card ends as one line naming the topic it moved to', async () => {
    const [card] = await run('card');
    const final = card!.edits.at(-1)!;
    expect(final.text).toBe('→ Moved to topic "Capitals"');
    expect(final.progress).toMatchObject({ steps: [], answer: '→ Moved to topic "Capitals"', answerFinal: true });
    expect(JSON.stringify(final)).not.toContain('→ Capitals');
  });

  it('a channel that only gets final messages gets none for it', async () => {
    expect(await run('final')).toEqual([]);
  });

  it('a handover switched back renders the answer as usual', async () => {
    const [card] = await run('card', true);
    expect(card!.edits.at(-1)!.text).toBe('Canberra.');
  });
});
