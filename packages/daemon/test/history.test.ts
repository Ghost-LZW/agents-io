import { describe, expect, it } from 'vitest';
import type { HistoryScope, InboundEnvelope, InputRecord } from '@agents-io/protocol';
import { fakeEnvelope, type FakeHarness } from '@agents-io/testkit';
import { until } from './helpers.js';
import { mcpCall, setup } from './output-tools-helpers.js';

const THREAD = { id: 'g1', kind: 'thread' as const, threadId: 't1' };
const routeOf = (id: string) => ({ channel: 'fake', account: 'default', conversationId: 'g1', threadId: 't1', replyToMessageId: id });

describe('history on mention through the gateway', () => {
  it('a thread @ asks the channel that emitted it; the turn reads the thread first, and its senders can be @-ed #IN-9', async () => {
    const holder: { h?: FakeHarness } = {};
    const turns: InputRecord[][] = [];
    const contexts: { isError: boolean; text: string }[] = [];
    const w = await setup(async (t) => {
      turns.push(t.inputs);
      contexts.push(await mcpCall(holder.h!.sessions.at(-1)!.args.mcp, 'get_channel_context', {}, `toolu_${turns.length}`));
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    });
    holder.h = w.harness;
    const asked: [string, HistoryScope][] = [];
    Object.assign(w.chat, {
      history: async (env: InboundEnvelope, scope: HistoryScope) => {
        asked.push([env.id, scope]);
        return [
          fakeEnvelope({ id: 'h1', channel: 'fake', conversation: THREAD, replyRoute: routeOf('h1'), sentAt: 10, sender: { channelUserId: 'carol', displayName: 'Carol', evidence: 'platform_signed' }, text: 'the plan is in the doc' }),
          fakeEnvelope({ id: 'h2', channel: 'fake', conversation: THREAD, replyRoute: routeOf('h2'), sentAt: 20, sender: { channelUserId: 'ci', displayName: 'CI', isBot: true, evidence: 'platform_signed' }, text: 'build green' }),
        ];
      },
    });
    await w.chat.inject({ id: 'at1', conversation: THREAD, replyRoute: routeOf('at1'), sentAt: 30, sender: { channelUserId: 'alice', displayName: 'Alice', evidence: 'platform_signed' }, text: '@bot summarise' });
    await until(() => contexts.length === 1);
    expect(asked).toEqual([['at1', 'thread']]);
    expect(turns[0]!.map((i) => [(i.content[0] as { text: string }).text, i.channelContext.history ?? null])).toEqual([
      ['the plan is in the doc', 'thread'],
      ['build green', 'thread'],
      ['@bot summarise', null],
    ]);
    const ctx = JSON.parse(contexts[0]!.text);
    expect(ctx.participants).toEqual([
      { principal: 'fake:alice', userId: 'alice', name: 'Alice', channel: 'fake' },
      { userId: 'ci', name: 'CI', channel: 'fake', isBot: true },
      { userId: 'carol', name: 'Carol', channel: 'fake' },
    ]);
  });
});
