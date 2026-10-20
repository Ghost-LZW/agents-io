import { describe, expect, it } from 'vitest';
import type { InboundEnvelope } from '@agents-io/protocol';
import { LarkBotAdapter } from '../src/index.js';
import { FakeLark, messageEvent, reactionEvent, startAdapter, tick } from './fake-lark.js';

/* How reactions are placed: the chat's kind, topics, lookups, order. */

const cfg = { appId: 'cli_x', appSecret: 's', domain: 'feishu' as const, editMinIntervalMs: 0 };
const route = (over: { conversationId?: string; replyToMessageId?: string; threadId?: string } = {}) => ({
  channel: 'lark-bot',
  account: 'acct',
  conversationId: over.conversationId ?? 'oc_chat',
  ...(over.replyToMessageId ? { replyToMessageId: over.replyToMessageId } : {}),
  ...(over.threadId ? { threadId: over.threadId } : {}),
});

async function setup(emit?: (env: InboundEnvelope) => Promise<unknown>) {
  const lark = new FakeLark();
  const adapter = new LarkBotAdapter(cfg, { deps: lark.deps });
  const run = startAdapter(adapter, emit ? { emit: emit as never } : {});
  await tick();
  return { lark, adapter, ...run };
}
const kindOf = (e: InboundEnvelope | undefined) => e && [e.conversation.kind, e.conversation.id, e.conversation.threadId];

describe('reaction placement', () => {
  it('a chat seen since the start keeps its kind; an unseen one is asked (chat.get) once, then known', async () => {
    const { lark, adapter, envs, ctl, done } = await setup();
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'bot' }] }));
    const inGroup = (await adapter.send(route({ replyToMessageId: 'om_in1' }), { text: 'hi all' }, { operationId: 'a' })).providerMessageId!;
    // After a restart nothing about oc_dm was seen: chat.get says it is a DM.
    lark.chats.set('oc_dm', 'p2p');
    const inDm = (await adapter.send(route({ conversationId: 'oc_dm' }), { text: 'reminder' }, { operationId: 'b' })).providerMessageId!;
    envs.length = 0;
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: inGroup }));
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: inDm }));
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: inDm, emoji: 'OK' }));
    expect(envs.map(kindOf)).toEqual([
      ['group', 'oc_chat', undefined],
      ['dm', 'oc_dm', undefined],
      ['dm', 'oc_dm', undefined],
    ]);
    expect(lark.lookups.filter((l) => l.startsWith('chat:'))).toEqual(['chat:oc_dm']);
    // The message itself is looked up once.
    expect(lark.lookups.filter((l) => l === `get:${inDm}`)).toHaveLength(1);
    ctl.abort();
    await done;
  });

  it('an answer in a topic is a thread input of that topic', async () => {
    const { lark, adapter, envs, ctl, done } = await setup();
    lark.placedAt.set('om_t1', { chat_id: 'oc_g', thread_id: 'omt_9' });
    const id = (await adapter.send(route({ conversationId: 'oc_g', replyToMessageId: 'om_t1', threadId: 'omt_9' }), { text: 'in the topic' }, { operationId: 'a' })).providerMessageId!;
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: id }));
    expect(envs.map(kindOf)).toEqual([['thread', 'oc_g', 'omt_9']]);
    expect(envs[0]!.replyRoute).toMatchObject({ conversationId: 'oc_g', threadId: 'omt_9', replyToMessageId: id });
    ctl.abort();
    await done;
  });

  it('without the chat\'s kind the reaction is dropped, with one warning; a message that cannot be read too', async () => {
    const { lark, adapter, envs, logs, ctl, done } = await setup();
    const a = (await adapter.send(route({ conversationId: 'oc_x' }), { text: 'one' }, { operationId: 'a' })).providerMessageId!;
    const b = (await adapter.send(route({ conversationId: 'oc_y' }), { text: 'two' }, { operationId: 'b' })).providerMessageId!;
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: a }));
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: b }));
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: 'om_gone' }));
    expect(envs).toHaveLength(0);
    expect(logs.filter((l) => l.startsWith('warn') && l.includes('chat\'s kind is unknown'))).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith('warn') && l.includes('om_gone'))).toHaveLength(1);
    ctl.abort();
    await done;
  });

  it('a redelivered event passes once; reactions on one message reach the host in the order they came', async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { lark, adapter, ctl, done } = await setup(async (env) => {
      const d = env.content[0]?.type === 'event' ? (env.content[0].data as { action: string; emoji: string }) : undefined;
      if (d?.action === 'added' && d.emoji === 'THUMBSUP') await slow;
      if (d) order.push(`${d.action} ${d.emoji}`);
      return { accepted: true, inputId: env.id };
    });
    await lark.fire('im.message.receive_v1', messageEvent());
    const id = (await adapter.send(route({ replyToMessageId: 'om_in1' }), { text: 'x' }, { operationId: 'a' })).providerMessageId!;
    order.length = 0;
    const first = lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: id }));
    await tick();
    const second = lark.fire('im.message.reaction.deleted_v1', reactionEvent({ messageId: id, removed: true }));
    await tick();
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: id })); // redelivered
    await tick();
    expect(order).toEqual(['added THUMBSUP', 'removed THUMBSUP']);
    ctl.abort();
    await done;
  });

  it('a reaction on a thinking bubble of the bot is not on an answer: dropped', async () => {
    const { lark, envs, ctl, done } = await setup();
    // A bubble the bot opened: a message of the app, of a type no answer has.
    lark.foreign.set('om_cot1', { message_id: 'om_cot1', msg_type: 'message_cot', chat_id: 'oc_chat', sender: { id: 'cli_x', id_type: 'app_id', sender_type: 'app' } });
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: 'om_cot1' }));
    expect(envs).toHaveLength(0);
    ctl.abort();
    await done;
  });

  it('`reactions: false` passes none on, and looks nothing up', async () => {
    const lark = new FakeLark();
    const adapter = new LarkBotAdapter({ ...cfg, reactions: false }, { deps: lark.deps });
    const { envs, ctl, done } = startAdapter(adapter);
    await tick();
    const id = (await adapter.send(route({ replyToMessageId: 'om_in1' }), { text: 'x' }, { operationId: 'a' })).providerMessageId!;
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: id }));
    expect(envs).toHaveLength(0);
    expect(lark.lookups.filter((l) => l.startsWith('get:'))).toEqual([]);
    ctl.abort();
    await done;
  });
});
