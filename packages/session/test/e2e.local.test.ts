import { describe, expect, it } from 'vitest';
import { newTurnView, renderTurn } from '../src/index.js';

describe('renderTurn', () => {
  it('renders headline and final tiers', () => {
    const v = newTurnView('t');
    v.currentTool = 'edit src/foo.ts';
    expect(renderTurn(v, 'headline')).toEqual({ text: '▶ edit src/foo.ts', spokenText: '▶ edit src/foo.ts' });
    v.text = 'partial';
    expect(renderTurn(v, 'final')).toEqual({ text: 'partial' });
    expect(renderTurn({ ...v, text: 'x'.repeat(50) }, 'card', { caps: { buttons: true, text: { maxChars: 10, markdown: 'none' } } }).text).toHaveLength(10);
  });
});
