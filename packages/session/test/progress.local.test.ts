import { afterEach, describe, expect, it } from 'vitest';
import type { Body, HarnessEvent } from '@agents-io/protocol';
import { foldTurn, interruptActionId, newTurnView, parseInterruptActionId, progressOf, renderTurn } from '../src/index.js';
import { until } from './helpers.js';
import { alice, ev, last, tool, world } from './progress-helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
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
    }, cleanups);
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
});
