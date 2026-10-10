import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { Hub, MemorySessionLog, isSnapshotEvent } from '../src/index.js';
import { draft, take } from './helpers.js';

const seqs = (evs: SessionEvent[]) => evs.filter((e) => e.durability === 'durable').map((e) => e.seq);

function seeded(n: number, opts: { retain?: number } = {}) {
  const hub = new Hub(new MemorySessionLog(opts));
  for (let i = 0; i < n; i++) hub.append('s', draft({ t: 'headline', text: `h${i}` }));
  return hub;
}

describe('Hub', () => {
  it('resumes from a seq: replay then live, no gaps #LN-1', async () => {
    const hub = seeded(5);
    const sub = hub.subscribe({ sessionKey: 's', fromSeq: 3, tier: 'full' });
    hub.append('s', draft({ t: 'headline', text: 'live' }));
    const evs = await take(sub, 3);
    expect(seqs(evs)).toEqual([4, 5, 6]);
    sub.close();
  });

  it('sends a snapshot first to a late joiner #LN-1', async () => {
    const hub = seeded(2);
    hub.append('s', draft({ t: 'text.delta', delta: 'partial', stream: 'answer' }));
    const sub = hub.subscribe({ sessionKey: 's', tier: 'card' });
    hub.append('s', draft({ t: 'headline', text: 'after' }));
    const [snap, next] = await take(sub, 2);
    expect(snap && isSnapshotEvent(snap)).toBe(true);
    expect((snap as SessionEvent & { native: { seq: number; partialText: string } }).native).toMatchObject({ seq: 2, partialText: 'partial' });
    expect(next).toMatchObject({ seq: 3, body: { t: 'headline', text: 'after' } });
    sub.close();
  });

  it('sends a snapshot when fromSeq is behind what the log retains #LN-1', async () => {
    const hub = seeded(10, { retain: 3 });
    const sub = hub.subscribe({ sessionKey: 's', fromSeq: 2, tier: 'full' });
    const [snap] = await take(sub, 1);
    expect(isSnapshotEvent(snap!)).toBe(true);
    expect(snap!.seq).toBe(10);
    // Everything retained is already folded into the snapshot; live continues after it.
    hub.append('s', draft({ t: 'headline', text: 'x' }));
    expect((await take(sub, 1))[0]).toMatchObject({ seq: 11 });
    sub.close();
  });

  it('gives two subscribers the same durable sequence #LN-1', async () => {
    const hub = seeded(3);
    const a = hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'full' });
    const b = hub.subscribe({ sessionKey: 's', fromSeq: 1, tier: 'full' });
    for (let i = 0; i < 4; i++) {
      hub.append('s', draft({ t: 'text.delta', delta: 'd', stream: 'answer' }));
      hub.append('s', draft({ t: 'headline', text: `live${i}` }));
    }
    const ea = (await take(a, 3 + 8)).filter((e) => e.durability === 'durable');
    const eb = (await take(b, 2 + 8)).filter((e) => e.durability === 'durable');
    expect(seqs(ea)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(seqs(eb)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(eb).toEqual(ea.slice(1));
  });

  it('drops only ephemeral events for a slow subscriber, then catches up from the log #LN-1', async () => {
    const hub = new Hub(new MemorySessionLog());
    const slow = hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'full', bufferSize: 4 });
    const fast = hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'full' });
    for (let i = 0; i < 20; i++) {
      hub.append('s', draft({ t: 'text.delta', delta: String(i), stream: 'answer' }));
      if (i % 2) hub.append('s', draft({ t: 'headline', text: `d${i}` }));
    }
    expect(slow.lagging).toBe(true);
    expect(slow.dropped).toBeGreaterThan(0);
    const all: SessionEvent[] = [];
    while (seqs(all).length < 10) all.push(...(await take(slow, 1)));
    expect(seqs(all)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(slow.lagging).toBe(false);
    // The fast subscriber lost nothing.
    const f = await take(fast, 30);
    expect(f.filter((e) => e.durability === 'ephemeral')).toHaveLength(20);
    // After catching up, live delivery resumes, ephemeral included.
    hub.append('s', draft({ t: 'text.delta', delta: 'again', stream: 'answer' }));
    expect((await take(slow, 1))[0]).toMatchObject({ durability: 'ephemeral', body: { delta: 'again' } });
  });

  it('filters by tier and never filters out human approvals #RQ-5', async () => {
    const hub = new Hub(new MemorySessionLog());
    const subs = {
      full: hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'full' }),
      card: hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'card' }),
      headline: hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'headline' }),
      final: hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'final', filter: { optOut: ['request.opened'], minLevel: 'primary' } }),
    };
    const item = { itemId: 'i', type: 'command' as const, title: 'ls', status: 'completed' as const, inputSummary: 'ls -la', result: { preview: 'x', truncated: false, isError: false } };
    hub.append('s', draft({ t: 'text.delta', delta: 'he', stream: 'answer' }));
    hub.append('s', draft({ t: 'item.completed', item }, { native: { raw: true } }));
    hub.append('s', draft({ t: 'native', name: 'x' }, { visibility: 'operators' }));
    hub.append('s', draft({ t: 'headline', text: 'running ls' }));
    hub.append('s', draft({ t: 'request.opened', requestId: 'auto', kind: 'tool_approval', title: 'a', risk: {}, allowedDecisions: [], allowAlways: false, defaultDeny: false, resolver: { kind: 'auto', decision: { kind: 'allow_once' } } }));
    hub.append('s', draft({ t: 'request.opened', requestId: 'h', kind: 'tool_approval', title: 'rm', risk: {}, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true, resolver: { kind: 'human', principals: ['p'], routes: [] } }, { audience: 'approval' }));
    hub.append('s', draft({ t: 'request.resolved', requestId: 'h', decision: { kind: 'deny' }, by: 'timeout' }, { audience: 'approval', level: 'detail' }));
    hub.append('s', draft({ t: 'text.snapshot', text: 'hello', final: true }, { audience: 'answer' }));
    const n = 8;
    hub.append('s', draft({ t: 'session.state', state: 'idle' }));
    const kinds = async (tier: keyof typeof subs, count: number) => (await take(subs[tier], count)).map((e) => e.body.t);

    expect(await kinds('full', n + 1)).toEqual(['text.delta', 'item.completed', 'native', 'headline', 'request.opened', 'request.opened', 'request.resolved', 'text.snapshot', 'session.state']);
    const card = await take(subs.card, 5);
    expect(card.map((e) => e.body.t)).toEqual(['item.completed', 'headline', 'request.opened', 'request.resolved', 'text.snapshot']);
    expect(card[0]!.native).toBeUndefined();
    expect(card[0]!.body).toEqual({ t: 'item.completed', item: { itemId: 'i', type: 'command', title: 'ls', status: 'completed' } });
    expect(await kinds('headline', 4)).toEqual(['headline', 'request.opened', 'request.resolved', 'session.state']);
    // optOut and minLevel never remove a human approval.
    expect(await kinds('final', 3)).toEqual(['request.opened', 'request.resolved', 'text.snapshot']);
  });

  it('a lagging subscription yields nothing more once closed #LN-1', async () => {
    const hub = new Hub(new MemorySessionLog());
    const ac = new AbortController();
    const sub = hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'full', bufferSize: 2, signal: ac.signal });
    for (let i = 0; i < 10; i++) hub.append('s', draft({ t: 'headline', text: `h${i}` }));
    expect(sub.lagging).toBe(true);
    ac.abort();
    const got: SessionEvent[] = [];
    for await (const e of sub) got.push(e);
    expect(got).toEqual([]);
  });

  it("a late joiner's snapshot holds only what its visibility and tier would show live #LN-1", async () => {
    const hub = new Hub(new MemorySessionLog());
    const item = (itemId: string) => ({ itemId, type: 'command' as const, title: 't', status: 'running' as const, inputSummary: `SECRET ${itemId}` });
    hub.append('s', draft({ t: 'item.started', item: item('dbg') }, { level: 'debug', visibility: 'operators' }));
    hub.append('s', draft({ t: 'item.started', item: item('int') }, { audience: 'internal', visibility: 'internal' }));
    hub.append('s', draft({ t: 'item.started', item: item('ok') }));
    type Snap = SessionEvent & { native: { activeItems: { itemId: string; inputSummary?: string }[] } };
    const first = async (tier: 'full' | 'card') => ((await take(hub.subscribe({ sessionKey: 's', tier }), 1))[0] as Snap).native.activeItems;
    expect(await first('card')).toEqual([{ itemId: 'ok', type: 'command', title: 't', status: 'running' }]);
    expect((await first('full')).map((i) => i.itemId)).toEqual(['ok']);
    expect((await first('full'))[0]!.inputSummary).toBe('SECRET ok');
  });
});
