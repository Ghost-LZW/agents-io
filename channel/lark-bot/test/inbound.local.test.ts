import { describe, expect, it } from 'vitest';
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

/* Feature-path mapping tests with no promise behind them (decision 14: local tier). */

describe('inbound mapping', () => {
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

  it('a plain quote-reply (root_id = parent_id, no thread_id) is a quote in the chat, not a thread', async () => {
    const { lark, adapter, envs, ctl, done } = await setup();
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_r', chatType: 'group', root: 'om_2', parent: 'om_2', content: { text: 're' } }));
    const e = envs[0]!;
    expect(e.conversation).toEqual({ id: 'oc_chat', kind: 'group' });
    expect(e.replyRoute?.threadId).toBeUndefined();
    expect(e.content[0]).toEqual({ type: 'quote', text: '', fromMessageId: 'om_2' });
    await adapter.send(e.replyRoute!, { text: 'ok' }, { operationId: 'q1' });
    expect(lark.messages.at(-1)!.receive).toEqual({ kind: 'reply', to: 'om_r', inThread: false });
    // In a DM the same.
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_d', root: 'om_1', parent: 'om_1' }));
    expect(envs[1]!.conversation).toEqual({ id: 'oc_chat', kind: 'dm' });
    expect(envs[1]!.content[0]).toMatchObject({ type: 'quote', fromMessageId: 'om_1' });
    ctl.abort();
    await done;
  });

  it('replaces mention placeholders exactly (@_user_1 vs @_user_10)', async () => {
    const { lark, envs, ctl, done } = await setup();
    const mentions = [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' },
      ...Array.from({ length: 8 }, (_, i) => ({ key: `@_user_${i + 2}`, id: { open_id: `ou_${i + 2}` }, name: `P${i + 2}` })),
      { key: '@_user_10', id: { open_id: 'ou_10' }, name: 'Zed' },
    ];
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'group', content: { text: '@_user_1 ask @_user_10 and @_user_2 to review' }, mentions }));
    expect(envs[0]!.content).toEqual([{ type: 'text', text: 'ask @Zed and @P2 to review' }]);
    ctl.abort();
    await done;
  });

  it('thread via thread_id; quote only for real replies', async () => {
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
    // A reply chain without thread_id stays in the chat.
    expect(envs[1]!.conversation).toEqual({ id: 'oc_chat', kind: 'group' });
    expect(envs[1]!.content[0]).toEqual({ type: 'quote', text: '', fromMessageId: 'om_other' });
    // A reply to a specific message inside a topic quotes it and stays in the topic.
    await lark.fire(
      'im.message.receive_v1',
      messageEvent({ id: 'om_t3', chatType: 'group', root: 'om_root', parent: 'om_t1', thread: 'omt_1', content: { text: 'to t1' } }),
    );
    expect(envs[2]).toMatchObject({ conversation: { kind: 'thread', threadId: 'omt_1' } });
    expect(envs[2]!.content[0]).toEqual({ type: 'quote', text: '', fromMessageId: 'om_t1' });
    ctl.abort();
    await done;
  });
});
