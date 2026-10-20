import { describe, expect, it } from 'vitest';
import type { InputRecord } from '@agents-io/protocol';
import { Hub, Lane, PARTICIPANTS_MAX, SqliteSessionLog } from '../src/index.js';
import { ManualHarness, policy, route } from './helpers.js';

/* Who wrote in a session (`Lane.participants`, what get_channel_context offers mention): no promise behind it (local tier). */

function said(id: string, userId: string, o: { name?: string; bot?: boolean; principal?: string; self?: boolean; conv?: string } = {}): InputRecord {
  return {
    inputId: id,
    origin: {
      kind: o.self ? 'agent' : 'human',
      principal: o.principal ? { id: o.principal, labels: [] } : null,
      evidence: 'platform_signed',
      via: `fake:default:${o.conv ?? 'g1'}`,
      adapter: 'fake',
      ...(o.self ? { self: true } : {}),
    },
    content: [{ type: 'text', text: id }],
    replyRoute: route(o.conv ?? 'g1'),
    channelContext: { conversationId: o.conv ?? 'g1', senderId: userId, ...(o.name ? { senderName: o.name } : {}), ...(o.bot !== undefined ? { senderIsBot: o.bot } : {}) },
  };
}

describe('Lane.participants', () => {
  it('senders of dispatched, context and history inputs, most recent first; names kept, bots marked, own echoes left out; rebuilt after a restart', async () => {
    const log = new SqliteSessionLog();
    const lane = new Lane({ sessionKey: 's1', harness: new ManualHarness(), hub: new Hub(log), policy: policy(), thinkingHeadline: null });
    await lane.observe(said('c1', 'carol', { name: 'Carol' }));
    await lane.observe(said('c2', 'ci', { name: 'CI', bot: true }));
    await lane.history([said('h1', 'dave', { name: 'Dave', conv: 'g1' })], 'thread');
    await lane.observe(said('c3', 'bot', { self: true }));
    await lane.command({ type: 'input', sessionKey: 's1', input: said('q1', 'alice', { name: 'Alice', principal: 'fake:alice' }), mode: 'queue' });
    // Carol again, without a name this time: still known by it, and now the most recent.
    await lane.observe(said('c4', 'carol'));
    const expected = [
      { channel: 'fake', userId: 'carol', name: 'Carol', conversationId: 'g1' },
      { channel: 'fake', userId: 'alice', name: 'Alice', principal: 'fake:alice', conversationId: 'g1' },
      { channel: 'fake', userId: 'dave', name: 'Dave', conversationId: 'g1' },
      { channel: 'fake', userId: 'ci', name: 'CI', isBot: true, conversationId: 'g1' },
    ];
    expect(lane.participants()).toEqual(expected);
    const again = new Lane({ sessionKey: 's1', harness: new ManualHarness(), hub: new Hub(log), policy: policy(), thinkingHeadline: null });
    expect(again.participants()).toEqual(expected);
  });

  it(`keeps the ${PARTICIPANTS_MAX} most recent`, async () => {
    const lane = new Lane({ sessionKey: 's1', harness: new ManualHarness(), hub: new Hub(new SqliteSessionLog()), policy: policy(), thinkingHeadline: null });
    for (let i = 0; i < PARTICIPANTS_MAX + 10; i++) await lane.observe(said(`c${i}`, `u${i}`));
    const ids = lane.participants().map((p) => p.userId);
    expect(ids).toHaveLength(PARTICIPANTS_MAX);
    expect(ids[0]).toBe(`u${PARTICIPANTS_MAX + 9}`);
    expect(ids.at(-1)).toBe('u10');
  });
});
