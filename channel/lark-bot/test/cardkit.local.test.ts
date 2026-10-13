import { describe, expect, it } from 'vitest';
import { CardKitCard } from '../src/cardkit.js';
import { FakeLark } from './fake-lark.js';

describe('CardKit per-card mutations', () => {
  it('serializes concurrent calls and leaves 120ms between requests', async () => {
    const lark = new FakeLark();
    let now = 0;
    const waits: number[] = [];
    const card = await CardKitCard.create(
      lark.cardkitApi,
      { schema: '2.0', config: {}, body: { elements: [{ tag: 'markdown', element_id: 'answer', content: '' }] } },
      { timeoutMs: 1000, now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } },
    );
    await Promise.all([
      card.content('answer', 'a'),
      card.updateElement('answer', { tag: 'markdown', element_id: 'answer', content: 'b' }),
      card.settings({ config: { streaming_mode: false } }),
    ]);
    expect(waits).toEqual([120, 120, 120]);
    expect(lark.cards.get(card.cardId)!.ops.map((o) => o.sequence)).toEqual([2, 3, 4]);
  });
});
