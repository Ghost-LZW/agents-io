import { describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessEvent, SessionEvent } from '@agents-io/protocol';
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
