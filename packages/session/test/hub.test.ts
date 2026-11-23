import { afterAll, describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub, MemorySessionLog, SqliteSessionLog, isSnapshotEvent, type SessionLog } from '../src/index.js';
import { draft, take } from './helpers.js';

const seqs = (evs: SessionEvent[]) => evs.filter((e) => e.durability === 'durable').map((e) => e.seq);
const logs: [string, () => SessionLog][] = [
  ['memory', () => new MemorySessionLog()],
  ['sqlite', () => new SqliteSessionLog()],
];
const dir = mkdtempSync(join(tmpdir(), 'aio-hub-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

  it('drops only ephemeral events for a slow subscriber, then catches up from the log #LN-1 #LN-10', async () => {
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

  it.each(logs)('a slow subscriber (%s log) is never cut off: it misses exactly the ephemeral events it counts as dropped, and gets every durable one once, in seq order #LN-10', async (_name, make) => {
    const hub = new Hub(make());
    const slow = hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'full', bufferSize: 3 });
    for (let i = 1; i <= 15; i++) {
      hub.append('s', draft({ t: 'text.delta', delta: `d${i}`, stream: 'answer' }));
      hub.append('s', draft({ t: 'headline', text: `h${i}` }));
    }
    expect(slow.lagging).toBe(true);
    expect(hub.subscriberCount('s')).toBe(1);
    const got: SessionEvent[] = [];
    while (seqs(got).length < 15) got.push(...(await take(slow, 1)));
    expect(seqs(got)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(got.filter((e) => e.durability === 'durable').map((e) => e.body)).toEqual(Array.from({ length: 15 }, (_, i) => ({ t: 'headline', text: `h${i + 1}` })));
    expect(slow.lagging).toBe(false);
    // Every ephemeral event either arrived or was counted.
    expect(got.filter((e) => e.durability === 'ephemeral').length + slow.dropped).toBe(15);
    expect(slow.dropped).toBeGreaterThan(0);
    // Caught up: live again, ephemeral included.
    hub.append('s', draft({ t: 'text.delta', delta: 'live', stream: 'answer' }));
    hub.append('s', draft({ t: 'headline', text: 'h16' }));
    expect(await take(slow, 2)).toMatchObject([{ durability: 'ephemeral', body: { delta: 'live' } }, { seq: 16, body: { text: 'h16' } }]);
    slow.close();
  });

  it('a cursor ahead of the head (the log was rebuilt or replaced) gets a snapshot first, then continues from the head #LN-10 #LN-1', async () => {
    // The client read up to seq 5 of a log that is gone; this one has two events.
    const hub = seeded(2);
    const sub = hub.subscribe({ sessionKey: 's', fromSeq: 5, tier: 'full' });
    const [snap] = await take(sub, 1);
    expect(isSnapshotEvent(snap!)).toBe(true);
    expect(snap!.seq).toBe(2);
    expect((snap as SessionEvent & { native: { headline: string } }).native.headline).toBe('h1');
    hub.append('s', draft({ t: 'headline', text: 'next' }));
    expect(await take(sub, 1)).toMatchObject([{ seq: 3, body: { text: 'next' } }]);
    // A cursor at the head is not ahead: no snapshot, live from there.
    const at = hub.subscribe({ sessionKey: 's', fromSeq: 3, tier: 'full' });
    hub.append('s', draft({ t: 'headline', text: 'four' }));
    expect(await take(at, 1)).toMatchObject([{ seq: 4, body: { text: 'four' } }]);
    sub.close();
    at.close();
  });

  it('a batch commits its appends together and publishes them after the commit, in seq order; a throw rolls back the store and the memory view, and nobody sees them #LN-1 #DL-1', async () => {
    const path = join(dir, 'batch.sqlite');
    const log = new SqliteSessionLog({ path });
    const hub = new Hub(log);
    hub.append('s', draft({ t: 'session.state', state: 'idle' }));
    const sub = hub.subscribe({ sessionKey: 's', fromSeq: 1, tier: 'full' });
    // A subscriber with room for one event: it starts lagging at the second one it is offered.
    const probe = hub.subscribe({ sessionKey: 's', fromSeq: 1, tier: 'full', bufferSize: 1 });
    const first = take(sub, 2);
    hub.batch(() => {
      hub.append('s', draft({ t: 'headline', text: 'a' }));
      hub.append('s', draft({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: null }));
      // Nothing is published (or indexed) while the transaction is open.
      expect(log.db.isTransaction).toBe(true);
      expect(probe.lagging).toBe(false);
      expect(hub.locate({ turnId: 't1' })).toBeUndefined();
    });
    expect(log.db.isTransaction).toBe(false);
    expect(probe.lagging).toBe(true);
    expect(hub.locate({ turnId: 't1' })).toBe('s');
    expect(await first).toMatchObject([{ seq: 2, body: { text: 'a' } }, { seq: 3, body: { t: 'turn.started' } }]);
    probe.close();

    // A throw: rolled back in the database and in memory (head, fold, ephemeral ring); the error is the caller's.
    expect(() =>
      hub.batch(() => {
        hub.append('s', draft({ t: 'turn.completed', turnId: 't1', status: 'completed' }));
        hub.append('s', draft({ t: 'text.delta', delta: 'gone', stream: 'answer' }));
        hub.append('t', draft({ t: 'turn.started', turnId: 't2', inputIds: [], replyRoute: null }));
        throw new Error('refused');
      }),
    ).toThrow('refused');
    expect(log.head('s')).toBe(3);
    expect(log.snapshot('s')).toMatchObject({ seq: 3, state: 'running', turn: { turnId: 't1' }, partialText: '', headline: null });
    expect(log.ephemeral('s')).toEqual([]);
    expect(log.head('t')).toBe(0);
    expect(hub.locate({ turnId: 't2' })).toBeUndefined();
    expect(log.read('s', 0).map((e) => e.seq)).toEqual([1, 2, 3]);

    // A batch inside a batch is a savepoint: its rollback keeps what the outer one wrote, gapless.
    hub.batch(() => {
      hub.append('s', draft({ t: 'headline', text: 'outer' }));
      expect(() =>
        hub.batch(() => {
          hub.append('s', draft({ t: 'headline', text: 'inner' }));
          throw new Error('inner refused');
        }),
      ).toThrow('inner refused');
      hub.batch(() => hub.append('s', draft({ t: 'headline', text: 'inner kept' })));
    });
    // The subscriber never saw the rolled-back events: the next ones it gets continue the seq.
    expect(await take(sub, 2)).toMatchObject([
      { seq: 4, body: { text: 'outer' } },
      { seq: 5, body: { text: 'inner kept' } },
    ]);
    const view = log.snapshot('s');
    log.close();
    // The database agrees with the memory view.
    const again = new SqliteSessionLog({ path });
    expect(again.read('s', 0).map((e) => (e.body.t === 'headline' ? e.body.text : e.body.t))).toEqual(['session.state', 'a', 'turn.started', 'outer', 'inner kept']);
    expect(again.snapshot('s')).toEqual(view);
    expect(again.head('t')).toBe(0);
    again.close();
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
