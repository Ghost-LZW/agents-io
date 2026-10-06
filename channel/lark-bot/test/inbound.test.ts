import { describe, expect, it } from 'vitest';
import { InboundEnvelope, errors } from '@agents-io/protocol';
import { LarkBotAdapter } from '../src/index.js';
import { FakeLark, messageEvent, startAdapter, tick } from './fake-lark.js';

const cfg = { appId: 'cli_x', appSecret: 's', domain: 'feishu' as const, editMinIntervalMs: 0 };

async function setup(opts: Parameters<typeof startAdapter>[1] = {}, config: Partial<typeof cfg & { botOpenId: string }> = {}) {
  const lark = new FakeLark();
  const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps });
  const run = startAdapter(adapter, opts);
  await tick();
  return { lark, adapter, ...run };
}

describe('inbound mapping', () => {
  it('maps a DM text message and discovers the bot open_id', async () => {
    const { lark, envs, ctl, done } = await setup();
    await lark.fire('im.message.receive_v1', messageEvent());
    expect(envs).toHaveLength(1);
    const e = envs[0]!;
    expect(errors(InboundEnvelope, e)).toEqual([]);
    expect(e).toMatchObject({
      id: 'om_in1',
      channel: 'lark-bot',
      account: 'acct',
      conversation: { id: 'oc_chat', kind: 'dm' },
      sender: { channelUserId: 'on_alice', evidence: 'platform_signed' },
      content: [{ type: 'text', text: 'hello' }],
      replyRoute: { conversationId: 'oc_chat', replyToMessageId: 'om_in1' },
      admission: 'dispatch',
      sentAt: 1700000000000,
    });
    expect(e.sender.isBot).toBeUndefined();
    ctl.abort();
    await done;
  });

  it('falls back to open_id when union_id is absent', async () => {
    const { lark, envs, ctl, done } = await setup();
    await lark.fire('im.message.receive_v1', messageEvent({ sender: { open_id: 'ou_only' } }));
    expect(envs[0]!.sender.channelUserId).toBe('ou_only');
    ctl.abort();
    await done;
  });

  it('flattens post rich text and references its images', async () => {
    const { lark, envs, ctl, done } = await setup();
    await lark.fire(
      'im.message.receive_v1',
      messageEvent({
        type: 'post',
        content: {
          zh_cn: {
            title: 'Title',
            content: [
              [{ tag: 'text', text: 'see ' }, { tag: 'a', text: 'docs', href: 'https://x.test' }],
              [{ tag: 'img', image_key: 'img_1' }],
            ],
          },
        },
      }),
    );
    expect(envs[0]!.content).toEqual([
      { type: 'text', text: 'Title\nsee [docs](https://x.test)\n' .trim() },
      { type: 'image', ref: 'lark-file:om_in1/img_1', mime: 'image/*' },
    ]);
    ctl.abort();
    await done;
  });

  it('maps image, file and audio to ref-style blocks without downloading', async () => {
    const { lark, envs, ctl, done } = await setup();
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_a', type: 'image', content: { image_key: 'k1' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_b', type: 'file', content: { file_key: 'k2', file_name: 'a.pdf' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_c', type: 'audio', content: { file_key: 'k3', duration: 1000 } }));
    expect(envs.map((e) => e.content[0])).toEqual([
      { type: 'image', ref: 'lark-file:om_a/k1', mime: 'image/*' },
      { type: 'file', ref: 'lark-file:om_b/k2', mime: 'application/octet-stream', name: 'a.pdf' },
      { type: 'audio', ref: 'lark-file:om_c/k3', mime: 'audio/*' },
    ]);
    ctl.abort();
    await done;
  });

  it('group: observe unless the bot is @mentioned; strips the bot mention, keeps others as @name', async () => {
    const { lark, envs, ctl, done } = await setup();
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_g1', chatType: 'group', content: { text: 'chatter' } }));
    await lark.fire(
      'im.message.receive_v1',
      messageEvent({
        id: 'om_g2',
        chatType: 'group',
        content: { text: '@_user_1 ask @_user_2 please' },
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' },
          { key: '@_user_2', id: { open_id: 'ou_bob' }, name: 'Bob' },
        ],
      }),
    );
    expect(envs[0]).toMatchObject({ conversation: { kind: 'group' }, admission: 'observe' });
    expect(envs[1]).toMatchObject({ admission: 'dispatch', content: [{ type: 'text', text: 'ask @Bob please' }] });
    expect((envs[1]!.raw as any).botMentioned).toBe(true);
    ctl.abort();
    await done;
  });

  it('uses config.botOpenId without discovery, and observes everything in groups when unknown', async () => {
    const lark = new FakeLark();
    lark.client.request = async () => {
      throw new Error('boom');
    };
    const adapter = new LarkBotAdapter(cfg, { deps: lark.deps });
    const r = startAdapter(adapter);
    await tick();
    await lark.fire(
      'im.message.receive_v1',
      messageEvent({ chatType: 'group', content: { text: '@_user_1 hi' }, mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' }] }),
    );
    expect(r.envs[0]!.admission).toBe('observe');
    expect(r.logs.some((l) => l.includes('discovery failed'))).toBe(true);
    r.ctl.abort();
    await r.done;
  });

  it('thread via root_id / thread_id; quote only for real replies', async () => {
    const { lark, envs, ctl, done } = await setup();
    await lark.fire(
      'im.message.receive_v1',
      messageEvent({ id: 'om_t1', chatType: 'group', root: 'om_root', parent: 'om_root', thread: 'omt_1', content: { text: 'in thread' } }),
    );
    await lark.fire(
      'im.message.receive_v1',
      messageEvent({ id: 'om_t2', chatType: 'group', root: 'om_root', parent: 'om_other', content: { text: 'reply' } }),
    );
    expect(envs[0]).toMatchObject({
      conversation: { id: 'oc_chat', kind: 'thread', threadId: 'omt_1' },
      replyRoute: { threadId: 'omt_1' },
    });
    expect(envs[0]!.content).toEqual([{ type: 'text', text: 'in thread' }]);
    expect(envs[1]!.conversation.threadId).toBe('om_root');
    expect(envs[1]!.content[0]).toEqual({ type: 'quote', text: '', fromMessageId: 'om_other' });
    ctl.abort();
    await done;
  });

  it('maps card.action.trigger to an `action` event block', async () => {
    const { lark, envs, ctl, done } = await setup();
    const ret = await lark.fire('card.action.trigger', {
      event_id: 'ev_card1',
      token: 'tok',
      operator: { open_id: 'ou_alice', union_id: 'on_alice' },
      action: { tag: 'button', value: { actionId: 'approve' } },
      context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
    });
    expect(ret).toEqual({});
    expect(envs[0]).toMatchObject({
      sender: { channelUserId: 'on_alice', evidence: 'platform_signed' },
      content: [{ type: 'event', name: 'action', data: { actionId: 'approve', messageId: 'om_card', value: { actionId: 'approve' } } }],
      replyRoute: { conversationId: 'oc_chat', replyToMessageId: 'om_card' },
    });
    expect(errors(InboundEnvelope, envs[0])).toEqual([]);
    ctl.abort();
    await done;
  });

  it('dedups redelivered messages and card events within the window', async () => {
    const { lark, envs, ctl, done } = await setup();
    const ev = messageEvent();
    await lark.fire('im.message.receive_v1', ev);
    await lark.fire('im.message.receive_v1', { ...ev, event_id: 'ev_other' }); // same message, new event id
    const card = {
      event_id: 'ev_c',
      operator: { open_id: 'ou_a' },
      action: { value: { actionId: 'x' } },
      context: { open_message_id: 'om_c', open_chat_id: 'oc' },
    };
    await lark.fire('card.action.trigger', card);
    await lark.fire('card.action.trigger', card);
    expect(envs).toHaveLength(2);
    ctl.abort();
    await done;
  });

  it('forgets the dedup key when emit fails so the platform redelivery is processed', async () => {
    let fail = true;
    const { lark, envs, ctl, done } = await setup({
      emit: async (env) => {
        if (fail) throw new Error('host down');
        envs.push(env);
        return { accepted: true };
      },
    });
    await lark.fire('im.message.receive_v1', messageEvent());
    await tick();
    fail = false;
    await lark.fire('im.message.receive_v1', messageEvent());
    expect(envs).toHaveLength(1);
    ctl.abort();
    await done;
  });

  it('restarts the SDK ws client after a failed start without throwing', async () => {
    const lark = new FakeLark();
    lark.wsFailuresLeft = 2;
    const adapter = new LarkBotAdapter({ ...cfg, reconnectDelayMs: 1 }, { deps: lark.deps, sleep: () => tick() as Promise<void> });
    const r = startAdapter(adapter);
    await new Promise((res) => setTimeout(res, 50));
    expect(lark.wsStarts).toBe(3);
    r.ctl.abort();
    await r.done;
  });
});
