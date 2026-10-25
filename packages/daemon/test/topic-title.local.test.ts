import { describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessEvent, SessionEvent } from '@agents-io/protocol';
import { withholding } from '@agents-io/session';
import { generateTopicTitle, topicTitlePrompt } from '../src/topic-title.js';

describe('topic title generation', () => {
  it('uses human text and final answers, excluding other event content', () => {
    const event = (body: SessionEvent['body'], audience: SessionEvent['audience'] = 'status') => ({ body, audience }) as SessionEvent;
    const prompt = topicTitlePrompt([
      event({ t: 'input.admitted', inputId: 'i1', disposition: 'new_turn', input: { inputId: 'i1', origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: 'chat', adapter: 'fake' }, content: [{ type: 'text', text: 'Build a calendar' }], replyRoute: null, channelContext: {} } }),
      event({ t: 'text.snapshot', text: 'Use the existing calendar API', final: true }, 'answer'),
      event({ t: 'request.resolved', requestId: 'secret', decision: null, by: 'runtime_cancelled' }),
    ], 'Build a calendar');
    expect(prompt).toContain('User: Build a calendar');
    expect(prompt).toContain('Assistant: Use the existing calendar API');
    expect(prompt).not.toContain('secret');
  });

  it('a session the scoped host checks: what has not passed the check is left out (withholding) #DL-7', () => {
    const route = { channel: 'fake', account: 'default', conversationId: 'g1' };
    const human = { kind: 'human' as const, principal: null, evidence: 'platform_signed' as const, via: 'chat', adapter: 'fake' };
    const e = (seq: number, body: SessionEvent['body'], extra: Partial<SessionEvent> = {}) => ({ seq, ts: seq, level: 'primary', audience: 'status', durability: 'durable', body, ...extra }) as SessionEvent;
    const events = [
      e(1, { t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: route, checked: true }, { turnId: 't1' }),
      e(2, { t: 'input.admitted', inputId: 'i1', disposition: 'new_turn', input: { inputId: 'i1', origin: human, content: [{ type: 'text', text: 'Plan the offsite' }], replyRoute: route, channelContext: {} } }, { turnId: 't1' }),
      e(3, { t: 'text.snapshot', text: 'Held private budget', final: true }, { turnId: 't1', audience: 'answer' }),
      e(4, { t: 'turn.completed', turnId: 't1', status: 'completed' }, { turnId: 't1' }),
      e(5, { t: 'delivery.settled', operationId: 'op1', route, result: 'held', kind: 'reply', turnId: 't1' }, { turnId: 't1' }),
      e(6, { t: 'turn.started', turnId: 't2', inputIds: ['i2'], replyRoute: route, checked: true }, { turnId: 't2' }),
      e(7, { t: 'text.snapshot', text: 'Agenda for the offsite', final: true }, { turnId: 't2', audience: 'answer' }),
      e(8, { t: 'turn.completed', turnId: 't2', status: 'completed' }, { turnId: 't2' }),
      e(9, { t: 'delivery.settled', operationId: 'op2', route, result: 'delivered', kind: 'reply', turnId: 't2' }, { turnId: 't2' }),
    ];
    const w = withholding(events);
    const prompt = topicTitlePrompt(events, undefined, (x) => x.body.t === 'text.snapshot' && w.of(x) !== undefined)!;
    expect(prompt).toContain('User: Plan the offsite');
    expect(prompt).toContain('Assistant: Agenda for the offsite');
    expect(prompt).not.toContain('budget');
  });

  it('generates a title in a separate ephemeral read-only session', async () => {
    let opened: any;
    let closed = false;
    const adapter: HarnessAdapter = {
      id: 'codex', probe: async () => ({ version: 'test', caps: {} as any }),
      open: async (args) => {
        opened = args;
        let turnId = '';
        return {
          nativeId: () => 'helper', startTurn: async (id) => { turnId = id; },
          steer: async () => 'unsupported', interrupt: async () => {}, respond: async () => {},
          close: async () => { closed = true; },
          events: { async *[Symbol.asyncIterator](): AsyncGenerator<HarnessEvent> {
            yield { ts: 1, turnId, level: 'primary', audience: 'answer', durability: 'durable', body: { t: 'text.snapshot', text: 'Plan calendar integration', final: true } };
            yield { ts: 2, turnId, level: 'primary', audience: 'status', durability: 'durable', body: { t: 'turn.completed', turnId, status: 'completed' } };
          } },
        };
      },
    };
    expect(await generateTopicTitle(adapter, { cwd: '/tmp', run: { harness: 'codex', model: 'default', profile: 'bypass' }, prompt: 'Name this task' })).toBe('Plan calendar integration');
    expect(opened.options).toMatchObject({ ephemeral: true, preface: false, profiles: { 'topic-title': { sandbox: 'read-only', approvalPolicy: 'never' } } });
    expect(closed).toBe(true);
  });
});
