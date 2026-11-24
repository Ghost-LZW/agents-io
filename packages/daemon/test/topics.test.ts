import { describe, expect, it } from 'vitest';
import type { InputRecord, KernelContext, ModuleManifest, ModuleTopicHandover } from '@agents-io/protocol';
import { builtinModules } from '../src/bundle.js';
import { ModuleRegistry } from '@agents-io/kernel';
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

  it("the kernel's handover holds TP-1 for any module that asks: one per turn (the same operation again answers the same, also in flight; another is refused), never from a topic no longer current, never a message just handed here, never to the topic the turn runs in #TP-1", async () => {
    const kernels: KernelContext[] = [];
    const probe: ModuleManifest = { id: 'probe', kind: 'feature', needs: ['kernel:topics'], setup: (k) => (kernels.push(k), {}) };
    const moduleRegistry = new ModuleRegistry([...builtinModules.modules, { manifest: probe, origin: 'module' }], { fields: Object.fromEntries(builtinModules.fields) });
    const holder: { w?: World } = {};
    const running: { sessionKey: string; turnId: string; inputs: InputRecord[] }[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const w = await daemon({
      moduleRegistry,
      script: async (t) => {
        const topicId = t.inputs.map((i) => i.channelContext.topic).find((x) => typeof x === 'string') as string;
        running.push({ sessionKey: holder.w!.gw.topics.get(topicId)!.sessionKey, turnId: t.turnId, inputs: t.inputs });
        await held;
        t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
      },
    });
    holder.w = w;
    const k = kernels[0]!;
    const turnIn = (sessionKey: string) => running.find((r) => r.sessionKey === sessionKey);
    const handedAlready = 'this turn was already handed to another topic; end the turn now without answering';
    // A's turn still runs when the owner starts topic C: A is no longer current, so its turn stays.
    await w.chat.inject({ sender: alice, text: 'Rust CLI question' });
    const t1 = (await until(() => turnIn(CONV))).turnId;
    await w.chat.inject({ sender: alice, text: '/new Elsewhere' });
    const c = await until(() => w.gw.topics.list({ conversation: CONV }).find((t) => t.title === 'Elsewhere' && t.state === 'current'));
    await expect(k.topics.rotate(CONV, t1, { title: 'X', summary: 'none', operationId: 'op0' })).rejects.toThrow("this topic is no longer the conversation's current one (the user or another turn switched); just answer here");
    // C's turn: not to C itself; then one handover, however many ask at once.
    const m2 = await w.chat.inject({ sender: alice, text: 'what is the capital of Australia?' });
    const t2 = (await until(() => turnIn(c.sessionKey))).turnId;
    await expect(k.topics.switch(c.sessionKey, t2, { topicId: c.id, operationId: 'op1' })).rejects.toThrow('you are already in that topic; just answer');
    const rotate = (title: string, operationId: string) => k.topics.rotate(c.sessionKey, t2, { title, summary: 'none', operationId });
    const [first, retried, other] = await Promise.allSettled([rotate('Capitals', 'op2'), rotate('Capitals', 'op2'), rotate('Other', 'op3')]);
    expect(first.status).toBe('fulfilled');
    const r = (first as PromiseFulfilledResult<ModuleTopicHandover>).value;
    expect(retried).toEqual({ status: 'fulfilled', value: r });
    expect(other).toMatchObject({ status: 'rejected', reason: { name: 'ToolError', message: handedAlready } });
    // After it too: the same operation answers the same; any other, a switch as well, is refused.
    expect(await rotate('Capitals', 'op2')).toEqual(r);
    await expect(rotate('Other', 'op4')).rejects.toThrow(handedAlready);
    await expect(k.topics.switch(c.sessionKey, t2, { topicId: w.gw.topics.bySession(CONV)!.id, operationId: 'op5' })).rejects.toThrow(handedAlready);
    // One new topic got the message, once.
    expect(r).toMatchObject({ topic: { title: 'Capitals', state: 'current' }, previous: { id: c.id }, handed: [`${m2.inputId}>${r.topic.id}`] });
    expect(w.gw.topics.list({ conversation: CONV })).toHaveLength(3);
    expect(w.gw.topics.current(CONV, 'default')!.id).toBe(r.topic.id);
    // B answers the message handed to it: it does not hand it on (no ping-pong).
    const inB = await until(() => turnIn(r.topic.sessionKey));
    expect(inB.inputs.filter((i) => i.channelContext.context !== true)).toEqual([expect.objectContaining({ inputId: `${m2.inputId}>${r.topic.id}`, channelContext: expect.objectContaining({ handedFrom: c.sessionKey }) })]);
    const handedHere = 'this message was just handed to this topic by a topic switch; answer it here, in this turn';
    await expect(k.topics.switch(r.topic.sessionKey, inB.turnId, { topicId: c.id, operationId: 'op6' })).rejects.toThrow(handedHere);
    await expect(k.topics.rotate(r.topic.sessionKey, inB.turnId, { title: 'Y', summary: 'none', operationId: 'op7' })).rejects.toThrow(handedHere);
    expect(w.gw.topics.current(CONV, 'default')!.id).toBe(r.topic.id);
    release();
    await until(() => turnsIn(w, r.topic.sessionKey).length === 1);
    expect(running.map((x) => x.sessionKey)).toEqual([CONV, c.sessionKey, r.topic.sessionKey]);
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

  it('an input that arrives while a parked topic\'s lane is closing does not open a second lane for the same key #LN-2', async () => {
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
