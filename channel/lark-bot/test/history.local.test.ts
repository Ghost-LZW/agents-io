import { describe, expect, it } from 'vitest';
import { InboundEnvelope, errors } from '@agents-io/protocol';
import { LarkBotAdapter, type LarkBotConfig } from '../src/index.js';
import { resolveConfig } from '../src/config.js';
import { MENTIONS_KEY } from '../src/render.js';
import { FakeLark, listed, messageEvent, startAdapter, tick } from './fake-lark.js';

/* Feature-path tests of history on mention with no promise behind them (decision 14: local tier). */

const cfg = { appId: 'cli_x', appSecret: 's', domain: 'feishu' as const, editMinIntervalMs: 0 };
const AT_BOT = [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'bot' }];
/** messageEvent's create_time. */
const T = 1_700_000_000_000;

async function setup(config: Partial<LarkBotConfig> = {}) {
  const lark = new FakeLark();
  const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps });
  const run = startAdapter(adapter);
  await tick();
  return { lark, adapter, ...run };
}

const text = (e: InboundEnvelope) => e.content.map((b) => (b.type === 'text' || b.type === 'quote' ? `${b.type === 'quote' ? '> ' : ''}${b.text}` : `[${b.type} ${'ref' in b ? b.ref : ''}]`)).join(' | ');

describe('history on mention: what the adapter returns', () => {
  it('a thread: oldest first, without the @ itself, later, deleted or system messages; mapped like inbound events, nothing downloaded', async () => {
    const t = await setup();
    // Alice is known from an event (union_id ↔ open_id); Bob only through contact.
    t.lark.users.set('ou_bob', { name: 'Bob', union_id: 'on_bob' });
    t.lark.users.set('on_alice', { name: 'Alice' });
    t.lark.histories.set('thread:omt_1', [
      listed({ id: 'om_root', text: 'launch plan?', at: T - 50_000, user: 'ou_alice' }),
      listed({ id: 'om_2', text: '@_user_1 thinks Thursday', at: T - 40_000, user: 'ou_bob', mentions: [{ key: '@_user_1', id: 'ou_carol', name: 'Carol' }] }),
      listed({ id: 'om_3', type: 'image', content: { image_key: 'img_1' }, at: T - 30_000, user: 'ou_bob' }),
      listed({ id: 'om_4', text: 'Thursday it is', at: T - 20_000, app: 'cli_x' }),
      listed({ id: 'om_5', text: 'build is green', at: T - 15_000, app: 'cli_other' }),
      listed({ id: 'om_gone', text: 'oops', at: T - 12_000, user: 'ou_bob', deleted: true }),
      listed({ id: 'om_sys', type: 'system', content: { template: 'x joined' }, at: T - 11_000, user: 'ou_bob' }),
      listed({ id: 'om_6', text: '@_user_1 summary please', at: T - 10_000, user: 'ou_bob', mentions: [{ key: '@_user_1', id: 'ou_bot', name: 'bot' }] }),
      listed({ id: 'om_at', text: '@_user_1 what now?', at: T, user: 'ou_alice' }),
      listed({ id: 'om_after', text: 'too late', at: T + 5_000, user: 'ou_bob' }),
    ]);
    await t.lark.fire('im.message.receive_v1', messageEvent({ id: 'om_at', chatType: 'group', thread: 'omt_1', root: 'om_root', parent: 'om_root', mentions: AT_BOT, content: { text: '@_user_1 what now?' } }));
    const at = t.envs[0]!;
    const got = await t.adapter.history(at, 'thread');
    expect(got.map((e) => e.id)).toEqual(['om_root', 'om_2', 'om_3', 'om_4', 'om_5', 'om_6']);
    for (const e of got) expect(errors(InboundEnvelope, e)).toEqual([]);
    expect(got.map(text)).toEqual([
      'launch plan?',
      '@Carol thinks Thursday',
      '[image lark-file:om_3/img_1]',
      'Thursday it is',
      'build is green',
      'summary please',
    ]);
    expect(got.map((e) => [e.sender.channelUserId, e.sender.displayName ?? null, e.sender.isBot ?? false])).toEqual([
      ['on_alice', 'Alice', false],
      ['on_bob', 'Bob', false],
      ['on_bob', 'Bob', false],
      ['ou_bot', null, true],
      ['cli_other', null, true],
      ['on_bob', 'Bob', false],
    ]);
    expect(got[0]).toMatchObject({
      channel: 'lark-bot',
      account: 'acct',
      admission: 'observe',
      conversation: { id: 'oc_chat', kind: 'thread', threadId: 'omt_1' },
      replyRoute: { conversationId: 'oc_chat', threadId: 'omt_1', replyToMessageId: 'om_root' },
      sentAt: T - 50_000,
    });
    expect(got[0]!.raw).toBeUndefined();
    expect(t.lark.lookups.filter((l) => l.startsWith('resource:'))).toEqual([]);
    expect(t.lark.lookups.filter((l) => l.startsWith('list:'))).toEqual(['list:thread:omt_1:50']);
    t.ctl.abort();
    await t.done;
  });

  it('a chat: the most recent `chat` messages up to the @, quotes from among them, topic roots as chat messages', async () => {
    const t = await setup({ historyOnMention: { chat: 3 } });
    t.lark.histories.set('chat:oc_chat', [
      listed({ id: 'om_1', text: 'old', at: T - 90_000 }),
      listed({ id: 'om_2', text: 'the plan', at: T - 30_000 }),
      listed({ id: 'om_3', text: 'agreed', at: T - 20_000, parent: 'om_2', root: 'om_2' }),
      listed({ id: 'om_4', text: 'see thread', at: T - 10_000, thread: 'omt_9' }),
      listed({ id: 'om_5', text: 'replying to old', at: T - 5_000, parent: 'om_1', root: 'om_1' }),
    ]);
    await t.lark.fire('im.message.receive_v1', messageEvent({ id: 'om_at', chatType: 'group', mentions: AT_BOT, content: { text: '@_user_1 hi' } }));
    const got = await t.adapter.history(t.envs[0]!, 'chat');
    expect(got.map((e) => e.id)).toEqual(['om_3', 'om_4', 'om_5']);
    // om_3 quotes om_2, which was not among the 3 kept: no lookup per message, so no quote. om_5's om_1 is not there either.
    expect(got.map(text)).toEqual(['agreed', 'see thread', 'replying to old']);
    expect(got[1]!.conversation).toEqual({ id: 'oc_chat', kind: 'group' });
    // The time window ends at the @ (seconds).
    expect(t.lark.lookups.filter((l) => l.startsWith('list:'))).toEqual(['list:chat:oc_chat:4']);
    t.lark.histories.set('chat:oc_chat', [listed({ id: 'om_a', text: 'question', at: T - 2000 }), listed({ id: 'om_b', text: 'answer', at: T - 1000, parent: 'om_a', root: 'om_a' })]);
    expect((await t.adapter.history(t.envs[0]!, 'chat')).map(text)).toEqual(['question', '> question | answer']);
    t.ctl.abort();
    await t.done;
  });

  it('cards as their text, stickers as a placeholder; the bot’s own thinking bubbles and non-message types are left out', async () => {
    const t = await setup();
    await t.lark.fire('im.message.receive_v1', messageEvent({ id: 'om_at', chatType: 'group', thread: 'omt_1', root: 'om_1', parent: 'om_1', mentions: AT_BOT, content: { text: '@_user_1 hi' } }));
    // A thinking bubble this bot opened in the thread is a message there too.
    const p = { turnId: 't1', status: 'running' as const, steps: [{ kind: 'reasoning' as const, id: 'r0', text: 'Checking', done: false }], answer: '', answerFinal: false, startedAt: 1000 };
    await t.adapter.previewProgress({ channel: 'lark-bot', account: 'acct', conversationId: 'oc_chat', threadId: 'omt_1', replyToMessageId: 'om_at' }, p, false);
    expect(t.lark.cots.map((c) => c.messageId)).toEqual(['om_cot1']);
    const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Deploy **done**' }] } };
    t.lark.histories.set('thread:omt_1', [
      listed({ id: 'om_1', type: 'interactive', content: card, at: T - 5000, app: 'cli_ci' }),
      listed({ id: 'om_2', type: 'sticker', content: { file_key: 'stk' }, at: T - 4000 }),
      listed({ id: 'om_cot1', type: 'interactive', content: { elements: [{ tag: 'markdown', content: 'Checking' }] }, at: T - 3000, app: 'cli_x' }),
      listed({ id: 'om_3', type: 'share_chat', content: { chat_id: 'oc_x' }, at: T - 2000, app: 'cli_x' }),
      listed({ id: 'om_4', type: 'interactive', content: card, at: T - 1000, app: 'cli_x' }),
    ]);
    const got = await t.adapter.history(t.envs[0]!, 'thread');
    expect(got.map((e) => [e.id, text(e)])).toEqual([
      ['om_1', 'Deploy **done**'],
      ['om_2', '[sticker]'],
      ['om_4', 'Deploy **done**'],
    ]);
    t.ctl.abort();
    await t.done;
  });

  it('pages past 50; historyOnMention false or 0 makes no call', async () => {
    const t = await setup({ historyOnMention: { thread: 120 } });
    t.lark.histories.set('thread:omt_1', Array.from({ length: 130 }, (_, i) => listed({ id: `om_${i}`, text: `m${i}`, at: T - 200_000 + i })));
    await t.lark.fire('im.message.receive_v1', messageEvent({ id: 'om_at', chatType: 'group', thread: 'omt_1', root: 'om_0', parent: 'om_0', mentions: AT_BOT, content: { text: '@_user_1 hi' } }));
    const got = await t.adapter.history(t.envs[0]!, 'thread');
    expect(got).toHaveLength(120);
    expect(got[0]!.id).toBe('om_10');
    expect(got.at(-1)!.id).toBe('om_129');
    expect(t.lark.lookups.filter((l) => l.startsWith('list:'))).toEqual(['list:thread:omt_1:50', 'list:thread:omt_1:50:50', 'list:thread:omt_1:21:100']);
    t.ctl.abort();
    await t.done;

    for (const off of [false, { thread: 0, chat: false }] as const) {
      const u = await setup({ historyOnMention: off });
      await u.lark.fire('im.message.receive_v1', messageEvent({ id: 'om_at', chatType: 'group', thread: 'omt_1', root: 'om_0', parent: 'om_0', mentions: AT_BOT, content: { text: '@_user_1 hi' } }));
      expect(await u.adapter.history(u.envs[0]!, 'thread')).toEqual([]);
      expect(await u.adapter.history(u.envs[0]!, 'chat')).toEqual([]);
      expect(u.lark.lookups.filter((l) => l.startsWith('list:'))).toEqual([]);
      u.ctl.abort();
      await u.done;
    }
  });

  it('config: defaults { thread: 50, chat: 20 }, true, false, per key; anything else is an error', () => {
    const r = (h: unknown) => resolveConfig({ ...cfg, historyOnMention: h as LarkBotConfig['historyOnMention'] }).historyOnMention;
    expect(r(undefined)).toEqual({ thread: 50, chat: 20 });
    expect(r(true)).toEqual({ thread: 50, chat: 20 });
    expect(r(false)).toEqual({ thread: 0, chat: 0 });
    expect(r({ chat: 5 })).toEqual({ thread: 50, chat: 5 });
    expect(r({ thread: false })).toEqual({ thread: 0, chat: 20 });
    expect(() => r({ thread: 201 })).toThrow(/historyOnMention.thread/);
    expect(() => r({ chat: 1.5 })).toThrow(/historyOnMention.chat/);
    expect(() => r({ topic: 3 })).toThrow(/historyOnMention has no "topic"/);
    expect(() => r('yes')).toThrow(/historyOnMention/);
  });

  it('someone first seen in history can be @-ed: their union_id resolves to the open_id for the at tag', async () => {
    const t = await setup();
    t.lark.users.set('ou_dave', { name: 'Dave', union_id: 'on_dave' });
    t.lark.histories.set('thread:omt_1', [listed({ id: 'om_1', text: 'hi', at: T - 1000, user: 'ou_dave' })]);
    await t.lark.fire('im.message.receive_v1', messageEvent({ id: 'om_at', chatType: 'group', thread: 'omt_1', root: 'om_1', parent: 'om_1', mentions: AT_BOT, content: { text: '@_user_1 hi' } }));
    const [dave] = await t.adapter.history(t.envs[0]!, 'thread');
    expect(dave!.sender.channelUserId).toBe('on_dave');
    const route = { channel: 'lark-bot', account: 'acct', conversationId: 'oc_chat', threadId: 'omt_1', replyToMessageId: 'om_at' };
    await t.adapter.send(route, { text: '@Dave look', channelData: { [MENTIONS_KEY]: { targets: [{ id: 'on_dave', name: 'Dave' }, { id: 'on_nobody', name: 'Nobody' }], text: 'look' } } }, { operationId: 'op-m' });
    const sent = t.lark.messages.at(-1)!;
    expect(JSON.parse(sent.content).text).toBe('<at user_id="ou_dave">Dave</at> @Nobody look');
    t.ctl.abort();
    await t.done;
  });
});
