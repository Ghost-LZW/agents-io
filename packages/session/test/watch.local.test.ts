import { describe, expect, it } from 'vitest';
import { fakeEnvelope } from '@agents-io/testkit';
import { OWNER, draft, eve, group, world } from './watch-helpers.js';

describe('digest watches', () => {
  it('flushes as soon as maxItems is reached', async () => {
    const w = world();
    await w.watches.add(OWNER, draft({ mode: 'digest', digest: { everyMs: 3_600_000, maxItems: 2 } }));
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'a' }));
    expect(w.turns.length).toBe(0);
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'b' }));
    await w.idle();
    expect(w.turns.length).toBe(1);
    expect((w.turns[0]![0]!.content[0] as { text: string }).text).toMatch(/2 new items/);
    await w.close();
  });
});

describe('who may watch', () => {
  it('validates watches', async () => {
    const w = world();
    expect(await w.watches.add(OWNER, draft({ mode: 'digest' }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await w.watches.add(OWNER, { ...draft(), mode: 'loud' } as never)).toMatchObject({ ok: false, code: 'invalid' });
    const r = await w.watches.add(OWNER, { ...draft(), id: undefined } as never);
    expect(r).toMatchObject({ ok: true });
    await w.close();
  });
});
