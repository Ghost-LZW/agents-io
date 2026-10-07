import { describe, expect, it } from 'vitest';
import type { BodyOf, HarnessOpenArgs, InputRecord, SessionEvent } from '@agents-io/protocol';
import { TOPIC_KEY } from '@agents-io/session';
import type { FakeHarness, FakeTurnScript } from '@agents-io/testkit';
import { CommandError } from '../src/client.js';
import { daemon, tmp, until, type World } from './helpers.js';

/** What a harness does with HarnessOpenArgs.mcp: a JSON-RPC tools/call over streamable HTTP. */
async function mcpCall(mcp: HarnessOpenArgs['mcp'], name: string, args: Record<string, unknown>, callId: string) {
  if (!mcp) throw new Error('no mcp mounted');
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'claudecode/toolUseId': callId } } }),
  });
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: !!body.result.isError, json: JSON.parse(body.result.isError ? '{}' : body.result.content[0]!.text), text: body.result.content[0]!.text };
}

const CONV = 'fake:default:c1';
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const textOf = (t: { inputs: { content: { type: string; text?: string }[] }[] }) => t.inputs.flatMap((i) => i.content).map((c) => c.text ?? '').join('\n');
const read = (w: World, sk: string) => w.gw.hub.log.read(sk, 0);
const of = <K extends SessionEvent['body']['t']>(evs: SessionEvent[], t: K) => evs.filter((e) => e.body.t === t).map((e) => e.body as BodyOf<K>);

/**
 * A scripted agent: it remembers per session what it was told (as a real harness
 * session would), rotates when told something "unrelated", switches back when
 * asked to "go back", and binds a native id per session.
 */
function agent(holder: { h?: FakeHarness; w?: World }, tools: { name: string; isError: boolean; json: any; text: string }[], turns: { sessionKey: string; inputs: InputRecord[] }[]): FakeTurnScript {
  const memory = new Map<string, string[]>();
  return async (t) => {
    const w = holder.w!;
    const topicId = t.inputs.map((i) => i.channelContext.topic).find((x) => typeof x === 'string') as string | undefined;
    const sk = topicId ? w.gw.topics.get(topicId)!.sessionKey : CONV;
    const s = holder.h!.sessions.filter((x) => x.args.sessionKey === sk).at(-1)!;
    turns.push({ sessionKey: sk, inputs: t.inputs });
    t.emit({ t: 'session.bound', nativeId: `native:${sk}` });
    const text = textOf(t);
    const seen = memory.get(sk) ?? [];
    // What the user said in this session (context items such as a rotation summary are not remembered as facts).
    memory.set(sk, [...seen, textOf({ inputs: t.inputs.filter((i) => i.channelContext.context !== true) })]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await mcpCall(s.args.mcp, name, args, `${t.turnId}:${name}`);
      tools.push({ name, ...r });
      return r;
    };
    let answer: string;
    if (/unrelated/.test(text) && !/Summary of the previous topic/.test(text)) {
      await call('session_rotate', { title: 'Capitals', summary: 'The user told me their codename.' });
      answer = '→ Capitals';
    } else if (/go back/.test(text) && !seen.join('\n').includes('HERON')) {
      const list = await call('session_list', {});
      const a = list.json.topics.find((x: { title: string }) => /codename/.test(x.title));
      await call('session_switch', { topicId: a.topicId });
      answer = '→ back';
    } else {
      // Answers from what this session has seen: only the first topic knows the codename.
      answer = /codename/.test(text) && seen.join('\n').includes('HERON') ? 'Your codename is HERON.' : `ok (${seen.length + 1} messages here)`;
    }
    t.emit({ t: 'text.snapshot', text: answer, final: true }, { audience: 'answer' });
  };
}

async function world(dir = tmp(), raw: Record<string, unknown> = {}) {
  const holder: { h?: FakeHarness; w?: World } = {};
  const tools: { name: string; isError: boolean; json: any; text: string }[] = [];
  const turns: { sessionKey: string; inputs: InputRecord[] }[] = [];
  const w = await daemon({ dir, script: agent(holder, tools, turns), raw: { outputTools: true, ...raw } });
  holder.h = w.harness;
  holder.w = w;
  return { w, tools, turns };
}

const turnsIn = (w: World, sk: string) => of(read(w, sk), 'turn.completed');

describe('topics in the daemon', () => {
  it('session_rotate starts a topic and hands the message over with the summary; session_switch goes back to the parked session', async () => {
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

  it('a follow-up queued in the old topic while its turn rotates moves to the new topic', async () => {
    const holder: { w?: World } = {};
    const ran: { sessionKey: string; inputs: InputRecord[] }[] = [];
    const tools: { isError: boolean; text: string }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = await daemon({
      raw: { outputTools: true },
      script: async (t) => {
        const topicId = t.inputs.map((i) => i.channelContext.topic).find((x) => typeof x === 'string') as string;
        const sk = holder.w!.gw.topics.get(topicId)!.sessionKey;
        ran.push({ sessionKey: sk, inputs: t.inputs });
        const text = textOf(t);
        if (/Tokyo/.test(text) && !/Summary of the previous topic/.test(text)) {
          await gate;
          const s = holder.w!.harness.sessions.filter((x) => x.args.sessionKey === sk).at(-1)!;
          tools.push(await mcpCall(s.args.mcp, 'session_rotate', { title: 'Tokyo trip', summary: 'none' }, `${t.turnId}:r`));
        }
        t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
      },
    });
    holder.w = w;
    await w.chat.inject({ sender: alice, text: 'Rust CLI question' });
    await until(() => turnsIn(w, CONV).length === 1);
    await w.chat.inject({ sender: alice, text: 'Plan a trip to Tokyo' });
    await until(() => ran.length === 2);
    const budget = await w.chat.inject({ sender: alice, text: 'budget is 2000 USD' });
    await until(() => w.gw.lane(CONV).queued().length === 1);
    release();
    const b = await until(() => w.gw.topics.list({ conversation: CONV }).find((t) => t.title === 'Tokyo trip'));
    await until(() => turnsIn(w, b.sessionKey).length === 2);
    expect(tools).toEqual([expect.objectContaining({ isError: false })]);
    // The follow-up left A's queue and is answered in B, after the handed message, with what B knows.
    const inB = of(read(w, b.sessionKey), 'turn.started').flatMap((x) => x.inputIds);
    expect(inB).toContain(`${budget.inputId}>${b.id}`);
    expect(of(read(w, CONV), 'input.cancelled')).toEqual([{ t: 'input.cancelled', inputIds: [budget.inputId], reason: 'moved_to_topic' }]);
    expect(turnsIn(w, CONV)).toHaveLength(2);
    expect(ran.filter((r) => r.sessionKey === CONV)).toHaveLength(2);
    const moved = ran.find((r) => r.inputs.some((i) => i.inputId === `${budget.inputId}>${b.id}`))!.inputs.at(-1)!;
    expect(moved.channelContext).toMatchObject({ topic: b.id, handedFrom: CONV });
    expect(moved.origin.principal?.id).toBe('fake:alice');
  });

  it('a handover that fails leaves the conversation in the topic it was in, and that turn answers', async () => {
    const { w, tools } = await world();
    await w.chat.inject({ sender: alice, text: 'Remember my codename: HERON' });
    await until(() => turnsIn(w, CONV).length === 1);
    await w.chat.inject({ sender: alice, text: 'Something unrelated: what is the capital of Australia?' });
    const b = await until(() => w.gw.topics.list({ conversation: CONV }).find((t) => t.title === 'Capitals'));
    await until(() => turnsIn(w, b.sessionKey).length === 1);
    // A's lane can no longer take inputs (e.g. it is closing).
    await w.gw.lane(CONV).close();
    await w.chat.inject({ sender: alice, text: 'Ok, go back to the earlier topic: what is my codename?' });
    await until(() => turnsIn(w, b.sessionKey).length === 2);
    expect(tools.map((t) => t.name)).toEqual(['session_rotate', 'session_list', 'session_switch']);
    expect(tools[2]).toMatchObject({ isError: true, text: expect.stringMatching(/stays in this topic/) });
    expect(w.gw.topics.current(CONV, 'default')!.id).toBe(b.id);
    // Its card is the turn's own answer, not a "moved" line.
    await until(() => w.chat.sent.filter((s) => s.finalized).length >= 3);
    expect(w.chat.sent.map((s) => s.edits.at(-1)?.text).at(-1)).toBe('→ back');
  });

  it("parked topics' lanes close after topics.parkedIdleMs and resume by native id when switched back", async () => {
    expect((await world()).w.config.topics.parkedIdleMs).toBe(30 * 60_000);
    const { w } = await world(tmp(), { topics: { parkedIdleMs: 50 } });
    await w.chat.inject({ sender: alice, text: 'Remember my codename: HERON' });
    await until(() => turnsIn(w, CONV).length === 1);
    await w.chat.inject({ sender: alice, text: 'Something unrelated: what is the capital of Australia?' });
    const b = await until(() => w.gw.topics.list({ conversation: CONV }).find((t) => t.title === 'Capitals'));
    await until(() => turnsIn(w, b.sessionKey).length === 1);
    const live = (sk: string) => w.gw.sessions().find((s) => s.sessionKey === sk)?.live;
    await until(() => live(CONV) === false);
    expect(live(b.sessionKey)).toBe(true);
    await w.chat.inject({ sender: alice, text: 'Ok, go back to the earlier topic: what is my codename?' });
    await until(() => turnsIn(w, CONV).length === 3);
    expect(of(read(w, CONV), 'text.snapshot').at(-1)!.text).toBe('Your codename is HERON.');
    const opened = w.harness.sessions.filter((s) => s.args.sessionKey === CONV);
    expect(opened).toHaveLength(2);
    expect(opened[1]!.args.resume).toBe(`native:${CONV}`);
    // Now B is parked and idles out too; A, current, stays open.
    await until(() => live(b.sessionKey) === false);
    expect(live(CONV)).toBe(true);
  });

  it('agents without the session_* tools get no topic hint', async () => {
    const seen: InputRecord[] = [];
    const w = await daemon({ raw: { outputTools: true, agents: { chat: { harness: 'claude-code', tools: false } } }, script: async (t) => void seen.push(...t.inputs) });
    await w.chat.inject({ sender: alice, text: 'hello' });
    await until(() => seen.length === 1);
    expect(seen[0]!.channelContext.topic).toBeDefined();
    expect(seen[0]!.channelContext.topicTools).toBeUndefined();
  });

  it('chat commands answer with a system reply; switching back after a restart resumes the native session', async () => {
    const dir = tmp();
    const one = await world(dir);
    await one.w.chat.inject({ sender: alice, text: 'Remember my codename: HERON' });
    await until(() => turnsIn(one.w, CONV).length === 1);
    await one.w.chat.inject({ sender: alice, text: '/new Groceries' });
    const reply = await until(() => one.w.chat.sent.find((s) => /^New topic: Groceries/.test(s.msg.text)));
    expect(reply.msg.actions).toBeUndefined();
    const g = one.w.gw.topics.current(CONV, 'default')!;
    await one.w.chat.inject({ sender: alice, text: 'milk' });
    await until(() => turnsIn(one.w, g.sessionKey).length === 1);
    await one.w.chat.inject({ sender: alice, text: '/topics' });
    const listed = await until(() => one.w.chat.sent.find((s) => /^Topics/.test(s.msg.text)));
    expect(listed.msg.text).toMatch(/▶ 1\. Groceries/);
    expect(listed.msg.text).toMatch(/2\. Remember my codename: HERON/);
    await one.w.stop();

    const two = await world(dir);
    expect(two.w.gw.topics.current(CONV, 'default')!.id).toBe(g.id);
    await two.w.chat.inject({ sender: alice, text: '/switch 2' });
    await until(() => two.w.chat.sent.find((s) => /^Switched to topic 2/.test(s.msg.text)));
    await two.w.chat.inject({ sender: alice, text: 'what is my codename?' });
    await until(() => turnsIn(two.w, CONV).length === 2);
    // The new daemon opened A's session with the native id A's log recorded.
    const opened = two.w.harness.sessions.filter((s) => s.args.sessionKey === CONV);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.args.resume).toBe(`native:${CONV}`);
    expect(two.w.gw.topics.get(g.id)).toMatchObject({ state: 'parked', nativeId: `native:${g.sessionKey}` });
  });

  it('commands from the owner act; a stranger DM never reaches the topic table', async () => {
    const { w } = await world();
    await w.gw.ingress.accept({ v: 1, id: 'x1', channel: 'fake', account: 'default', conversation: { id: 'c1', kind: 'dm' }, sender: alice, content: [{ type: 'text', text: 'hi' }], replyRoute: { channel: 'fake', account: 'default', conversationId: 'c1' } });
    const r = await w.gw.ingress.accept({ v: 1, id: 'x2', channel: 'fake', account: 'default', conversation: { id: 'c1', kind: 'dm' }, sender: alice, content: [{ type: 'text', text: '/new' }], replyRoute: { channel: 'fake', account: 'default', conversationId: 'c1' } });
    expect(r.command).toMatchObject({ name: 'new', ok: true });
    // Strangers' DMs match no rule at all (default table), so their "/new" never reaches the topic table.
    const s = await w.gw.ingress.accept({ v: 1, id: 'x3', channel: 'fake', account: 'default', conversation: { id: 'c1', kind: 'dm' }, sender: { channelUserId: 'eve', evidence: 'platform_signed' }, content: [{ type: 'text', text: '/new' }], replyRoute: { channel: 'fake', account: 'default', conversationId: 'c1' } });
    expect(s.action).toBe('drop');
    expect(w.gw.topics.list({ conversation: CONV })).toHaveLength(2);
  });

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
