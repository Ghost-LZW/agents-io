import { describe, expect, it } from 'vitest';
import type { BindingTable, ReplyRoute } from '@agents-io/protocol';
import { daemon, type World } from './helpers.js';

/* What a host sees of a message's reply chain and of the topic its own delivery landed in:
   feature paths with no promise behind them (decision 14: local tier). */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const toHost: BindingTable = { version: 'rc1', bindings: [{ id: 'to-host', match: { channel: 'fake' }, on: 'host' }], identities: [], onHostDown: 'keep' };

/** The fake channel answering the route's thread as the platform thread, like Lark's `thread_id`. */
function reportThreads(w: World): void {
  const send = w.chat.send.bind(w.chat);
  w.chat.send = async (route, msg, op) => ({ ...(await send(route, msg, op)), ...(route.threadId ? { providerThreadId: route.threadId } : {}) });
}

describe('host: reply chain and topics', () => {
  it('a queued input carries rootMessageId / parentMessageId in input.channelContext and on the envelope', async () => {
    const w = await daemon();
    const h = await w.host();
    await h.bindingsPut(toHost);
    await w.chat.inject({ id: 'r1', sender: alice, conversation: { id: 'g1', kind: 'thread', threadId: 't1' }, text: 'go on', rootMessageId: 'm_root', parentMessageId: 'm_root' });
    await w.chat.inject({ id: 'r2', sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'plain' });
    const [reply, plain] = (await h.inboundRead({ consumer: 'any' })).items;
    expect(reply!.input.channelContext).toMatchObject({ rootMessageId: 'm_root', parentMessageId: 'm_root' });
    expect(reply!.envelope).toMatchObject({ rootMessageId: 'm_root', parentMessageId: 'm_root' });
    expect(plain!.input.channelContext).not.toHaveProperty('rootMessageId');
    expect(plain!.envelope).not.toHaveProperty('parentMessageId');
  });

  it('deliver answers the platform thread the channel reported (providerThreadId), also as a duplicate after a restart', async () => {
    const w = await daemon();
    reportThreads(w);
    const h = await w.host();
    const topic: ReplyRoute = { channel: 'fake', account: 'default', conversationId: 'g1', threadId: 't9', replyToMessageId: 'm_root' };
    const d = await h.deliver({ operationId: 'n1', route: topic, message: { text: 'notice' } });
    expect(d).toMatchObject({ status: 'delivered', providerMessageId: 'm1', providerThreadId: 't9', duplicate: false });
    expect(await h.deliver({ operationId: 'n1', route: topic, message: { text: 'notice' } })).toMatchObject({ providerThreadId: 't9', duplicate: true });
    const chat = await h.deliver({ operationId: 'n2', route: { channel: 'fake', account: 'default', conversationId: 'g1' }, message: { text: 'in the chat' } });
    expect(chat).toMatchObject({ status: 'delivered', duplicate: false });
    expect(chat).not.toHaveProperty('providerThreadId');
    await w.stop();
    const w2 = await daemon({ dir: w.dir });
    const h2 = await w2.host();
    expect(await h2.deliver({ operationId: 'n1', route: topic, message: { text: 'notice' } })).toMatchObject({ providerMessageId: 'm1', providerThreadId: 't9', duplicate: true });
    expect(w2.chat.sent).toHaveLength(0);
  });
});
