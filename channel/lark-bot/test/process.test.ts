import { describe, expect, it } from 'vitest';
import type { ProgressView, RenderedMessage, ReplyRoute } from '@agents-io/protocol';
import { LarkBotAdapter, splitMarkdown, type LarkBotConfig } from '../src/index.js';
import { buildModel } from '../src/process-card.js';
import { FakeLark } from './fake-lark.js';

const cfg = {
  appId: 'cli_x',
  appSecret: 's',
  domain: 'feishu' as const,
  editMinIntervalMs: 0,
  streamTextIntervalMs: 0,
  streamAuxIntervalMs: 0,
};
const route: ReplyRoute = { channel: 'lark-bot', account: 'acct', conversationId: 'oc_chat', replyToMessageId: 'om_in1' };

function make(config: Partial<LarkBotConfig> = {}, lark = new FakeLark()) {
  const logs: string[] = [];
  const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps, sleep: async () => {}, log: (l, m) => logs.push(`${l}: ${m}`) });
  return { lark, adapter, logs };
}

/** A scripted turn: each call to `next` mutates the view and returns the message to render. */
function turn(turnId = 't1') {
  const p: ProgressView = { turnId, status: 'running', steps: [], answer: '', answerFinal: false, startedAt: 1000 };
  const msg = (extra: Partial<RenderedMessage> = {}): RenderedMessage => ({
    text: p.answer || '…',
    sections: [{ kind: 'status', text: 'Working…' }],
    progress: structuredClone(p),
    ...extra,
  });
  return { p, msg };
}

function script(t: ReturnType<typeof turn>) {
  const { p } = t;
  return [
    () => p.steps.push({ kind: 'reasoning', id: 'r0', text: 'Thinking about it', done: false }),
    () => {
      (p.steps[0] as { done: boolean }).done = true;
      p.steps.push({ kind: 'tool', itemId: 'i1', type: 'command', title: 'Bash: ls', status: 'running', inputSummary: 'ls' });
      p.plan = [{ text: 'look', status: 'in_progress' }];
    },
    () => {
      Object.assign(p.steps[1]!, { status: 'completed', resultPreview: 'a.ts', isError: false });
      p.steps.push({ kind: 'narration', id: 'n2', text: 'Now reading' });
      p.answer = 'Found a.ts';
    },
    () => {
      p.answer += ' and more.';
    },
  ];
}

async function run(adapter: LarkBotAdapter, t: ReturnType<typeof turn>, extra: Partial<RenderedMessage> = {}, r = route) {
  const { providerMessageId: id } = await adapter.send(r, t.msg(extra), { operationId: `${t.p.turnId}:open` });
  let seq = 0;
  for (const step of script(t)) {
    step();
    await adapter.edit(r, id!, t.msg({ sections: [{ kind: 'status', text: `▶ step ${seq}` }], ...extra }), { operationId: `${t.p.turnId}:e${++seq}`, sequence: seq });
  }
  t.p.status = 'completed';
  t.p.answerFinal = true;
  t.p.endedAt = 5000;
  await adapter.finalize(r, id!, t.msg({ sections: [{ kind: 'status', text: 'Done' }] }));
  await adapter.settled();
  return id!;
}

const cardOf = (lark: FakeLark, id: string) => {
  const m = lark.messages.find((x) => x.id === id)!;
  return lark.cards.get(JSON.parse(m.content).data.card_id)!;
};

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
    expect(ops).toContain('cardElement.create:status'); // thinking panel inserted after the status banner
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
    expect(els).toEqual(['status', 'p_thinking', 'p_tools', 'p_plan', 'answer', 'footer']); // stop button gone
    expect(FakeLark.element(final, 'answer').content).toBe('Found a.ts and more.');
    expect(FakeLark.element(final, 'p_tools_md').content).toContain('✅ `Bash: ls`');
    expect(FakeLark.element(final, 'p_thinking_md').content).toContain('Thinking about it');
    expect(FakeLark.element(final, 'p_thinking_md').content).toContain('💬 Now reading');
    expect(FakeLark.element(final, 'p_plan_md').content).toBe('◐ look');
    expect(FakeLark.element(final, 'footer').content).toContain('用时 4s');
    expect(final.body.elements.every((e: any) => e.tag !== 'collapsible_panel' || e.expanded === false)).toBe(true);
  });

  it('renders action buttons as callbacks and removes them when they go away', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    const stop = { id: 'turn:t1:interrupt', label: 'Stop', style: 'danger' as const };
    const { providerMessageId: id } = await adapter.send(route, t.msg({ actions: [stop] }), { operationId: 'o' });
    const card = cardOf(lark, id!);
    const btn = card.json.body.elements.find((e: any) => e.tag === 'button');
    expect(btn).toMatchObject({ type: 'danger', behaviors: [{ type: 'callback', value: { actionId: 'turn:t1:interrupt' } }] });
    const approve = { id: 'req:r1:allow_once', label: 'Allow', style: 'primary' as const };
    await adapter.edit(route, id!, t.msg({ actions: [approve, stop] }), { operationId: 'e1', sequence: 1 });
    expect(card.json.body.elements.filter((e: any) => e.tag === 'button').map((e: any) => e.behaviors[0].value.actionId)).toEqual([
      'turn:t1:interrupt',
      'req:r1:allow_once',
    ]);
    await adapter.edit(route, id!, t.msg({ actions: [stop] }), { operationId: 'e2', sequence: 2 });
    expect(card.json.body.elements.filter((e: any) => e.tag === 'button')).toHaveLength(1);
    expect(card.json.body.elements.at(-1).element_id).toBe('footer');
  });

  it('is idempotent per operationId and drops stale edit sequences', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    const a = await adapter.send(route, t.msg(), { operationId: 'same' });
    const b = await adapter.send(route, t.msg(), { operationId: 'same' });
    expect(b).toEqual(a);
    t.p.answer = 'two';
    await adapter.edit(route, a.providerMessageId!, t.msg(), { operationId: 'e2', sequence: 2 });
    t.p.answer = 'one';
    await adapter.edit(route, a.providerMessageId!, t.msg(), { operationId: 'e1', sequence: 1 });
    expect(lark.messages).toHaveLength(1);
    expect(FakeLark.element(cardOf(lark, a.providerMessageId!).json, 'answer').content).toBe('two');
    // A restart re-sends under the same uuid: still one platform message.
    const fresh = make({ process: 'panels' }, lark).adapter;
    expect(await fresh.send(route, t.msg(), { operationId: 'same' })).toEqual(a);
    expect(lark.messages).toHaveLength(1);
  });

  it('retries interaction-lock / rate-limit rejections with the same sequence and uuid', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    lark.fail.set('cardElement.content', [200810, 99991400]);
    t.p.answer = 'hello';
    await adapter.edit(route, id!, t.msg(), { operationId: 'e', sequence: 1 });
    const card = cardOf(lark, id!);
    expect(card.ops.filter((o) => o.op === 'cardElement.content')).toHaveLength(1);
    expect(lark.log.filter((x) => x === 'cardElement.content:answer')).toHaveLength(3);
    expect(FakeLark.element(card.json, 'answer').content).toBe('hello');
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

  it('takes over a CardKit card it did not send (restart) via idConvert + card.update', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    const fresh = make({ process: 'panels' }, lark).adapter;
    lark.fail.set('message.patch', [230020]);
    t.p.answer = 'after restart';
    await fresh.edit(route, id!, t.msg(), { operationId: 'e', sequence: 1 });
    expect(FakeLark.element(cardOf(lark, id!).json, 'answer').content).toBe('after restart');
  });

  it("process: 'off' keeps the flat card and advertises no native stream", async () => {
    const { lark, adapter } = make({ process: 'off' });
    expect(adapter.caps().nativeStream).toBeUndefined();
    expect(make().adapter.caps().nativeStream).toEqual({ minIntervalMs: 0, maxBytes: 100_000 });
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
    expect(final.body.elements.map((e: any) => e.element_id)).toEqual(['status', 'p_plan', 'answer', 'footer']);
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
    expect(final.body.elements.map((e: any) => e.element_id)).toEqual(['status', 'p_thinking', 'p_tools', 'p_plan', 'answer', 'footer']);
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
    expect(final.body.elements.map((e: any) => e.element_id)).toEqual(['status', 'p_plan', 'answer', 'footer']);
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

describe('card style', () => {
  const p: ProgressView = {
    turnId: 't', status: 'completed', answer: 'ok', answerFinal: true, startedAt: 0, endedAt: 2000,
    steps: [
      { kind: 'narration', id: 'n1', text: 'Looking' },
      { kind: 'tool', itemId: 'i1', type: 'command', title: 'Bash: ls', status: 'completed' },
      { kind: 'tool', itemId: 'i2', type: 'command', title: 'Bash: false', status: 'failed' },
    ],
  };
  const opts = { locale: 'zh' as const, processElsewhere: false, maxEntries: 8, panelMaxChars: 3000, answerBytes: 10_000, now: 2000 };
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

  it('emoji (default) decorates status, panels and tool lines', () => {
    const m = buildModel({ text: 'ok', progress: p }, p, opts);
    expect(m.panels.map((x) => x.title)).toEqual(['💭 思考过程', '🛠 工具调用']);
    expect(m.panels[1]!.body).toContain('✅ `Bash: ls`');
    expect(m.footer).toMatch(emoji);
  });

  it('plain uses words only; the header colour still carries status', () => {
    const m = buildModel({ text: 'ok', progress: p }, p, { ...opts, style: 'plain' });
    const all = [m.banner, m.footer, ...m.panels.flatMap((x) => [x.title, x.body])].join('\n');
    expect(all).not.toMatch(emoji);
    expect(m.panels[1]!.body).toContain('`Bash: false` 失败');
    expect(m.template).toBe('green');
  });
});
