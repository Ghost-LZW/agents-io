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
  it('maps a DM text message and discovers the bot open_id #ID-1', async () => {
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

  it('falls back to open_id when union_id is absent #ID-1', async () => {
    const { lark, envs, ctl, done } = await setup();
    await lark.fire('im.message.receive_v1', messageEvent({ sender: { open_id: 'ou_only' } }));
    expect(envs[0]!.sender.channelUserId).toBe('ou_only');
    ctl.abort();
    await done;
  });

  it('maps card.action.trigger to an `action` event block #ID-1', async () => {
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

  it('dedups redelivered messages and card events within the window #IN-5', async () => {
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

  it('forgets the dedup key when emit fails so the platform redelivery is processed #IN-7 #IN-5', async () => {
    let fail = true;
    const { lark, envs, ctl, done } = await setup({
      emit: async (env) => {
        if (fail) throw new Error('host down');
        envs.push(env);
        return { accepted: true };
      },
    });
    // The handler rejects, so the SDK answers 500 and Lark redelivers.
    await expect(lark.fire('im.message.receive_v1', messageEvent())).rejects.toThrow('host down');
    fail = false;
    await lark.fire('im.message.receive_v1', messageEvent());
    expect(envs).toHaveLength(1);
    ctl.abort();
    await done;
  });

  it('a card click whose emit fails is not acked either #IN-7', async () => {
    let fail = true;
    const { lark, envs, ctl, done } = await setup({
      emit: async (env) => {
        if (fail) throw new Error('host down');
        envs.push(env);
        return { accepted: true };
      },
    });
    const card = { event_id: 'ev_c', operator: { open_id: 'ou_a' }, action: { value: { actionId: 'x' } }, context: { open_message_id: 'om_c', open_chat_id: 'oc' } };
    await expect(lark.fire('card.action.trigger', card)).rejects.toThrow('host down');
    fail = false;
    await lark.fire('card.action.trigger', card);
    expect(envs).toHaveLength(1);
    ctl.abort();
    await done;
  });

  it('an emit answering accepted:false is not acked and leaves no dedup key, so the redelivery gets in #IN-7', async () => {
    let refuse = true;
    const { lark, envs, ctl, done } = await setup({
      emit: async (env) => {
        if (refuse) return { accepted: false, error: 'gateway stopping' };
        envs.push(env);
        return { accepted: true };
      },
    });
    await expect(lark.fire('im.message.receive_v1', messageEvent())).rejects.toThrow();
    refuse = false;
    await lark.fire('im.message.receive_v1', messageEvent());
    expect(envs).toHaveLength(1);
    ctl.abort();
    await done;
  });

  it('a permanent refusal (an envelope the host will never take) is acked: redelivery cannot help #IN-7', async () => {
    let emitted = 0;
    const { lark, ctl, done } = await setup({
      emit: async () => {
        emitted++;
        return { accepted: false, permanent: true, error: 'invalid envelope' };
      },
    });
    await lark.fire('im.message.receive_v1', messageEvent());
    await lark.fire('im.message.receive_v1', messageEvent());
    expect(emitted).toBe(1);
    ctl.abort();
    await done;
  });

  it('an emit that fails after the ack deadline is retried by the adapter, keeping the dedup key #IN-7 #IN-5', async () => {
    const lark = new FakeLark();
    const adapter = new LarkBotAdapter({ ...cfg, ackTimeoutMs: 5 }, { deps: lark.deps, sleep: () => tick() as Promise<void> });
    let calls = 0;
    const r = startAdapter(adapter, {
      emit: async (env) => {
        calls++;
        if (calls === 1) {
          await new Promise((res) => setTimeout(res, 20));
          throw new Error('host slow and down');
        }
        r.envs.push(env);
        return { accepted: true };
      },
    });
    await tick();
    await lark.fire('im.message.receive_v1', messageEvent()); // acked at the deadline
    await lark.fire('im.message.receive_v1', messageEvent()); // a redelivery meanwhile is ours already
    for (let i = 0; i < 40 && r.envs.length === 0; i++) await tick();
    expect(r.envs).toHaveLength(1);
    expect(calls).toBe(2);
    expect(r.logs.some((l) => l.includes('retrying'))).toBe(true);
    r.ctl.abort();
    await r.done;
  });

  it('a failing declared-sender lookup is not acked and leaves no dedup key behind #IN-7', async () => {
    const lark = new FakeLark();
    let broken = true;
    const store = {
      set: () => {},
      get: async () => {
        if (broken) throw new Error('db timeout');
        return 'runner:me/agentA';
      },
    };
    const adapter = new LarkBotAdapter(cfg, { deps: lark.deps, store });
    const r = startAdapter(adapter);
    await tick();
    const ev = messageEvent({ sender: { open_id: 'ou_other_bot' }, senderType: 'app' });
    await expect(lark.fire('im.message.receive_v1', ev)).rejects.toThrow('db timeout');
    broken = false;
    await lark.fire('im.message.receive_v1', ev);
    expect(r.envs).toHaveLength(1);
    expect(r.envs[0]!.sender.declared).toBe('runner:me/agentA');
    r.ctl.abort();
    await r.done;
  });

  it('restarts the SDK ws client after a failed start without throwing #CF-1', async () => {
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
