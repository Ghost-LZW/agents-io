import { describe, expect, it } from 'vitest';
import { TOPIC_KEY } from '@agents-io/session';
import { until } from './helpers.js';
import { alice, CONV, of, read, turnsIn, world } from './topics-helpers.js';

describe('topics in the daemon', () => {
  it('session_rotate starts a topic and hands the message over with the summary; session_switch goes back to the parked session #TP-1', async () => {
    const { w, tools, turns } = await world();
    await w.chat.inject({ sender: alice, text: 'Remember my codename: HERON' });
    await until(() => turnsIn(w, CONV).length === 1);
    const a = w.gw.topics.current(CONV, 'default')!;
    expect(a).toMatchObject({ sessionKey: CONV, title: 'Remember my codename: HERON', nativeId: `native:${CONV}` });

    const r = await w.chat.inject({ sender: alice, text: 'Something unrelated: what is the capital of Australia?' });
    const b = await until(() => w.gw.topics.list({ conversation: CONV }).find((t) => t.title === 'Capitals'));
    await until(() => turnsIn(w, b.sessionKey).length === 1 && turnsIn(w, CONV).length === 2 && tools.length === 1);
    expect(tools[0]).toMatchObject({ name: 'session_rotate', isError: false, json: { topic: { topicId: b.id, title: 'Capitals' }, previous: { topicId: a.id }, handed: 1 } });
    expect(tools[0]!.json.note).toMatch(/Do NOT answer/);
    expect(w.gw.topics.current(CONV, 'default')!.id).toBe(b.id);
    // The summary describes the topic it was written in: it is saved on A, which is now parked; B has none yet.
    expect(w.gw.topics.get(a.id)).toMatchObject({ state: 'parked', summary: 'The user told me their codename.' });
    expect(w.gw.topics.get(b.id)!.summary).toBeUndefined();
    // The new topic's first turn: the summary as context, then the user's message under a new id.
    const started = of(read(w, b.sessionKey), 'turn.started')[0]!;
    expect(started.inputIds).toEqual([expect.stringMatching(/^sum_turn_/), `${r.inputId}>${b.id}`]);
    const [summary, handed] = turns.find((x) => x.sessionKey === b.sessionKey)!.inputs;
    expect(handed!.origin.principal?.id).toBe('fake:alice');
    expect(handed!.channelContext).toMatchObject({ topic: b.id, topicTitle: 'Capitals', handedFrom: CONV, topicTools: expect.stringMatching(/answer it here/) });
    expect(summary!.channelContext).toMatchObject({ context: true, topicSummary: true, fromTopic: a.id });
    expect(JSON.stringify(summary!.content)).toContain('Summary of the previous topic');
    expect(JSON.stringify(summary!.content)).toContain('The user told me their codename.');
    // Both sessions record the change.
    expect(of(read(w, CONV), 'topic.changed').at(-1)).toMatchObject({ from: a.id, to: b.id, reason: 'agent', title: 'Capitals' });
    expect(of(read(w, b.sessionKey), 'topic.changed')).toHaveLength(1);
    // The rotated turn in A ended normally; the answer came from B.
    expect(turnsIn(w, CONV)).toHaveLength(2);
    expect(of(read(w, b.sessionKey), 'turn.started')[0]!.run?.profile).toBe('bypass');

    // The next message goes to B; "go back" makes B switch to A, which answers with what only A knows.
    const back = await w.chat.inject({ sender: alice, text: 'Ok, go back to the earlier topic: what is my codename?' });
    await until(() => turnsIn(w, CONV).length === 3 && tools.length === 3);
    expect(tools.map((t) => t.name)).toEqual(['session_rotate', 'session_list', 'session_switch']);
    expect(tools[1]!.json.topics.map((t: { topicId: string }) => t.topicId).sort()).toEqual([a.id, b.id].sort());
    expect(tools[1]!.json.topics.find((t: { topicId: string }) => t.topicId === a.id).summary).toBe('The user told me their codename.');
    expect(tools[2]).toMatchObject({ isError: false, json: { topic: { topicId: a.id }, handed: 1 } });
    expect(w.gw.topics.current(CONV, 'default')!.id).toBe(a.id);
    const answerA = of(read(w, CONV), 'text.snapshot').at(-1)!;
    expect(answerA.text).toBe('Your codename is HERON.');
    expect(of(read(w, CONV), 'turn.started').at(-1)!.inputIds).toEqual([`${back.inputId}>${a.id}`]);
    // A's session was never re-opened: its lane and harness session carried on.
    expect(w.harness.sessions.filter((s) => s.args.sessionKey === CONV)).toHaveLength(1);

    // Cards carry the topic title of their session.
    await until(() => w.chat.sent.filter((s) => s.finalized).length >= 5);
    const titles = w.chat.sent.map((s) => (s.edits.at(-1)?.channelData as Record<string, { title: string }> | undefined)?.[TOPIC_KEY]?.title);
    expect(titles).toContain('Capitals');
    expect(titles).toContain('Remember my codename: HERON');
    // The turns that handed the message away end as one line naming the topic now current, not with their own text.
    const finals = w.chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);
    expect(finals).toContain('→ Moved to topic "Capitals"');
    expect(finals).toContain('→ Moved to topic "Remember my codename: HERON"');
    expect(finals).not.toContain('→ Capitals');
    expect(finals).not.toContain('→ back');
  });
});
