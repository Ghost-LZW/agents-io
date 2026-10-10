import { describe, expect, it } from 'vitest';
import type { InputRecord } from '@agents-io/protocol';
import { daemon, tmp, until, type World } from './helpers.js';
import { alice, CONV, mcpCall, of, read, textOf, turnsIn, world } from './topics-helpers.js';

describe('topics in the daemon', () => {
  it('a follow-up queued in the old topic while its turn rotates moves to the new topic #IN-1 #TP-1', async () => {
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
    // The tool's reply can arrive after the handover has already run in B.
    await until(() => tools.length === 1);
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

  it('a handover that fails leaves the conversation in the topic it was in, and that turn answers #TP-1', async () => {
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

  it("parked topics' lanes close after topics.parkedIdleMs and resume by native id when switched back #TP-1", async () => {
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

  // INVARIANTS LN-2 不成立 1: closeLane drops the lane from the table before its (up to 8 s) close, so an input arriving meanwhile opens a second Lane and harness session for the key; turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('an input that arrives while a parked topic\'s lane is closing does not open a second lane for the same key #LN-2', async () => {
    const { w } = await world(tmp(), { topics: { parkedIdleMs: 50 } });
    // A's harness session takes its time to close, as a real harness may (closeLane waits up to 8 s).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let open = 0;
    let most = 0;
    let closing = false;
    const realOpen = w.harness.open.bind(w.harness);
    w.harness.open = async (args) => {
      const s = await realOpen(args);
      if (args.sessionKey !== CONV) return s;
      most = Math.max(most, ++open);
      const realClose = s.close.bind(s);
      s.close = async () => {
        closing = true;
        await gate;
        await realClose();
        open--;
      };
      return s;
    };
    await w.chat.inject({ sender: alice, text: 'Remember my codename: HERON' });
    await until(() => turnsIn(w, CONV).length === 1);
    await w.chat.inject({ sender: alice, text: 'Something unrelated: what is the capital of Australia?' });
    const b = await until(() => w.gw.topics.list({ conversation: CONV }).find((t) => t.title === 'Capitals'));
    await until(() => turnsIn(w, b.sessionKey).length === 1);
    await until(() => closing);
    // While A's lane is still closing, B hands a message back to A.
    await w.chat.inject({ sender: alice, text: 'Ok, go back to the earlier topic: what is my codename?' });
    await until(() => w.harness.sessions.filter((s) => s.args.sessionKey === CONV).length === 2, 500).catch(() => undefined);
    release();
    await until(() => turnsIn(w, CONV).length === 3);
    expect(most).toBe(1);
  });

  it('agents without the session_* tools get no topic hint #CF-6', async () => {
    const seen: InputRecord[] = [];
    const w = await daemon({ raw: { outputTools: true, agents: { chat: { harness: 'claude-code', tools: false } } }, script: async (t) => void seen.push(...t.inputs) });
    await w.chat.inject({ sender: alice, text: 'hello' });
    await until(() => seen.length === 1);
    expect(seen[0]!.channelContext.topic).toBeDefined();
    expect(seen[0]!.channelContext.topicTools).toBeUndefined();
    // The agent's tools: false wins over the top-level outputTools: true: nothing is mounted for it.
    expect(w.harness.sessions[0]!.args.mcp).toBeUndefined();
  });

  it('chat commands answer with a system reply; switching back after a restart resumes the native session #RS-1 #TP-1', async () => {
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

  it('commands from the owner act; a stranger DM never reaches the topic table #CT-1', async () => {
    const { w } = await world();
    await w.gw.ingress.accept({ v: 1, id: 'x1', channel: 'fake', account: 'default', conversation: { id: 'c1', kind: 'dm' }, sender: alice, content: [{ type: 'text', text: 'hi' }], replyRoute: { channel: 'fake', account: 'default', conversationId: 'c1' } });
    const r = await w.gw.ingress.accept({ v: 1, id: 'x2', channel: 'fake', account: 'default', conversation: { id: 'c1', kind: 'dm' }, sender: alice, content: [{ type: 'text', text: '/new' }], replyRoute: { channel: 'fake', account: 'default', conversationId: 'c1' } });
    expect(r.command).toMatchObject({ name: 'new', ok: true });
    // Strangers' DMs match no rule at all (default table), so their "/new" never reaches the topic table.
    const s = await w.gw.ingress.accept({ v: 1, id: 'x3', channel: 'fake', account: 'default', conversation: { id: 'c1', kind: 'dm' }, sender: { channelUserId: 'eve', evidence: 'platform_signed' }, content: [{ type: 'text', text: '/new' }], replyRoute: { channel: 'fake', account: 'default', conversationId: 'c1' } });
    expect(s.action).toBe('drop');
    expect(w.gw.topics.list({ conversation: CONV })).toHaveLength(2);
  });
});
