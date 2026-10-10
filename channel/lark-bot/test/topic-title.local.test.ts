import { describe, expect, it } from 'vitest';
import type { ProgressView, RenderedMessage, ReplyRoute } from '@agents-io/protocol';
import { LarkBotAdapter } from '../src/index.js';
import { buildModel, processCard } from '../src/process-card.js';
import { TOPIC_KEY, buildCard } from '../src/render.js';
import { FakeLark } from './fake-lark.js';

const route: ReplyRoute = { channel: 'lark-bot', account: 'acct', conversationId: 'oc_chat', replyToMessageId: 'om_in1' };
const opts = { locale: 'zh' as const, processElsewhere: false, maxEntries: 8, panelMaxChars: 3000, answerBytes: 10_000, now: 2000 };
const progress = (status: ProgressView['status']): ProgressView => ({ turnId: 't1', status, steps: [], answer: 'ok', answerFinal: status === 'completed', startedAt: 0, endedAt: 2000 });
const withTopic = (msg: RenderedMessage, title: string): RenderedMessage => ({ ...msg, channelData: { [TOPIC_KEY]: { title } } });

describe('topic title in the card header', () => {
  it('process card: the topic title is the header title, the status its subtitle', () => {
    const p = progress('completed');
    const card = processCard(buildModel(withTopic({ text: 'ok', progress: p }, 'Rust CLI'), p, opts)) as any;
    expect(card.header).toEqual({ title: { tag: 'plain_text', content: 'Rust CLI' }, subtitle: { tag: 'plain_text', content: '已完成' }, template: 'green' });
    // No topic: the status stays the title, no subtitle.
    const plain = processCard(buildModel({ text: 'ok', progress: p }, p, opts)) as any;
    expect(plain.header).toEqual({ title: { tag: 'plain_text', content: '已完成' }, template: 'green' });
    // Long titles are clipped to one short line.
    const long = processCard(buildModel(withTopic({ text: 'ok', progress: p }, `a\nb ${'x'.repeat(100)}`), p, opts)) as any;
    expect(long.header.title.content.length).toBe(60);
    expect(long.header.title.content.startsWith('a b ')).toBe(true);
  });

  it('plain cards (sections, buttons) get a header with the topic title', () => {
    const card = buildCard(withTopic({ text: 'hi', sections: [{ kind: 'status', text: 'Done' }] }, 'Groceries')) as any;
    expect(card.header).toEqual({ title: { tag: 'plain_text', content: 'Groceries' }, template: 'blue' });
    expect((buildCard({ text: 'hi', sections: [{ kind: 'status', text: 'Done' }] }) as any).header).toBeUndefined();
  });

  it('a streamed turn of a topic session shows the topic title from create to final', async () => {
    const lark = new FakeLark();
    const adapter = new LarkBotAdapter({ appId: 'cli_x', appSecret: 's', domain: 'feishu', process: 'panels', editMinIntervalMs: 0, streamTextIntervalMs: 0, streamAuxIntervalMs: 0 }, { deps: lark.deps, sleep: async () => {}, log: () => {} });
    const running = progress('running');
    const { providerMessageId } = await adapter.send(route, withTopic({ text: '…', sections: [{ kind: 'status', text: 'Working…' }], progress: running }, 'Groceries'), { operationId: 'op1' });
    const m = lark.messages.find((x) => x.id === providerMessageId)!;
    const card = lark.cards.get(JSON.parse(m.content).data.card_id)!;
    expect(card.json.header.title.content).toBe('Groceries');
    const done = progress('completed');
    await adapter.finalize(route, providerMessageId!, withTopic({ text: 'ok', sections: [{ kind: 'status', text: 'Done' }], progress: done }, 'Groceries'));
    await adapter.settled();
    expect(card.json.header).toMatchObject({ title: { content: 'Groceries' }, subtitle: { content: '已完成' }, template: 'green' });
  });
});
