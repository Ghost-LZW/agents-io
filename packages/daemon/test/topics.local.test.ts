import { describe, expect, it } from 'vitest';
import { CommandError } from '../src/client.js';
import { until } from './helpers.js';
import { alice, CONV, of, read, turnsIn, world } from './topics-helpers.js';

describe('topics in the daemon', () => {
  it('topic.list / topic.switch client frames', async () => {
    const { w } = await world();
    const c = await w.client();
    await expect(c.topicSwitch({ conversation: CONV, new: {} })).rejects.toMatchObject({ code: 'unknown_conversation' });
    await w.chat.inject({ sender: alice, text: 'hello' });
    await until(() => turnsIn(w, CONV).length === 1);
    const [a] = await c.topicList({ conversation: CONV });
    expect(a).toMatchObject({ conversation: CONV, sessionKey: CONV, state: 'current' });
    expect((a as Record<string, unknown>).agent).toBeUndefined();
    const created = await c.topicSwitch({ conversation: CONV, new: { title: 'Plans' } });
    expect(created).toMatchObject({ created: true, topic: { title: 'Plans', state: 'current' }, previous: { id: a!.id, state: 'parked' } });
    expect((await c.topicList({ sessionKey: created.topic.sessionKey })).map((t) => t.id)).toEqual([created.topic.id]);
    const back = await c.topicSwitch({ conversation: CONV, topicId: a!.id });
    expect(back).toMatchObject({ created: false, topic: { id: a!.id, state: 'current' } });
    await expect(c.topicSwitch({ conversation: CONV, topicId: 'tp_nope' })).rejects.toMatchObject({ code: 'unknown_topic' });
    const both = await c.call('topic.switch', { conversation: CONV, topicId: a!.id, new: {} }).catch((e: CommandError) => e.code);
    expect(both).toBe('invalid_frame');
    expect(of(read(w, CONV), 'topic.changed').map((x) => x.reason)).toEqual(['system', 'user', 'user']);
    // The next message goes to the topic the frame made current.
    const r = await w.chat.inject({ sender: alice, text: 'again' });
    expect(r.inputId).toBeDefined();
    await until(() => turnsIn(w, CONV).length === 2);
  });
});
