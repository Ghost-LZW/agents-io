import { describe, expect, it } from 'vitest';
import type { Body, RenderedMessage, SessionEvent } from '@agents-io/protocol';
import { foldTurn, newTurnView, renderTurn } from '@agents-io/session';
import { LarkBotAdapter, resolveConfig, unknownChatProcess } from '../src/index.js';
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

  it('keeps the running card compact, then adds status for approval and failure', async () => {
    const { lark, adapter } = make({ process: 'cot', look: 'chat' });
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    const card = cardOf(lark, id!);
    expect(card.json.header).toBeUndefined();
    expect(ids(card.json)).toEqual(['answer']);
    expect(card.json.config.streaming_config).toMatchObject({
      print_frequency_ms: { default: 50 },
      print_step: { default: 1 },
    });
    t.p.status = 'requires_action';
    await adapter.edit(route, id!, t.msg({
      sections: [{ kind: 'status', text: 'Approval needed: Bash' }],
      actions: [{ id: 'allow:bash', label: 'Allow', style: 'primary' }],
    }), { operationId: 'e1', sequence: 1 });
    expect(FakeLark.element(card.json, 'status').content).toContain('Approval needed: Bash');
    expect(ids(card.json).slice(0, 2)).toEqual(['status', 'answer']);
    expect(ids(card.json).at(-1)).toMatch(/^act_/);
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
    expect(header.template).toBe('blue');
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

describe('CoT before the reply card', () => {
  it('opens only after process appears, then reuses the same bubble for the card', async () => {
    const { lark, adapter } = make({ process: 'auto', look: 'chat' });
    const t = turn();
    await adapter.previewProgress(route, t.p, false);
    expect(lark.cots).toHaveLength(0);
    t.p.steps.push({ kind: 'reasoning', id: 'r0', text: 'Checking files', done: false });
    await adapter.previewProgress(route, t.p, false);
    expect(lark.cots).toHaveLength(1);
    expect(lark.messages).toHaveLength(0);
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    expect(lark.cots).toHaveLength(1);
    t.p.answer = 'Found it.';
    t.p.status = 'completed';
    await adapter.finalize(route, id!, t.msg());
    await adapter.settled();
    expect(lark.cots[0]!.completed).toBe('finished');
  });

  it('settles a preview when a short answer completes before any card', async () => {
    const { lark, adapter } = make({ process: 'auto', look: 'chat' });
    const t = turn();
    t.p.steps.push({ kind: 'tool', itemId: 'i1', type: 'command', title: 'Bash: pwd', status: 'running' });
    await adapter.previewProgress(route, t.p, false);
    t.p.answer = 'Done.';
    t.p.status = 'completed';
    await adapter.previewProgress(route, t.p, true);
    await adapter.send(route, t.msg({ text: 'Done.' }), { operationId: 'o' });
    await adapter.settled();
    expect(lark.cots).toHaveLength(1);
    expect(lark.cots[0]!.completed).toBe('finished');
    expect(lark.messages.map((m) => m.msg_type)).toEqual(['text']);
  });

  it('settles a preview if completion wins the queued-card race', async () => {
    const { lark, adapter } = make({ process: 'auto', look: 'chat' });
    const t = turn();
    t.p.steps.push({ kind: 'reasoning', id: 'r0', text: 'Checking', done: false });
    await adapter.previewProgress(route, t.p, false);
    t.p.answer = 'Done.';
    t.p.status = 'completed';
    await adapter.send(route, t.msg({ text: 'Done.' }), { operationId: 'o' });
    await adapter.settled();
    expect(lark.cots[0]!.completed).toBe('finished');
    expect(lark.messages.map((m) => m.msg_type)).toEqual(['text']);
  });

  it('does not delay the reply card while the CoT request is slow', async () => {
    const lark = new FakeLark();
    const request = lark.client.request!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    lark.client.request = async (o) => {
      if (o.method === 'POST' && o.url === '/open-apis/im/v1/message_cot') await gate;
      return request(o);
    };
    const { adapter } = make({ process: 'auto', look: 'chat' }, lark);
    const t = turn();
    t.p.steps.push({ kind: 'reasoning', id: 'r0', text: 'Working', done: false });
    await adapter.previewProgress(route, t.p, false);
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    expect(id).toBeTruthy();
    expect(lark.cots).toHaveLength(0);
    release();
    t.p.answer = 'Done.';
    t.p.status = 'completed';
    await adapter.finalize(route, id!, t.msg());
    await adapter.settled();
    expect(lark.cots[0]!.completed).toBe('finished');
  });

  it('uses a text message for completed prose longer than 500 characters', async () => {
    const { lark, adapter } = make({ process: 'auto', look: 'chat' });
    const t = turn();
    t.p.answer = 'x'.repeat(501);
    t.p.status = 'completed';
    await adapter.send(route, t.msg({ text: t.p.answer }), { operationId: 'o' });
    expect(lark.messages[0]?.msg_type).toBe('text');
  });

  it('uses a rich-text post for a completed Markdown list', async () => {
    const { lark, adapter } = make({ process: 'auto', look: 'chat' });
    const t = turn();
    t.p.status = 'completed';
    await adapter.send(route, t.msg({ text: '## Results\n- one\n- two' }), { operationId: 'o' });
    expect(lark.messages[0]?.msg_type).toBe('post');
  });

  it('uses a card for completed prose beyond one message', async () => {
    const { lark, adapter } = make({ process: 'auto', look: 'chat' });
    const t = turn();
    t.p.answer = 'x'.repeat(4001);
    t.p.status = 'completed';
    await adapter.send(route, t.msg({ text: t.p.answer }), { operationId: 'o' });
    expect(lark.messages[0]?.msg_type).toBe('interactive');
  });

  it('uses a card for a short answer with structured Markdown', async () => {
    const { lark, adapter } = make({ process: 'auto', look: 'chat' });
    const t = turn();
    t.p.status = 'completed';
    await adapter.send(route, t.msg({ text: '```ts\nconst x = 1;\n```' }), { operationId: 'o' });
    expect(lark.messages[0]?.msg_type).toBe('interactive');
  });

  it('uses a card for a Markdown table', async () => {
    const { lark, adapter } = make({ process: 'auto', look: 'chat' });
    const t = turn();
    t.p.status = 'completed';
    await adapter.send(route, t.msg({ text: '| A | B |\n|---|---|\n| 1 | 2 |' }), { operationId: 'o' });
    expect(lark.messages[0]?.msg_type).toBe('interactive');
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

  it('a group chat uses its own mode; a chat not seen yet gets the strictest configured', async () => {
    const { lark, adapter } = await started({ process: 'cot', processByChat: { group: 'off' } });
    // Not heard from yet: it may be a group, and groups are `off` — no bubble, a plain card.
    await adapter.send(route, turn().msg(), { operationId: 'unknown' });
    expect(lark.cots).toHaveLength(0);
    expect(lark.messages.at(-1)!.msg_type).toBe('interactive');
    expect(lark.cards.size).toBe(0);
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'group', id: 'om_g1' }));
    await adapter.send(route, turn('t2').msg(), { operationId: 'group' });
    expect(lark.cots).toHaveLength(0);
    expect(lark.messages.at(-1)!.msg_type).toBe('interactive');
    expect(lark.cards.size).toBe(0); // the group reply is a plain card, not a process card
  });

  it('upstream U22: the default `process` (auto) no longer shows a process in a chat not learnt yet when a kind is `off`', async () => {
    for (const config of [{ processByChat: { group: 'off' } }, { processByChat: { dm: 'off' } }, { process: 'off', processByChat: { dm: 'auto', group: 'cot' } }]) {
      const { lark, adapter } = await started(config);
      await adapter.send(route, turn().msg(), { operationId: 'unknown' });
      expect(lark.cots, JSON.stringify(config)).toHaveLength(0);
      expect(lark.cards.size, JSON.stringify(config)).toBe(0);
    }
    // A DM learnt as one gets its own mode again.
    const { lark, adapter } = await started({ process: 'off', processByChat: { dm: 'cot', group: 'off' } });
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p' }));
    await adapter.send(route, turn().msg(), { operationId: 'dm' });
    expect(lark.cots).toHaveLength(1);
  });

  it('the strictest mode of a chat not learnt yet: off, then panels, then cot, then auto', () => {
    const u = (c: object) => unknownChatProcess(resolveConfig({ ...cfg, ...c }));
    expect(u({})).toBe('auto');
    expect(u({ process: 'cot' })).toBe('cot');
    expect(u({ processByChat: { group: 'off' } })).toBe('off');
    expect(u({ process: 'off', processByChat: { dm: 'auto', group: 'auto' } })).toBe('off');
    expect(u({ processByChat: { dm: 'cot', group: 'panels' } })).toBe('panels');
    expect(u({ process: 'auto', processByChat: { dm: 'cot' } })).toBe('cot');
  });

  it('a DM uses the dm mode', async () => {
    const { lark, adapter } = await started({ process: 'off', processByChat: { dm: 'cot' } });
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p' }));
    await adapter.send(route, turn().msg(), { operationId: 'dm' });
    expect(lark.cots).toHaveLength(1);
  });
});

describe('processDmUsers', () => {
  async function started(config: object) {
    const lark = new FakeLark();
    const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps, sleep: async () => {} });
    startAdapter(adapter);
    await tick();
    return { lark, adapter };
  }
  /** A running turn's flat message: the compositor's tool status line, a plan, and a tool step with what it read. */
  const reading = () => {
    const t = turn();
    t.p.steps.push({ kind: 'reasoning', id: 'r0', text: 'thinking about 小红的私聊', done: true });
    t.p.steps.push({ kind: 'tool', itemId: 'i1', type: 'command', title: 'Bash: chatlog read dm', status: 'running', inputSummary: 'chatlog read dm', resultPreview: '小红的私聊原文' });
    return t.msg({ sections: [{ kind: 'details', text: '◐ 读小红的私聊', collapsed: true }, { kind: 'status', text: '▶ Bash: chatlog read dm' }] });
  };
  const shown = (lark: FakeLark) => JSON.stringify([...lark.messages, ...lark.cots, ...lark.cards.values()]);

  it('a listed person (by union_id or open_id) sees the DM process as before', async () => {
    for (const id of ['on_alice', 'ou_alice']) {
      const { lark, adapter } = await started({ process: 'off', processByChat: { dm: 'cot', group: 'off' }, processDmUsers: [id] });
      await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p' }));
      await adapter.send(route, reading(), { operationId: 'dm' });
      await adapter.settled();
      expect(lark.cots, id).toHaveLength(1);
    }
  });

  it('someone not listed: off, and the flat card names no tool and has no plan', async () => {
    const { lark, adapter } = await started({ process: 'off', processByChat: { dm: 'auto', group: 'off' }, processDmUsers: ['on_owner'] });
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p', sender: { union_id: 'on_friend', open_id: 'ou_friend' } }));
    const { providerMessageId: id } = await adapter.send(route, reading(), { operationId: 'dm' });
    await adapter.edit(route, id!, reading(), { operationId: 'e1', sequence: 1 });
    await adapter.settled();
    expect(lark.cots).toHaveLength(0);
    expect(lark.cards.size).toBe(0);
    expect(lark.messages.at(-1)!.msg_type).toBe('interactive');
    const out = shown(lark);
    expect(out).not.toContain('chatlog read');
    expect(out).not.toContain('小红');
    expect(out).toContain('处理中…');
  });

  it('a DM whose person is not known, and a chat whose kind is not known: off', async () => {
    // Not heard from yet (a send before any message, a restart): it may be anyone's DM.
    const a = await started({ process: 'cot', processDmUsers: ['on_alice'] });
    await a.adapter.send(route, reading(), { operationId: 'unknown' });
    await a.adapter.settled();
    expect(a.lark.cots).toHaveLength(0);
    expect(shown(a.lark)).not.toContain('chatlog read');
    // A DM learnt only from the bot's own echo: its person is not known.
    const b = await started({ process: 'cot', processDmUsers: ['on_alice'] });
    await b.lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p', senderType: 'app', sender: { open_id: 'ou_bot' } }));
    await b.adapter.send(route, reading(), { operationId: 'echo' });
    await b.adapter.settled();
    expect(b.lark.cots).toHaveLength(0);
    // `[]`: no DM shows a process, not even a known person's.
    const c = await started({ process: 'cot', processDmUsers: [] });
    await c.lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p' }));
    await c.adapter.send(route, reading(), { operationId: 'none' });
    await c.adapter.settled();
    expect(c.lark.cots).toHaveLength(0);
  });

  it('groups are not affected; unset, every DM by its mode as before', async () => {
    const g = await started({ process: 'cot', processDmUsers: ['on_owner'] });
    await g.lark.fire('im.message.receive_v1', messageEvent({ chatType: 'group', id: 'om_g1' }));
    await g.adapter.send(route, reading(), { operationId: 'group' });
    await g.adapter.settled();
    expect(g.lark.cots).toHaveLength(1);
    const d = await started({ process: 'cot' });
    await d.lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p', sender: { union_id: 'on_friend' } }));
    await d.adapter.send(route, reading(), { operationId: 'dm' });
    await d.adapter.settled();
    expect(d.lark.cots).toHaveLength(1);
  });

  it('is a list of ids', () => {
    expect(resolveConfig({ ...cfg, processDmUsers: [' on_a '] }).processDmUsers).toEqual(new Set(['on_a']));
    expect(resolveConfig({ ...cfg }).processDmUsers).toBeUndefined();
    expect(() => resolveConfig({ ...cfg, processDmUsers: 'on_a' as unknown as string[] })).toThrow(/processDmUsers/);
    expect(() => resolveConfig({ ...cfg, processDmUsers: [''] })).toThrow(/processDmUsers/);
  });
});

describe('a chat that shows no process: while the turn runs its card says only 「处理中…」', () => {
  async function started(config: object) {
    const lark = new FakeLark();
    const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps, sleep: async () => {} });
    startAdapter(adapter);
    await tick();
    return { lark, adapter };
  }
  /** Process off in groups and outside the list, a DM process for the one listed. */
  const config = { process: 'off', processByChat: { dm: 'auto', group: 'off' }, processDmUsers: ['on_owner'] };
  /** The chats whose process is off, as the adapter learns them (or does not). */
  const offChats: [string, (lark: FakeLark) => Promise<unknown>][] = [
    ['a group', (lark) => lark.fire('im.message.receive_v1', messageEvent({ chatType: 'group', id: 'om_g1', sender: { union_id: 'on_owner', open_id: 'ou_owner' } }))],
    ['the DM of someone not listed', (lark) => lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p', sender: { union_id: 'on_friend', open_id: 'ou_friend' } }))],
    ['a chat not learnt yet', async () => undefined],
  ];
  const INTERIM = '我先翻一下小红和小明的私聊。';
  const ANSWER = '他们在商量周末去爬山。';
  /** What the model was saying when its turn failed or was interrupted: words of the private chat it read. */
  const CUT = '翻到了：小明问周末';
  /** A flat card as sent, then as each patch left it: its markdown in order, then its buttons in []. */
  const versions = (lark: FakeLark, id: string) => {
    const m = lark.messages.find((x) => x.id === id)!;
    return [m.content, ...m.patches].map((c) => {
      const els = JSON.parse(c).body.elements as any[];
      return [
        ...els.filter((e) => e.tag === 'markdown').map((e) => e.content as string),
        ...els.filter((e) => e.tag === 'button').map((e) => `[${e.text.content}]`),
      ];
    });
  };
  /** The card's summary (what the chat list shows) in each version. */
  const summaries = (lark: FakeLark, id: string) => {
    const m = lark.messages.find((x) => x.id === id)!;
    return [m.content, ...m.patches].map((c) => JSON.parse(c).config.summary.content as string);
  };

  /** What a turn the idle deadline stopped after a tool with side effects says after what it said so far (HC-3b, the host's `idleStallNotice`). */
  const STALL = '（这一轮停住了：模型 90 秒没有回音。已经做过的（Bash）不会重做；要接着做就说一声。）';
  /**
   * How the turn ends: it answers (`completed`); it fails or is interrupted while the model is
   * saying something, with no final snapshot (`failed`, `interrupted`); the idle deadline stops it
   * after a Bash call (HC-3b): its final snapshot is what it said so far and the notice, `failed`.
   */
  type End = 'completed' | 'failed' | 'interrupted' | 'stalled';
  const view = () => {
    const v = newTurnView('t1', 1000);
    let n = 0;
    const fold = (body: Body, extra: Partial<SessionEvent> = {}) =>
      foldTurn(v, { v: 1, sessionKey: 's', seq: ++n, harness: 'fake', generation: 1, visibility: 'participants', ts: 1000 + n, turnId: 't1', level: 'primary', audience: 'status', durability: 'durable', ...extra, body } as SessionEvent);
    const render = () => renderTurn(v, 'card', { route, caps: { buttons: true, text: { maxChars: 4000, markdown: 'full' } } });
    const end = (how: End) => {
      if (how === 'stalled') fold({ t: 'text.snapshot', text: `${INTERIM}\n\n${STALL}`, final: true }, { audience: 'answer' });
      fold({ t: 'turn.completed', turnId: 't1', status: how === 'stalled' ? 'failed' : how, ...(how === 'stalled' ? { error: { code: 'idle_timeout', retryable: false } } : {}) });
    };
    return { v, fold, render, end };
  };
  /**
   * One turn as the session compositor folds and renders it (`foldTurn`, `renderTurn`, card tier),
   * each render sent, edited or finalized the way the compositor does: the model says what it
   * will look at, calls a tool, says more, an approval waits, another tool, then (`completed`) the
   * answer streams, the final snapshot, the end — or it starts to say what it found and the turn
   * fails or is interrupted, or the idle deadline stops it (`End`). Returns the card's id and the
   * renders it was given.
   */
  async function compositorTurn(adapter: LarkBotAdapter, how: End = 'completed') {
    const { fold, render, end } = view();
    const tool = (itemId: string, title: string, status: 'running' | 'completed', more: object = {}) => ({ item: { itemId, type: 'command' as const, title, status, ...more } });
    const given: RenderedMessage[] = [];
    fold({ t: 'text.delta', delta: INTERIM, stream: 'answer' }, { audience: 'answer' });
    given.push(render());
    const { providerMessageId: id } = await adapter.send(route, given[0]!, { operationId: 'o' });
    const tail: (() => void)[] = how === 'completed'
      ? [
          () => fold({ t: 'text.delta', delta: ANSWER, stream: 'answer' }, { audience: 'answer' }),
          () => fold({ t: 'text.snapshot', text: ANSWER, final: true }, { audience: 'answer' }),
        ]
      : how === 'stalled' ? [] : [() => fold({ t: 'text.delta', delta: CUT, stream: 'answer' }, { audience: 'answer' })];
    const steps: (() => void)[] = [
      () => fold({ t: 'item.started', ...tool('i1', 'Bash: chatlog read dm', 'running', { inputSummary: 'chatlog read dm' }) }),
      () => fold({ t: 'item.completed', ...tool('i1', 'Bash: chatlog read dm', 'completed', { result: { preview: '小明：周末去爬山吗', truncated: false, isError: false } }) }),
      () => fold({ t: 'headline', text: '读完了小红和小明的私聊' }),
      () => fold({ t: 'text.delta', delta: '再看一下日历。', stream: 'answer' }, { audience: 'answer' }),
      () => fold({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'Bash: rm -rf build', risk: {}, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true, resolver: { kind: 'human', principals: [], routes: [] } }),
      () => fold({ t: 'request.resolved', requestId: 'r1', decision: { kind: 'allow_once' }, by: { kind: 'human', id: 'lark-bot:on_owner' } }),
      () => fold({ t: 'item.started', ...tool('i2', 'Calendar: list', 'running') }),
      () => fold({ t: 'item.completed', ...tool('i2', 'Calendar: list', 'completed') }),
      ...tail,
    ];
    for (const [i, step] of steps.entries()) {
      step();
      given.push(render());
      await adapter.edit(route, id!, given.at(-1)!, { operationId: `e${i + 1}`, sequence: i + 1 });
    }
    end(how);
    given.push(render());
    await adapter.finalize(route, id!, given.at(-1)!);
    await adapter.settled();
    return { id: id!, given };
  }

  const working = ['处理中…'];
  const approval = ['处理中…', 'Approval needed: Bash: rm -rf build', '[Allow]', '[Deny]'];
  /** send, 4 edits before the approval, the approval, 5 edits after it, the end. */
  const quiet = [working, working, working, working, working, approval, working, working, working, working, working, [ANSWER, 'Done']];
  /** Everything the turn said or read along the way (none of it is a final answer). */
  const LEAKS = ['我先翻', '再看一下日历', 'chatlog read', '读完了', '小明', 'Calendar', '翻到了'];
  /** How a turn that did not complete ends here: the words alone, also in the chat list. */
  const ENDED: Record<Exclude<End, 'completed'>, string> = { failed: '没答完', interrupted: '被打断了', stalled: '没答完' };

  for (const [name, learn] of offChats) {
    it(`${name}: no interim words, tool title, headline or plan while it runs; the approval shows; the answer at the end`, async () => {
      const { lark, adapter } = await started(config);
      await learn(lark);
      const { id, given } = await compositorTurn(adapter);
      // What the compositor gave the adapter does carry the interim words in the text while the turn runs.
      expect(given[0]!.text).toBe(INTERIM);
      expect(given.some((m) => m.text.includes('再看一下日历') && m.progress?.status === 'running')).toBe(true);
      expect(given.some((m) => m.text.includes(ANSWER) && m.progress?.status === 'running')).toBe(true);
      expect(lark.cots).toHaveLength(0);
      expect(lark.cards.size).toBe(0);
      expect(lark.messages).toHaveLength(1);
      expect(versions(lark, id)).toEqual(quiet);
      expect(summaries(lark, id).slice(0, -1).every((s) => s === '处理中…')).toBe(true);
      expect(summaries(lark, id).at(-1)).toBe(ANSWER);
      const all = JSON.stringify(lark.messages);
      for (const leak of LEAKS) expect(all, leak).not.toContain(leak);
    });

    for (const how of ['failed', 'interrupted', 'stalled'] as const) {
      it(`${name}: a turn that ${how === 'stalled' ? 'the idle deadline stopped (HC-3b: what it said so far and the notice as its final snapshot)' : `${how} with no final snapshot`} ends saying only 「${ENDED[how]}」, none of what it said along the way`, async () => {
        const { lark, adapter } = await started(config);
        await learn(lark);
        const { id, given } = await compositorTurn(adapter, how);
        // The compositor's end still carries what was said along the way as its text (ends that show it keep it).
        const last = given.at(-1)!;
        expect(last.progress?.status).toBe(how === 'interrupted' ? 'interrupted' : 'failed');
        expect(last.text).toContain(how === 'stalled' ? INTERIM : CUT);
        expect(last.progress?.finalAnswer).toBeUndefined();
        expect(lark.cots).toHaveLength(0);
        expect(lark.cards.size).toBe(0);
        expect(lark.messages).toHaveLength(1);
        const before = [working, working, working, working, working, approval, working, working, working, ...(how === 'stalled' ? [] : [working])];
        expect(versions(lark, id)).toEqual([...before, [ENDED[how]]]);
        expect(summaries(lark, id).at(-1)).toBe(ENDED[how]);
        const all = JSON.stringify(lark.messages);
        for (const leak of [...LEAKS, '停住了']) expect(all, leak).not.toContain(leak);
      });
    }
  }

  it('a turn that ended before its card opened gets one message: the answer, or how it ended; never the text so far (also `look: chat`)', async () => {
    for (const look of ['console', 'chat'] as const) {
      const { lark, adapter } = await started({ ...config, look });
      await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'group', id: 'om_g1' }));
      const one = async (how: End | 'silent', op: string) => {
        const { fold, render, end } = view();
        fold({ t: 'text.delta', delta: INTERIM, stream: 'answer' }, { audience: 'answer' });
        fold({ t: 'item.started', item: { itemId: 'i1', type: 'command', title: 'Bash: chatlog read dm', status: 'running' } });
        fold({ t: 'item.completed', item: { itemId: 'i1', type: 'command', title: 'Bash: chatlog read dm', status: 'completed' } });
        if (how === 'completed') fold({ t: 'text.snapshot', text: ANSWER, final: true }, { audience: 'answer' });
        else if (how !== 'stalled') fold({ t: 'text.delta', delta: CUT, stream: 'answer' }, { audience: 'answer' });
        // `silent`: it completed without a final answer (it said nothing after its tool call that a harness took as one).
        end(how === 'silent' ? 'completed' : how);
        const { providerMessageId: id } = await adapter.send(route, render(), { operationId: op });
        await adapter.settled();
        const m = lark.messages.find((x) => x.id === id)!;
        return m.msg_type === 'interactive' ? versions(lark, id!)[0] : [JSON.parse(m.content).text];
      };
      expect(await one('completed', 'a'), look).toEqual(look === 'chat' ? [ANSWER] : [ANSWER, 'Done']);
      expect(await one('failed', 'b'), look).toEqual(['没答完']);
      expect(await one('interrupted', 'c'), look).toEqual(['被打断了']);
      expect(await one('stalled', 'd'), look).toEqual(['没答完']);
      expect(await one('silent', 'e'), look).toEqual(['已完成']);
      const all = JSON.stringify(lark.messages);
      for (const leak of LEAKS) expect(all, `${look}: ${leak}`).not.toContain(leak);
    }
  });

  it('in English: Did not finish, Interrupted, Outcome unknown', async () => {
    const { lark, adapter } = await started({ ...config, locale: 'en' });
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'group', id: 'om_g1' }));
    for (const [status, said] of [['failed', 'Did not finish'], ['interrupted', 'Interrupted'], ['ambiguous', 'Outcome unknown']] as const) {
      const t = turn();
      t.p.answer = INTERIM;
      const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: status });
      t.p.status = status;
      t.p.answerFinal = true;
      await adapter.finalize(route, id!, t.msg({ sections: [{ kind: 'status', text: 'Failed' }] }));
      expect(versions(lark, id!).at(-1), status).toEqual([said]);
    }
    expect(JSON.stringify(lark.messages)).not.toContain('我先翻');
  });

  it('in English the line is Working…; a card without progress keeps its text and says Working… on its status line', async () => {
    const { lark, adapter } = await started({ ...config, locale: 'en' });
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'group', id: 'om_g1' }));
    const t = turn();
    t.p.answer = INTERIM;
    const { providerMessageId: id } = await adapter.send(route, t.msg({ sections: [{ kind: 'status', text: '▶ Bash: chatlog read dm' }] }), { operationId: 'o' });
    expect(versions(lark, id!)).toEqual([['Working…']]);
    const { providerMessageId: other } = await adapter.send(route, { text: 'A note from the host', sections: [{ kind: 'status', text: '▶ Bash: chatlog read dm' }] }, { operationId: 'n' });
    expect(versions(lark, other!)).toEqual([['A note from the host', 'Working…']]);
  });

  it('the DM of the one listed: as before (the process card streams the answer, and a flat card keeps its text and status line)', async () => {
    const { lark, adapter } = await started(config);
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p', sender: { union_id: 'on_owner', open_id: 'ou_owner' } }));
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg({ sections: [{ kind: 'status', text: '▶ Bash: chatlog read dm' }] }), { operationId: 'o' });
    expect(lark.cards.size).toBe(1);
    expect(FakeLark.element(cardOf(lark, id!).json, 'status').content).toContain('▶ Bash: chatlog read dm');
    t.p.answer = '他们在商量';
    await adapter.edit(route, id!, t.msg(), { operationId: 'e1', sequence: 1 });
    expect(FakeLark.element(cardOf(lark, id!).json, 'answer').content).toContain('他们在商量');
    // A message that takes the flat card here (no `progress`) is not rewritten either.
    const plan = { kind: 'details' as const, text: '◐ 读小红的私聊', collapsed: true };
    const { providerMessageId: flat } = await adapter.send(route, { text: INTERIM, sections: [plan, { kind: 'status', text: '▶ Bash: chatlog read dm' }] }, { operationId: 'f' });
    await adapter.settled();
    expect(versions(lark, flat!)).toEqual([[INTERIM, '▶ Bash: chatlog read dm']]);
    expect(lark.messages.find((m) => m.id === flat)!.content).toContain('读小红的私聊'); // the plan, in its panel
  });

  it('the DM of the one listed: a turn that failed ends as before (its process card keeps what it was saying, and says it failed)', async () => {
    const { lark, adapter } = await started(config);
    await lark.fire('im.message.receive_v1', messageEvent({ chatType: 'p2p', sender: { union_id: 'on_owner', open_id: 'ou_owner' } }));
    const { id } = await compositorTurn(adapter, 'failed');
    const card = cardOf(lark, id).json;
    expect(FakeLark.element(card, 'answer').content).toContain(CUT);
    expect(FakeLark.element(card, 'status').content).toContain('失败');
  });
});
