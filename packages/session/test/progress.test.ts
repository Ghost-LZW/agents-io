import { afterEach, describe, expect, it } from 'vitest';
import { foldTurn, newTurnView, parseInterruptActionId, progressOf } from '../src/index.js';
import { bodies, until } from './helpers.js';
import { alice, ev, last, tool, world } from './progress-helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('ProgressView folding', () => {
  it('reports requires_action while a human request is open, and bounds steps and text #OB-1', () => {
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
});

describe('compositor progress', () => {
  it('a stop button click interrupts the running turn #CT-1', async () => {
    const w = world(async (t) => {
      t.emit({ t: 'item.started', item: tool('i1', 'sleep 100') });
      await new Promise<void>((r) => t.signal.addEventListener('abort', () => r(), { once: true }));
    }, cleanups, true);
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
