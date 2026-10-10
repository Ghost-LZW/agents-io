import { describe, expect, it } from 'vitest';
import { input, turnOf, world } from './topic-tools-helpers.js';

describe('topic tools', () => {
  it('session_list shows the conversation topics and marks the caller; it needs no running turn', async () => {
    const w = world();
    w.setTurn(undefined);
    const r = await w.run('session_list');
    expect(r.topics).toEqual([
      expect.objectContaining({ topicId: 'tp_a', title: 'Rust CLI', current: true, you: true }),
      expect.objectContaining({ topicId: 'tp_b', title: 'Groceries', current: false }),
    ]);
    expect(r.topics[1].you).toBeUndefined();
    await expect(w.run('session_list', {}, 'x', 'not-a-topic')).rejects.toThrow(/does not keep topics/);
  });

  it('session_rotate needs a title, a summary and a running turn with a message', async () => {
    const w = world();
    await expect(w.run('session_rotate', { title: 'x' })).rejects.toThrow(/summary is required/);
    await expect(w.run('session_rotate', { summary: 'x' })).rejects.toThrow(/title is required/);
    w.setTurn(turnOf([input('ctx1', { context: true })]));
    await expect(w.run('session_rotate', { title: 'x', summary: 'y' })).rejects.toThrow(/no message to hand over/);
    w.setTurn(undefined);
    await expect(w.run('session_rotate', { title: 'x', summary: 'y' })).rejects.toThrow(/no turn is running/);
    expect(w.calls).toHaveLength(0);
  });
});
