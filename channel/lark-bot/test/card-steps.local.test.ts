import { describe, expect, it } from 'vitest';
import type { ProgressStep, ProgressView } from '@agents-io/protocol';
import { buildModel } from '../src/process-card.js';

/*
 * b0 (10-23 canary): a card opened at the first tool call shows the steps in the answer's place
 * until the answer starts, even with the thinking bubble on (folded, it showed only 任务进行中).
 */

const opts = { locale: 'zh' as const, look: 'chat' as const, processElsewhere: true, maxEntries: 8, panelMaxChars: 3000, answerBytes: 10_000, now: 2000 };
const tool = (i: number, status: 'running' | 'completed', title = `Bash: step ${i}`, parentItemId?: string): ProgressStep => ({
  kind: 'tool', itemId: `i${i}`, type: 'command', title, status, ...(parentItemId ? { parentItemId } : {}),
});
const view = (steps: ProgressStep[], answer = '', status: ProgressView['status'] = 'running'): ProgressView => ({
  turnId: 't1', status, steps, answer, answerFinal: status !== 'running', startedAt: 0,
});

describe('reply card before the answer (b0)', () => {
  it('lists the tool calls so far, one short line each, the latest last', () => {
    const p = view([tool(1, 'completed'), tool(2, 'running', `Bash: curl ${'x'.repeat(200)}`), tool(3, 'running', 'Read', 'i2')]);
    const m = buildModel({ text: '', progress: p }, p, opts);
    const lines = m.answer.split('\n');
    expect(lines).toHaveLength(2); // a subagent's call is not listed
    expect(lines[0]).toBe('✅ `Bash: step 1`');
    expect(lines[1]!.startsWith('⏳ `Bash: curl x')).toBe(true);
    expect(lines[1]!.length).toBeLessThanOrEqual(70);
  });

  it('keeps the last five; thinking alone says so; nothing yet is empty', () => {
    const many = view(Array.from({ length: 7 }, (_, i) => tool(i, 'completed')));
    expect(buildModel({ text: '', progress: many }, many, opts).answer.split('\n')).toEqual([
      '…', '✅ `Bash: step 2`', '✅ `Bash: step 3`', '✅ `Bash: step 4`', '✅ `Bash: step 5`', '✅ `Bash: step 6`',
    ]);
    const thinking = view([{ kind: 'reasoning', id: 'r0', text: 'Let me see', done: false }]);
    expect(buildModel({ text: '', progress: thinking }, thinking, opts).answer).toBe('_思考中…_');
    const none = view([]);
    expect(buildModel({ text: '', progress: none }, none, opts).answer).toBe('');
  });

  it('once the answer streams, the answer replaces the steps', () => {
    const p = view([tool(1, 'completed')], '找到了。');
    expect(buildModel({ text: '找到了。', progress: p }, p, opts).answer).toBe('找到了。');
    const done = view([tool(1, 'completed')], '好了', 'completed');
    expect(buildModel({ text: '好了', progress: done }, done, opts).answer).toBe('好了');
  });
});
