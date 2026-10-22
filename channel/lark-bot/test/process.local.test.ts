import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitMarkdown } from '../src/index.js';
import { FakeLark, startAdapter } from './fake-lark.js';
import { cardOf, make, route, run, turn } from './process-helpers.js';

/* CardKit streaming, degradation and thinking-bubble rendering: feature paths with no promise behind them
   (decision 14: local tier). The platform error codes (300309, 300500, ...) were learned live; keep them,
   and when one breaks judge whether the platform changed before rewriting. */

describe('process card: CardKit streaming (panels)', () => {
  it('creates a streaming CardKit card, updates elements, finalizes with the full card', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    const id = await run(adapter, t, { actions: [{ id: 'turn:t1:interrupt', label: 'Stop', style: 'danger' }] });

    expect(lark.messages).toHaveLength(1);
    const m = lark.messages[0]!;
    expect(m).toMatchObject({ msg_type: 'interactive', receive: { kind: 'reply', to: 'om_in1' } });
    const card = cardOf(lark, id);
    // Created in streaming mode with the stop button.
    expect(lark.log[0]).toBe('card.create');
    const ops = card.ops.map((o) => `${o.op}${o.elementId ? `:${o.elementId}` : ''}`);
    expect(ops).toContain('cardElement.create:answer'); // thinking panel inserted after the answer
    expect(ops).toContain('cardElement.content:answer');
    expect(ops).toContain('cardElement.update:status');
    expect(ops).toContain('cardElement.content:p_thinking_md');
    expect(ops.slice(-2)).toEqual(['card.settings', 'card.update']);
    // Strictly increasing sequences, one uuid per mutation.
    const seqs = card.ops.map((o) => o.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(card.ops.map((o) => o.uuid)).size).toBe(card.ops.length);
    expect(card.ops.find((o) => o.op === 'card.settings')!.body.config.streaming_mode).toBe(false);

    const final = card.json;
    expect(final.config.streaming_mode).toBeUndefined();
    expect(final.header).toMatchObject({ title: { content: '已完成' }, template: 'green' });
    const els = final.body.elements.map((e: any) => e.element_id);
    expect(els).toEqual(['status', 'answer', 'p_thinking', 'p_tools', 'p_plan', 'footer']); // stop button gone
    expect(FakeLark.element(final, 'answer').content).toBe('Found a.ts and more.');
    expect(FakeLark.element(final, 'p_tools_md').content).toContain('✅ `Bash: ls`');
    expect(FakeLark.element(final, 'p_thinking_md').content).toContain('Thinking about it');
    expect(FakeLark.element(final, 'p_thinking_md').content).toContain('💬 Now reading');
    expect(FakeLark.element(final, 'p_plan_md').content).toBe('◐ look');
    expect(FakeLark.element(final, 'footer').content).toContain('用时 4s');
    expect(final.body.elements.every((e: any) => e.tag !== 'collapsible_panel' || e.expanded === false)).toBe(true);
  });

  it('reopens streaming once when the platform closed it (300309), then streams', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    lark.fail.set('cardElement.content', [300309]);
    t.p.answer = 'later';
    await adapter.edit(route, id!, t.msg(), { operationId: 'e', sequence: 1 });
    const card = cardOf(lark, id!);
    const settings = card.ops.find((o) => o.op === 'card.settings')!;
    expect(settings.body.config.streaming_mode).toBe(true);
    expect(FakeLark.element(card.json, 'answer').content).toBe('later');
  });

  it('continues an answer that does not fit the card in follow-up cards, fences kept balanced', async () => {
    const { lark, adapter } = make({ process: 'panels', maxCardKitBytes: 6000, maxCardBytes: 5000 });
    const t = turn();
    const body = Array.from({ length: 150 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n');
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    t.p.answer = `Intro\n\n\`\`\`ts\n${body}\n\`\`\`\nOutro`;
    t.p.status = 'completed';
    await adapter.finalize(route, id!, t.msg());
    expect(lark.messages.length).toBeGreaterThan(1);
    const first = FakeLark.element(cardOf(lark, id!).json, 'answer').content as string;
    expect(first).toContain('续见下一条消息');
    const rest = lark.messages.slice(1).map((m) => JSON.parse(m.content).body.elements[0].content as string);
    for (const page of [first, ...rest]) expect((page.match(/```/g) ?? []).length % 2).toBe(0);
    expect(rest.join('\n')).toContain('Outro');
    for (const m of lark.messages.slice(1)) expect(Buffer.byteLength(m.content)).toBeLessThanOrEqual(5000);
  });

  it('keeps a long Chinese answer within the default CardKit byte budget', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    t.p.steps.push({ kind: 'reasoning', id: 'r0', text: '检查'.repeat(1500), done: false });
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    t.p.answer = '结果'.repeat(15_000);
    await adapter.edit(route, id!, t.msg(), { operationId: 'e', sequence: 1 });
    const live = cardOf(lark, id!).json;
    expect(Buffer.byteLength(JSON.stringify(live))).toBeLessThanOrEqual(28_000);
    t.p.status = 'completed';
    await adapter.finalize(route, id!, t.msg());
    expect(Buffer.byteLength(JSON.stringify(cardOf(lark, id!).json))).toBeLessThanOrEqual(28_000);
    expect(lark.messages.length).toBeGreaterThan(1);
  });
});

describe('process card: degradation', () => {
  it('stream -> card.update mid-turn, remembered for the chat only', async () => {
    const { lark, adapter, logs } = make({ process: 'panels' });
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    lark.fail.set('cardElement.content', [300500]);
    t.p.answer = 'text';
    await adapter.edit(route, id!, t.msg(), { operationId: 'e1', sequence: 1 });
    const card = cardOf(lark, id!);
    expect(card.ops.at(-1)!.op).toBe('card.update');
    expect(FakeLark.element(card.json, 'answer').content).toBe('text');
    t.p.answer = 'text 2';
    await adapter.edit(route, id!, t.msg(), { operationId: 'e2', sequence: 2 });
    expect(card.ops.at(-1)!.op).toBe('card.update');
    expect(logs.some((l) => l.includes('stream card failed for chat:oc_chat'))).toBe(true);

    // Next turn in the same chat starts at card.update (no streaming mode); another chat still streams.
    const t2 = turn('t2');
    const r2 = await adapter.send(route, t2.msg(), { operationId: 'o2' });
    expect(cardOf(lark, r2.providerMessageId!).json.config.streaming_mode).toBeUndefined();
    const other = await adapter.send({ ...route, conversationId: 'oc_other' }, turn('t3').msg(), { operationId: 'o3' });
    expect(cardOf(lark, other.providerMessageId!).json.config.streaming_mode).toBe(true);
  });

  it('card.update -> message patch when CardKit updates fail', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    lark.fail.set('card.create', [300400]); // stream create fails: falls to update level
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    const card = cardOf(lark, id!);
    expect(card.json.config.streaming_mode).toBeUndefined();
    lark.fail.set('card.update', [300500]);
    t.p.answer = 'patched';
    await adapter.edit(route, id!, t.msg(), { operationId: 'e', sequence: 1 });
    const m = lark.messages[0]!;
    expect(m.patches).toHaveLength(1);
    expect(FakeLark.element(JSON.parse(m.patches[0]!), 'answer').content).toBe('patched');
    // Remembered: the next turn in this chat is a plain interactive message.
    const r2 = await adapter.send(route, turn('t2').msg(), { operationId: 'o2' });
    const m2 = lark.messages.find((x) => x.id === r2.providerMessageId)!;
    expect(JSON.parse(m2.content).schema).toBe('2.0');
    expect(JSON.parse(m2.content).data).toBeUndefined();
  });

  it('falls back to a patched message when CardKit cannot create cards; permission errors are app-wide', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    lark.fail.set('card.create', [99991672, 99991672]);
    const t = turn();
    const id = await run(adapter, t);
    const m = lark.messages.find((x) => x.id === id)!;
    expect(JSON.parse(m.content).body.elements[0].element_id).toBe('status');
    expect(m.patches.length).toBeGreaterThan(1);
    expect(JSON.parse(m.patches.at(-1)!).header.title.content).toBe('已完成');
    const before = lark.log.filter((x) => x === 'card.create').length;
    await adapter.send({ ...route, conversationId: 'oc_other' }, turn('t2').msg(), { operationId: 'o2' });
    expect(lark.log.filter((x) => x === 'card.create').length).toBe(before); // app-wide: not even tried
  });

  it('uses message patch when the client has no CardKit API', async () => {
    const lark = new FakeLark();
    delete (lark.client as { cardkit?: unknown }).cardkit;
    const { adapter } = make({ process: 'panels' }, lark);
    const id = await run(adapter, turn());
    expect(lark.cards.size).toBe(0);
    expect(lark.messages.find((x) => x.id === id)!.patches.length).toBeGreaterThan(0);
  });

  it("a process card sent into a topic returns Lark's thread_id as providerThreadId (CardKit and patched card)", async () => {
    const topic = { ...route, threadId: 'omt_om_in1' };
    const { adapter } = make({ process: 'panels' });
    expect(await adapter.send(topic, turn().msg(), { operationId: 'c1' })).toEqual({ providerMessageId: 'om_1', providerThreadId: 'omt_om_in1' });
    const lark = new FakeLark();
    delete (lark.client as { cardkit?: unknown }).cardkit;
    expect(await make({ process: 'panels' }, lark).adapter.send(topic, turn().msg(), { operationId: 'c2' })).toEqual({ providerMessageId: 'om_1', providerThreadId: 'omt_om_in1' });
    // Not in a topic: none.
    expect(await make({ process: 'panels' }).adapter.send(route, turn().msg(), { operationId: 'c3' })).toEqual({ providerMessageId: 'om_1' });
  });

  it("process: 'off' keeps the flat card and advertises no native stream", async () => {
    const { lark, adapter } = make({ process: 'off' });
    expect(adapter.caps().nativeStream).toBeUndefined();
    expect(make().adapter.caps().nativeStream).toEqual({ minIntervalMs: 0, maxBytes: 28_000 });
    await adapter.send(route, turn().msg(), { operationId: 'o' });
    expect(lark.cards.size).toBe(0);
    expect(JSON.parse(lark.messages[0]!.content).body.elements.some((e: any) => e.element_id === 'answer')).toBe(false);
  });
});

describe('native thinking bubble (message_cot)', () => {
  it('cot: thinking and tools go to the bubble, the card keeps status, plan and answer', async () => {
    const { lark, adapter } = make({ process: 'cot' });
    const id = await run(adapter, turn());
    expect(lark.cots).toHaveLength(1);
    const cot = lark.cots[0]!;
    expect(cot.create).toEqual({ params: { receive_id_type: 'chat_id' }, data: { receive_id: 'oc_chat', origin_message_id: 'om_in1' } });
    const types = cot.events.map((e) => e.event_type);
    expect(types.slice(0, 2)).toEqual(['RUN_STARTED', 'REASONING_START']);
    expect(types.at(-1)).toBe('RUN_FINISHED');
    expect(cot.events.at(-1)!.content).toMatchObject({ runId: 't1', status: 'done' });
    const start = cot.events.find((e) => e.event_type === 'TOOL_CALL_START')!.content;
    expect(start).toMatchObject({ toolCallId: 'i1', icon: 'bash', title: 'Bash: ls', parentMessageId: 'rs0' });
    const result = cot.events.find((e) => e.event_type === 'TOOL_CALL_RESULT')!.content;
    expect(JSON.parse(result.content)).toEqual({ type: 'code', language: 'bash', code: 'a.ts' });
    const text = cot.events.filter((e) => e.event_type === 'REASONING_MESSAGE_CONTENT').map((e) => e.content.delta);
    expect(text).toEqual(['Thinking about it', 'Now reading']);
    // Each reasoning message is started and ended exactly once.
    const starts = cot.events.filter((e) => e.event_type === 'REASONING_MESSAGE_START').map((e) => e.content.messageId);
    const ends = cot.events.filter((e) => e.event_type === 'REASONING_MESSAGE_END').map((e) => e.content.messageId);
    expect(new Set(starts).size).toBe(starts.length);
    expect(ends.sort()).toEqual([...starts].sort());
    expect(cot.completed).toBe('finished');

    const final = cardOf(lark, id).json;
    expect(final.body.elements.map((e: any) => e.element_id)).toEqual(['status', 'answer', 'p_plan', 'footer']);
  });

  it('streams a growing reasoning block as deltas and places the bubble inside a thread', async () => {
    const { lark, adapter } = make({ process: 'cot' });
    const r = { ...route, threadId: 'omt_1' };
    const t = turn();
    const { providerMessageId: id } = await adapter.send(r, t.msg(), { operationId: 'o' });
    t.p.steps.push({ kind: 'reasoning', id: 'r0', text: 'abc', done: false });
    await adapter.edit(r, id!, t.msg(), { operationId: 'e1', sequence: 1 });
    await adapter.settled();
    (t.p.steps[0] as { text: string }).text = 'abcdef';
    await adapter.edit(r, id!, t.msg(), { operationId: 'e2', sequence: 2 });
    t.p.status = 'interrupted';
    await adapter.finalize(r, id!, t.msg());
    await adapter.settled();
    const cot = lark.cots[0]!;
    expect(cot.create.data).toEqual({ receive_id: 'oc_chat', origin_message_id: 'om_in1', reply_in_thread: true });
    expect(cot.events.filter((e) => e.event_type === 'REASONING_MESSAGE_CONTENT').map((e) => e.content.delta)).toEqual(['abc', 'def']);
    expect(cot.events.at(-1)!.content.status).toBe('interrupted');
  });

  it('opens the bubble before the reply card, and settles it even for a turn without process', async () => {
    const { lark, adapter } = make({ process: 'cot' });
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    expect(lark.log.indexOf('cot.create')).toBeGreaterThanOrEqual(0);
    expect(lark.log.indexOf('cot.create')).toBeLessThan(lark.log.indexOf('card.create'));
    t.p.answer = 'hi';
    t.p.status = 'completed';
    await adapter.finalize(route, id!, t.msg());
    await adapter.settled();
    expect(lark.cots).toHaveLength(1);
  });

  it('auto: bubble create failure shows panels on the card instead, remembered for the chat', async () => {
    const { lark, adapter, logs } = make({ process: 'auto' });
    lark.fail.set('cot.create', [230027]);
    const id = await run(adapter, turn());
    const final = cardOf(lark, id).json;
    expect(final.body.elements.map((e: any) => e.element_id)).toEqual(['status', 'answer', 'p_thinking', 'p_tools', 'p_plan', 'footer']);
    expect(logs.some((l) => l.includes('thinking bubble failed for chat:oc_chat'))).toBe(true);
    const creates = lark.log.filter((x) => x === 'cot.create').length;
    await run(adapter, turn('t2'));
    expect(lark.log.filter((x) => x === 'cot.create').length).toBe(creates); // not retried in this chat
    expect(lark.cots).toHaveLength(0);
  });

  it('auto: the bubble API missing (HTTP 404) is remembered for the whole app', async () => {
    const lark = new FakeLark();
    const { adapter } = make({ process: 'auto' }, lark);
    const req = lark.client.request;
    let attempts = 0;
    lark.client.request = async (o) => {
      if (o.url.startsWith('/open-apis/im/v1/message_cot')) {
        attempts++;
        throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: {} } });
      }
      return req(o);
    };
    const id = await run(adapter, turn());
    await run(adapter, turn('t2'), {}, { ...route, conversationId: 'oc_other' });
    expect(attempts).toBe(1); // the second chat does not even try
    expect(FakeLark.element(cardOf(lark, id).json, 'p_tools')).toBeDefined();
  });

  it('cot: a failing bubble never shows panels and never breaks the card; a mid-turn failure completes it as error', async () => {
    const { lark, adapter } = make({ process: 'cot' });
    lark.fail.set('cot.put', [0, 0, 99991400]); // prologue and first batch pass, then a failure
    const id = await run(adapter, turn());
    const final = cardOf(lark, id).json;
    expect(final.body.elements.map((e: any) => e.element_id)).toEqual(['status', 'answer', 'p_plan', 'footer']);
    expect(FakeLark.element(final, 'answer').content).toBe('Found a.ts and more.');
    expect(lark.cots[0]!.completed).toBe('error');
    expect(lark.log).toContain('cot.complete');
  });
});

describe('splitMarkdown', () => {
  it('keeps pages within budget, never cuts a code point, and re-opens fences', () => {
    const text = `# T\n\n${'段落'.repeat(400)}\n\n\`\`\`py\n${Array.from({ length: 200 }, (_, i) => `print(${i})`).join('\n')}\n\`\`\`\nend`;
    const pages = splitMarkdown(text, 600);
    expect(pages.length).toBeGreaterThan(3);
    for (const p of pages) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(600);
      expect(p).not.toContain('�');
      expect((p.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(pages.some((p) => p.startsWith('```py\n'))).toBe(true);
    expect(pages.join('').replace(/```py\n|```\n?/g, '')).toContain('print(199)');
    expect(splitMarkdown('short', 600)).toEqual(['short']);
  });
});

describe('thinking bubble: long content', () => {
  it('long reasoning and tool output go in pieces small enough for Lark; the bubble ends done, not failed', async () => {
    const { lark, adapter } = make({ process: 'cot' });
    lark.cotContentMax = 4000;
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    t.p.steps.push({ kind: 'reasoning', id: 'r0', text: '思考'.repeat(6000), done: true });
    t.p.steps.push({ kind: 'tool', itemId: 'i1', type: 'command', title: 'Bash: cat big.txt', status: 'completed', inputSummary: 'cat big.txt', resultPreview: '输出'.repeat(5000) });
    await adapter.edit(route, id!, t.msg(), { operationId: 'e1', sequence: 1 });
    t.p.status = 'completed';
    await adapter.finalize(route, id!, t.msg());
    await adapter.settled();
    const cot = lark.cots[0]!;
    expect(cot.completed).toBe('finished'); // settled by RUN_FINISHED, never closed as an error
    expect(cot.events.at(-1)!.event_type).toBe('RUN_FINISHED');
    expect(cot.events.filter((e) => e.event_type === 'REASONING_MESSAGE_CONTENT').map((e) => e.content.delta).join('')).toBe('思考'.repeat(6000));
  });

  it('when Lark still finds an event too long, the batch is sent again shortened and the bubble goes on', async () => {
    const { lark, adapter, logs } = make({ process: 'cot' });
    lark.cotContentMax = 300;
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    t.p.steps.push({ kind: 'tool', itemId: 'i1', type: 'command', title: 'Bash: ls', status: 'completed', inputSummary: 'ls', resultPreview: 'x'.repeat(900) });
    await adapter.edit(route, id!, t.msg(), { operationId: 'e1', sequence: 1 });
    t.p.status = 'completed';
    await adapter.finalize(route, id!, t.msg());
    await adapter.settled();
    expect(lark.cots[0]!.completed).toBe('finished');
    expect(lark.cots[0]!.events.at(-1)!.event_type).toBe('RUN_FINISHED');
    expect(logs.some((l) => l.includes('sent shortened'))).toBe(true);
  });
});

describe('thinking bubbles left open by a restart', () => {
  it('an open bubble is recorded under stateDir and forgotten once settled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-lark-state-'));
    try {
      const { lark, adapter } = make({ process: 'cot' }, undefined, { stateDir: dir });
      const t = turn();
      t.p.steps.push({ kind: 'reasoning', id: 'r0', text: 'hmm', done: false });
      const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
      await adapter.settled();
      expect(readdirSync(join(dir, 'open-bubbles'))).toHaveLength(1);
      t.p.status = 'completed';
      await adapter.finalize(route, id!, t.msg());
      await adapter.settled();
      expect(readdirSync(join(dir, 'open-bubbles'))).toHaveLength(0);
      expect(lark.cots).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the next process closes it at start, as finished with a line saying why, not failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-lark-state-'));
    try {
      const lark = new FakeLark();
      const first = make({ process: 'cot' }, lark, { stateDir: dir }).adapter;
      const t = turn();
      t.p.steps.push({ kind: 'reasoning', id: 'r0', text: 'working on it', done: false });
      await first.send(route, t.msg(), { operationId: 'o' });
      await first.settled(); // the process stops here, mid-turn

      const second = make({ process: 'cot' }, lark, { stateDir: dir }).adapter;
      const run = startAdapter(second);
      await waitFor(() => lark.cots[0]!.completed === 'finished');
      expect(lark.cots[0]!.events.map((e) => e.event_type).slice(-2)).toEqual(['REASONING_END', 'RUN_FINISHED']);
      expect(JSON.stringify(lark.cots[0]!.events)).toContain('重启');
      expect(readdirSync(join(dir, 'open-bubbles'))).toHaveLength(0);
      run.ctl.abort();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
