import { describe, expect, it } from 'vitest';
import { make, route, turn } from './process-helpers.js';

/* Acknowledgement reactions on inbound messages, and plain-text replies of the `chat` look. */

describe('acknowledge', () => {
  it('one reaction per message: working, then replaced by done, or removed', async () => {
    const { lark, adapter } = make();
    await adapter.acknowledge(route, 'om_in1', 'working');
    expect([...lark.reactions.values()]).toEqual(['om_in1:OnIt']);
    await adapter.acknowledge(route, 'om_in1', 'done');
    expect([...lark.reactions.values()]).toEqual(['om_in1:DONE']);
    await adapter.acknowledge(route, 'om_in2', 'working');
    await adapter.acknowledge(route, 'om_in2', 'none');
    expect([...lark.reactions.values()]).toEqual(['om_in1:DONE']);
  });

  it('emoji types are configurable; a missing permission turns reactions off, never throws', async () => {
    const { lark, adapter, logs } = make({ ackEmoji: { working: 'Typing', failed: 'ERROR' } });
    await adapter.acknowledge(route, 'om_a', 'working');
    await adapter.acknowledge(route, 'om_a', 'failed');
    expect([...lark.reactions.values()]).toEqual(['om_a:ERROR']);
    lark.fail.set('messageReaction.create', [99991672]);
    await adapter.acknowledge(route, 'om_b', 'working');
    await adapter.acknowledge(route, 'om_c', 'working');
    expect([...lark.reactions.values()]).toEqual(['om_a:ERROR']);
    expect(logs.filter((l) => l.includes('reactions not permitted'))).toHaveLength(1);
  });
});

describe('look: chat plain replies', () => {
  it('a reply that is already final and has nothing to click goes as a text message, not a card', async () => {
    const { lark, adapter } = make({ look: 'chat', process: 'cot' });
    const t = turn();
    t.p.answer = 'Sure, done.';
    t.p.status = 'completed';
    t.p.answerFinal = true;
    await adapter.send(route, t.msg({ text: 'Sure, done.', sections: [{ kind: 'status', text: 'Done' }] }), { operationId: 'o' });
    expect(lark.messages.map((m) => m.msg_type)).toEqual(['text']);
    expect(lark.cards.size).toBe(0);
  });

  it('markdown goes as rich text; anything with buttons, or still running, is a card', async () => {
    const { lark, adapter } = make({ look: 'chat', process: 'cot' });
    const t = turn();
    t.p.status = 'completed';
    await adapter.send(route, t.msg({ text: '**bold** and `code`' }), { operationId: 'a' });
    await adapter.send(route, t.msg({ text: 'pick', actions: [{ id: 'x', label: 'X' }] }), { operationId: 'b' });
    await adapter.send(route, turn('t2').msg({ text: '…' }), { operationId: 'c' });
    expect(lark.messages.map((m) => m.msg_type)).toEqual(['post', 'interactive', 'interactive']);
  });
});
