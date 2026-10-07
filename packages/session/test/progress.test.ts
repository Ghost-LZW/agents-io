import { afterEach, describe, expect, it } from 'vitest';
import { FakeChannel, FakeHarness, defaultChannelCaps, type FakeTurnScript } from '@agents-io/testkit';
import type { Body, HarnessEvent, RenderedMessage, SessionEvent } from '@agents-io/protocol';
import {
  Compositor,
  Hub,
  Ingress,
  Lane,
  MemorySessionLog,
  Outbox,
  defaultPolicy,
  foldTurn,
  interruptActionId,
  newTurnView,
  parseInterruptActionId,
  progressOf,
  renderTurn,
} from '../src/index.js';
import { RUN, bodies, until } from './helpers.js';

let seq = 0;
function ev(body: Body, extra: Partial<HarnessEvent> = {}): SessionEvent {
  return {
    v: 1,
    sessionKey: 's',
    seq: ++seq,
    harness: 'fake',
    generation: 1,
    visibility: 'participants',
    ts: 1000 + seq,
    turnId: 't1',
    level: 'primary',
    audience: 'status',
    durability: 'durable',
    ...extra,
    body,
  } as SessionEvent;
}

const tool = (itemId: string, title: string, status: 'running' | 'completed' | 'failed' = 'running', more: object = {}) => ({
  itemId,
  type: 'command' as const,
  title,
  status,
  ...more,
});

describe('ProgressView folding', () => {
  it('orders reasoning, narration and tools; interim answer text becomes narration', () => {
    const v = newTurnView('t1', 500);
    const fold = (b: Body, x: Partial<HarnessEvent> = {}) => foldTurn(v, ev(b, x));
    expect(fold({ t: 'text.delta', delta: 'Let me ', stream: 'reasoning' }, { audience: 'commentary' })).toBe(true);
    fold({ t: 'text.delta', delta: 'think.', stream: 'reasoning' }, { audience: 'commentary' });
    fold({ t: 'text.delta', delta: 'Checking files', stream: 'answer' }, { audience: 'answer' });
    fold({ t: 'text.snapshot', text: 'Checking files.', final: false }, { audience: 'answer' });
    fold({ t: 'item.started', item: tool('i1', 'ls src', 'running', { inputSummary: 'ls src' }) }, { audience: 'commentary' });
    fold({ t: 'item.started', item: tool('i2', 'grep x', 'running') }, { audience: 'commentary', parentItemId: 'i1' });
    fold({ t: 'item.completed', item: tool('i1', 'ls src', 'completed', { result: { preview: 'a.ts\nb.ts', truncated: false, isError: false } }) });
    fold({ t: 'text.delta', delta: 'More thought', stream: 'reasoning' }, { audience: 'commentary' });
    fold({ t: 'plan.updated', steps: [{ text: 'look', status: 'completed' }, { text: 'fix', status: 'in_progress' }] });
    fold({ t: 'headline', text: 'Fixing' });
    fold({ t: 'text.delta', delta: 'Found 2 files.', stream: 'answer' }, { audience: 'answer' });

    const p = progressOf(v);
    expect(p).toMatchObject({ turnId: 't1', status: 'running', headline: 'Fixing', answer: 'Found 2 files.', answerFinal: false, startedAt: 500 });
    expect(p.plan).toHaveLength(2);
    expect(p.steps).toEqual([
      { kind: 'reasoning', id: 'r0', text: 'Let me think.', done: true },
      { kind: 'narration', id: 'n1', text: 'Checking files.' },
      { kind: 'tool', itemId: 'i1', type: 'command', title: 'ls src', status: 'completed', inputSummary: 'ls src', resultPreview: 'a.ts\nb.ts', isError: false },
      { kind: 'tool', itemId: 'i2', type: 'command', title: 'grep x', status: 'running', parentItemId: 'i1' },
      { kind: 'reasoning', id: 'r4', text: 'More thought', done: true },
    ]);
    // The flat view is unchanged: ends that ignore progress still see all answer text.
    expect(v.text).toBe('Checking files.Found 2 files.');

    fold({ t: 'text.snapshot', text: 'Found 2 files.', final: true }, { audience: 'answer' });
    fold({ t: 'turn.completed', turnId: 't1', status: 'completed' });
    expect(progressOf(v)).toMatchObject({ status: 'completed', answer: 'Found 2 files.', answerFinal: true });
    expect(progressOf(v).endedAt).toBeGreaterThan(500);
  });

  it('routes commentary-audience text to narration by item id, ignores subagent text, marks failures', () => {
    const v = newTurnView('t1');
    const fold = (b: Body, x: Partial<HarnessEvent> = {}) => foldTurn(v, ev(b, x));
    fold({ t: 'text.delta', delta: 'I will ', stream: 'answer' }, { audience: 'commentary', itemId: 'm1' });
    fold({ t: 'text.snapshot', text: 'I will run tests.', final: false }, { audience: 'commentary', itemId: 'm1' });
    expect(fold({ t: 'text.delta', delta: 'sub', stream: 'answer' }, { audience: 'answer', parentItemId: 'task1' })).toBe(false);
    expect(fold({ t: 'text.delta', delta: 'subthink', stream: 'reasoning' }, { parentItemId: 'task1' })).toBe(false);
    fold({ t: 'item.started', item: tool('c1', 'npm test') });
    fold({ t: 'item.completed', item: tool('c1', 'npm test', 'failed', { result: { preview: 'exit 1', truncated: false, isError: true } }) });
    fold({ t: 'item.completed', item: { itemId: 'rs', type: 'reasoning', title: 'Weighing options', status: 'completed' } });
    fold({ t: 'turn.completed', turnId: 't1', status: 'failed' });
    const p = progressOf(v);
    expect(v.text).toBe('');
    expect(p.status).toBe('failed');
    expect(p.steps).toEqual([
      { kind: 'narration', id: 'm1', text: 'I will run tests.' },
      { kind: 'tool', itemId: 'c1', type: 'command', title: 'npm test', status: 'failed', resultPreview: 'exit 1', isError: true },
      { kind: 'reasoning', id: 'rs', text: 'Weighing options', done: true },
    ]);
  });

  it('reports requires_action while a human request is open, and bounds steps and text', () => {
    const v = newTurnView('t1');
    foldTurn(
      v,
      ev({
        t: 'request.opened',
        requestId: 'r1',
        kind: 'tool_approval',
        title: 'rm',
        risk: {},
        allowedDecisions: ['allow_once', 'deny'],
        allowAlways: false,
        defaultDeny: true,
        resolver: { kind: 'human', principals: ['p'], routes: [] },
      }),
    );
    expect(progressOf(v).status).toBe('requires_action');
    for (let i = 0; i < 400; i++) foldTurn(v, ev({ t: 'item.started', item: tool(`i${i}`, `t${i}`) }));
    expect(v.steps).toHaveLength(300);
    expect((v.steps[0] as { itemId: string }).itemId).toBe('i100');
    foldTurn(v, ev({ t: 'text.delta', delta: 'x'.repeat(30_000), stream: 'reasoning' }));
    expect((v.steps.at(-1) as { text: string }).text.length).toBeLessThanOrEqual(20_000);
  });

  it('attaches progress on card/full tiers only, and a stop action when asked', () => {
    const v = newTurnView('t1');
    foldTurn(v, ev({ t: 'text.delta', delta: 'hi', stream: 'answer' }, { audience: 'answer' }));
    expect(renderTurn(v, 'card').progress).toMatchObject({ answer: 'hi' });
    expect(renderTurn(v, 'full').progress).toBeDefined();
    expect(renderTurn(v, 'headline').progress).toBeUndefined();
    expect(renderTurn(v, 'final').progress).toBeUndefined();
    expect(renderTurn(v, 'card').actions).toBeUndefined();
    const withStop = renderTurn(v, 'card', { interrupt: true });
    expect(withStop.actions).toEqual([{ id: 'turn:t1:interrupt', label: 'Stop', style: 'danger' }]);
    expect(renderTurn(v, 'card', { interrupt: true, caps: { buttons: false, text: { maxChars: 100, markdown: 'none' } } }).actions).toBeUndefined();
    v.status = 'completed';
    expect(renderTurn(v, 'card', { interrupt: true }).actions).toBeUndefined();
  });

  it('interrupt action ids round-trip', () => {
    expect(interruptActionId('t:1')).toBe('turn:t:1:interrupt');
    expect(parseInterruptActionId('turn:t:1:interrupt')).toEqual({ turnId: 't:1' });
    expect(parseInterruptActionId('turn::interrupt')).toBeUndefined();
    expect(parseInterruptActionId('req:r1:deny')).toBeUndefined();
  });
});

const SESSION = 'fake:default:c1';
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function world(script: FakeTurnScript, interruptButton = false) {
  const hub = new Hub(new MemorySessionLog());
  const policy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
  const lanes = new Map<string, Lane>();
  const harness = new FakeHarness(script);
  const ingress = new Ingress({
    policy,
    lanes: (sessionKey) => {
      let l = lanes.get(sessionKey);
      if (!l) lanes.set(sessionKey, (l = new Lane({ sessionKey, harness, hub, policy })));
      return l;
    },
  });
  const channel = new FakeChannel('fake', defaultChannelCaps);
  const outbox = new Outbox({ hub, sleep: async () => {} });
  const compositor = new Compositor({ hub, sessionKey: SESSION, adapter: channel, outbox, throttleMs: 5, interruptButton });
  compositor.start();
  const ac = new AbortController();
  void channel.start({ account: 'default', config: {}, signal: ac.signal, emit: ingress.emitter(), log: () => {} });
  cleanups.push(async () => {
    ac.abort();
    await compositor.stop();
    for (const l of lanes.values()) await l.close();
  });
  return { hub, channel, ingress, events: () => hub.log.read(SESSION, 0) };
}

const last = (rec: { msg: RenderedMessage; edits: RenderedMessage[] }) => rec.edits.at(-1) ?? rec.msg;

describe('compositor progress', () => {
  it('streams a cumulative ProgressView to the card and skips unchanged renders', async () => {
    const w = world(async (t) => {
      t.emit({ t: 'text.delta', delta: 'hmm', stream: 'reasoning' }, { audience: 'commentary', durability: 'ephemeral' });
      await new Promise((r) => setTimeout(r, 10));
      t.emit({ t: 'item.started', item: tool('i1', 'ls') });
      t.emit({ t: 'usage', usage: {} });
      await new Promise((r) => setTimeout(r, 10));
      t.emit({ t: 'item.completed', item: tool('i1', 'ls', 'completed', { result: { preview: 'ok', truncated: false, isError: false } }) });
      t.emit({ t: 'text.snapshot', text: 'Done.', final: true }, { audience: 'answer' });
    });
    await w.channel.inject({ sender: alice, text: 'go' });
    await until(() => w.channel.sent[0]?.finalized === true);
    const card = w.channel.sent[0]!;
    expect(card.msg.progress).toMatchObject({ status: 'running', steps: [], answer: '' });
    expect(card.edits.some((m) => m.progress?.steps.some((s) => s.kind === 'reasoning'))).toBe(true);
    const fin = last(card);
    expect(fin.progress).toMatchObject({ status: 'completed', answer: 'Done.', answerFinal: true });
    expect(fin.progress!.steps.map((s) => s.kind)).toEqual(['reasoning', 'tool']);
    expect(fin.progress!.startedAt).toBeTypeOf('number');
    expect(fin.progress!.endedAt).toBeTypeOf('number');
    const renders = [card.msg, ...card.edits].map((m) => JSON.stringify(m));
    expect(new Set(renders.slice(0, -1)).size).toBe(renders.length - 1); // no identical consecutive edits
  });

  it('a stop button click interrupts the running turn', async () => {
    const w = world(async (t) => {
      t.emit({ t: 'item.started', item: tool('i1', 'sleep 100') });
      await new Promise<void>((r) => t.signal.addEventListener('abort', () => r(), { once: true }));
    }, true);
    await w.channel.inject({ sender: alice, text: 'go' });
    await until(() => !!w.channel.sent[0] && !!last(w.channel.sent[0]).actions?.length);
    const card = w.channel.sent[0]!;
    const stop = last(card).actions!.find((a) => a.label === 'Stop')!;
    expect(parseInterruptActionId(stop.id)).toBeDefined();
    const click = (sender: typeof alice) =>
      w.channel.inject({ sender, content: [{ type: 'event', name: 'action', data: { actionId: stop.id, messageId: card.providerMessageId } }] });
    await click({ channelUserId: 'eve', evidence: 'platform_signed' }); // not allowed to control the session
    await new Promise((r) => setTimeout(r, 20));
    expect(card.finalized).toBe(false);
    await click(alice);
    await until(() => card.finalized);
    expect(last(card).progress?.status).toBe('interrupted');
    expect(last(card).actions).toBeUndefined();
    expect(bodies(w.events(), 'turn.completed')).toMatchObject([{ status: 'interrupted' }]);
  });
});
