import { describe, expect, it } from 'vitest';
import { InboundEnvelope, errors } from '@agents-io/protocol';
import { LarkBotAdapter, type LarkBotConfig } from '../src/index.js';
import { FakeLark, messageEvent, reactionEvent, startAdapter, tick } from './fake-lark.js';

/* People's reactions on the bot's messages (`config.reactions`): always observe, only on the bot's own messages. */

const cfg = { appId: 'cli_x', appSecret: 's', domain: 'feishu' as const, editMinIntervalMs: 0 };

async function setup(config: Partial<LarkBotConfig> = {}) {
  const lark = new FakeLark();
  lark.users.set('on_alice', { name: 'Alice' });
  const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps });
  const run = startAdapter(adapter);
  await tick();
  // Alice writes to the bot in a DM; the bot answers her.
  await lark.fire('im.message.receive_v1', messageEvent());
  const { providerMessageId } = await adapter.send(
    { channel: 'lark-bot', account: 'acct', conversationId: 'oc_chat', replyToMessageId: 'om_in1' },
    { text: 'Sure, it is 3 pm.' },
    { operationId: 'op1' },
  );
  run.envs.length = 0;
  return { lark, adapter, answer: providerMessageId!, ...run };
}

describe('reactions', () => {
  it('a person\'s reaction on the bot\'s answer is an observe input of the answer\'s conversation; apps\' reactions and reactions on others\' messages never pass #RT-2', async () => {
    const { lark, envs, answer, ctl, done } = await setup();
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: answer }));
    expect(envs).toHaveLength(1);
    const e = envs[0]!;
    expect(errors(InboundEnvelope, e)).toEqual([]);
    expect(e).toMatchObject({
      channel: 'lark-bot',
      account: 'acct',
      conversation: { id: 'oc_chat', kind: 'dm' },
      sender: { channelUserId: 'on_alice', displayName: 'Alice', evidence: 'platform_signed' },
      content: [{ type: 'event', name: 'reaction', data: { emoji: 'THUMBSUP', action: 'added', messageId: answer, text: 'Sure, it is 3 pm.' } }],
      replyRoute: { conversationId: 'oc_chat', replyToMessageId: answer },
      admission: 'observe',
      sentAt: 1700000100000,
    });
    // Never the message's own id (the outbound index would take it for an echo of ours).
    expect(e.id).not.toBe(answer);

    // Taken back: another input, `removed`.
    await lark.fire('im.message.reaction.deleted_v1', reactionEvent({ messageId: answer, removed: true }));
    expect(envs.map((x) => x.content[0])).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ action: 'added' }) }),
      expect.objectContaining({ data: expect.objectContaining({ action: 'removed' }) }),
    ]);
    expect(envs.every((x) => x.admission === 'observe')).toBe(true);

    // The bot's own acknowledgement (an app's reaction) on the person's message, another app's on the answer.
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: 'om_in1', emoji: 'OnIt', app: 'cli_x' }));
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: answer, emoji: 'OnIt', app: 'cli_other' }));
    // A person's reaction on someone else's message.
    lark.foreign.set('om_in1', { message_id: 'om_in1', msg_type: 'text', chat_id: 'oc_chat', body: { content: '{"text":"hello"}' }, sender: { id: 'ou_alice', id_type: 'open_id', sender_type: 'user' } });
    await lark.fire('im.message.reaction.created_v1', reactionEvent({ messageId: 'om_in1', emoji: 'SMILE' }));
    expect(envs).toHaveLength(2);
    ctl.abort();
    await done;
  });
});
