import { describe, expect, it } from 'vitest';
import { LarkBotAdapter } from '../src/index.js';
import { FakeLark, messageEvent, startAdapter, tick } from './fake-lark.js';
import { cardOf, cfg, make, route, run, turn } from './process-helpers.js';

/* Quieter replies: the `chat` look, `cotOn: tool`, and `process` per kind of chat. */

const ids = (json: any) => json.body.elements.map((e: any) => e.element_id);

describe('chat look', () => {
  it('a finished reply is the answer alone: no header, status line, plan or footer', async () => {
    const { lark, adapter } = make({ process: 'cot', look: 'chat' });
    const id = await run(adapter, turn());
    const final = cardOf(lark, id).json;
    expect(final.header).toBeUndefined();
    expect(ids(final)).toEqual(['answer']);
    expect(FakeLark.element(final, 'answer').content).toBe('Found a.ts and more.');
  });

  it('while running the status and footer stay empty; a waiting approval and a failure are said', async () => {
    const { lark, adapter } = make({ process: 'cot', look: 'chat' });
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    const card = cardOf(lark, id!);
    expect(card.json.header).toBeUndefined();
    expect(FakeLark.element(card.json, 'status').content).toBe(' ');
    expect(FakeLark.element(card.json, 'footer').content).toBe(' ');
    t.p.status = 'requires_action';
    await adapter.edit(route, id!, t.msg({ sections: [{ kind: 'status', text: 'Approval needed: Bash' }] }), { operationId: 'e1', sequence: 1 });
    expect(FakeLark.element(card.json, 'status').content).toContain('Approval needed: Bash');
    t.p.status = 'failed';
    await adapter.finalize(route, id!, t.msg());
    await adapter.settled();
    expect(ids(card.json)).toEqual(['status', 'answer']);
    expect(FakeLark.element(card.json, 'status').content).toContain('失败');
  });

  it('a topic keeps its title as the header, without the status', async () => {
    const { lark, adapter } = make({ process: 'cot', look: 'chat' });
    const { providerMessageId: id } = await adapter.send(route, turn().msg({ channelData: { 'agents-io/topic': { title: 'Flaky test' } } }), { operationId: 'o' });
    const header = cardOf(lark, id!).json.header;
    expect(header.title.content).toBe('Flaky test');
    expect(header.subtitle).toBeUndefined();
  });
});

describe('cotOn: tool', () => {
  it('a turn that only thinks and answers shows no bubble', async () => {
    const { lark, adapter } = make({ process: 'cot', cotOn: 'tool' });
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    t.p.steps.push({ kind: 'reasoning', id: 'r0', text: 'hmm', done: true });
    await adapter.edit(route, id!, t.msg(), { operationId: 'e1', sequence: 1 });
    t.p.answer = 'hi';
    t.p.status = 'completed';
    await adapter.finalize(route, id!, t.msg());
    await adapter.settled();
    expect(lark.cots).toHaveLength(0);
  });

  it('the first tool call opens it, with the thinking before it', async () => {
    const { lark, adapter } = make({ process: 'cot', cotOn: 'tool' });
    await run(adapter, turn());
    expect(lark.cots).toHaveLength(1);
    const types = lark.cots[0]!.events.map((e) => e.event_type);
    expect(types).toContain('REASONING_MESSAGE_CONTENT');
    expect(types).toContain('TOOL_CALL_START');
  });
});

describe('a first message that is already final', () => {
  it('gets no bubble, even with cotOn: turn', async () => {
    const { lark, adapter } = make({ process: 'cot' });
    const t = turn();
    t.p.answer = 'hi';
    t.p.status = 'completed';
    t.p.answerFinal = true;
    await adapter.send(route, t.msg(), { operationId: 'o' });
    await adapter.settled();
    expect(lark.cots).toHaveLength(0);
  });
});

describe('processByChat', () => {
  async function started(config: object) {
    const lark = new FakeLark();
    const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps, sleep: async () => {} });
    startAdapter(adapter);
    await tick();
    return { lark, adapter };
  }

  it('a group chat uses its own mode; a chat not seen yet uses `process`', async () => {
    const { lark, adapter } = await started({ process: 'cot', processByChat: { group: 'off' } });
    const t = turn();
    await adapter.send(route, t.msg(), { operationId: 'unknown' });
    expect(lark.cots).toHaveLength(1);
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'group', id: 'om_g1' }));
    await adapter.send(route, turn('t2').msg(), { operationId: 'group' });
    expect(lark.cots).toHaveLength(1);
    expect(lark.messages.at(-1)!.msg_type).toBe('interactive');
    expect(lark.cards.size).toBe(1); // the group reply is a plain card, not a process card
  });

  it('a DM uses the dm mode', async () => {
    const { lark, adapter } = await started({ process: 'off', processByChat: { dm: 'cot' } });
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p' }));
    await adapter.send(route, turn().msg(), { operationId: 'dm' });
    expect(lark.cots).toHaveLength(1);
  });
});
