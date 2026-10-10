import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemorySessionLog, SqliteSessionLog, type SessionLog } from '../src/index.js';
import { draft } from './helpers.js';


const run = { harness: 'fake', model: 'm', profile: 'bypass' };
const dir = mkdtempSync(join(tmpdir(), 'aio-session-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const impls: [string, () => SessionLog][] = [
  ['memory', () => new MemorySessionLog({ ephemeralRing: 3 })],
  ['sqlite', () => new SqliteSessionLog({ ephemeralRing: 3 })],
];

describe.each(impls)('%s log', (_name, make) => {
  it('assigns gapless per-session seq to durable events only #LN-1', () => {
    const log = make();
    const a1 = log.append('a', draft({ t: 'session.state', state: 'running' }));
    const d = log.append('a', draft({ t: 'text.delta', delta: 'x', stream: 'answer' }));
    const a2 = log.append('a', draft({ t: 'headline', text: 'h' }));
    const b1 = log.append('b', draft({ t: 'session.state', state: 'idle' }));
    const a3 = log.append('a', draft({ t: 'headline', text: 'eph' }, { durability: 'ephemeral' }));
    expect([a1.seq, a2.seq, b1.seq]).toEqual([1, 2, 1]);
    // Ephemeral events carry the seq they follow and are never persisted.
    expect(d).toMatchObject({ seq: 1, durability: 'ephemeral', v: 1, sessionKey: 'a' });
    expect(a3).toMatchObject({ seq: 2, durability: 'ephemeral' });
    expect(log.read('a', 0).map((e) => e.seq)).toEqual([1, 2]);
    expect(log.read('a', 1).map((e) => e.seq)).toEqual([2]);
    expect(log.head('a')).toBe(2);
    expect(log.ephemeral('a').map((e) => e.body.t)).toEqual(['text.delta', 'headline']);
  });

  it('forces deltas ephemeral and other kinds durable whatever they claim #LN-1', () => {
    const log = make();
    log.append('a', draft({ t: 'text.delta', delta: 'x', stream: 'answer' }, { durability: 'durable' }));
    log.append('a', draft({ t: 'turn.started', turnId: 't', inputIds: [], replyRoute: null, run }, { durability: 'ephemeral' }));
    expect(log.read('a', 0).map((e) => e.body.t)).toEqual(['turn.started']);
  });

  it('keeps a bounded ephemeral ring #LN-1', () => {
    const log = make();
    for (let i = 0; i < 5; i++) log.append('a', draft({ t: 'text.delta', delta: String(i), stream: 'answer' }));
    expect(log.ephemeral('a').map((e) => (e.body as { delta: string }).delta)).toEqual(['2', '3', '4']);
  });

  it('folds a snapshot for late joiners #LN-1', () => {
    const log = make();
    log.append('a', draft({ t: 'input.admitted', inputId: 'i1', disposition: 'new_turn' }));
    log.append('a', draft({ t: 'input.admitted', inputId: 'i2', disposition: 'queued' }));
    log.append('a', draft({ t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: null, run, owner: 'p' }, { harness: 'fake', generation: 1 }));
    log.append('a', draft({ t: 'text.delta', delta: 'Hel', stream: 'answer' }));
    log.append('a', draft({ t: 'text.delta', delta: 'lo', stream: 'answer' }));
    log.append('a', draft({ t: 'text.delta', delta: 'zzz', stream: 'reasoning' }));
    const item = { itemId: 'it1', type: 'command' as const, title: 'ls', status: 'running' as const };
    log.append('a', draft({ t: 'item.started', item }));
    log.append('a', draft({ t: 'item.started', item: { ...item, itemId: 'it2' } }));
    log.append('a', draft({ t: 'item.completed', item: { ...item, itemId: 'it2', status: 'completed' } }));
    log.append('a', draft({ t: 'plan.updated', steps: [{ text: 'a', status: 'in_progress' }] }));
    log.append('a', draft({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'rm', risk: {}, allowedDecisions: [], allowAlways: false, defaultDeny: true }));
    log.append('a', draft({ t: 'request.opened', requestId: 'r2', kind: 'question', title: 'q', risk: {}, allowedDecisions: [], allowAlways: false, defaultDeny: false }));
    log.append('a', draft({ t: 'request.resolved', requestId: 'r2', decision: null, by: 'timeout' }));
    const s = log.snapshot('a');
    expect(s).toMatchObject({
      seq: log.head('a'),
      harness: 'fake',
      generation: 1,
      state: 'running',
      turn: { turnId: 't1', owner: 'p', inputIds: ['i1'] },
      partialText: 'Hello',
      plan: [{ text: 'a', status: 'in_progress' }],
      queued: ['i2'],
    });
    expect(s.activeItems.map((i) => i.itemId)).toEqual(['it1']);
    expect(s.pendingRequests.map((r) => r.requestId)).toEqual(['r1']);

    log.append('a', draft({ t: 'turn.completed', turnId: 't1', status: 'completed' }));
    expect(log.snapshot('a')).toMatchObject({ state: 'idle', turn: null, activeItems: [], pendingRequests: [] });
  });
});

describe('memory log retention', () => {
  it('trims to `retain` and reports the floor #LN-1', () => {
    const log = new MemorySessionLog({ retain: 3 });
    for (let i = 0; i < 10; i++) log.append('a', draft({ t: 'headline', text: `h${i}` }));
    expect(log.floor('a')).toBe(7);
    expect(log.read('a', 0).map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(log.snapshot('a')).toMatchObject({ seq: 10, headline: 'h9' });
  });
});

describe('sqlite log persistence', () => {
  it('survives reopen: head, events and fold are restored #LN-1 #RS-1', () => {
    const path = join(dir, 'reopen.db');
    const a = new SqliteSessionLog({ path });
    a.append('s', draft({ t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: null, run }));
    a.append('s', draft({ t: 'text.delta', delta: 'lost', stream: 'answer' }));
    a.append('s', draft({ t: 'text.snapshot', text: 'kept', final: false }, { audience: 'answer' }));
    a.close();

    const b = new SqliteSessionLog({ path });
    expect(b.head('s')).toBe(2);
    expect(b.sessions()).toEqual(['s']);
    expect(b.snapshot('s')).toMatchObject({ turn: { turnId: 't1' }, partialText: 'kept' });
    expect(b.append('s', draft({ t: 'turn.completed', turnId: 't1', status: 'completed' })).seq).toBe(3);
    b.close();
  });

  it('a second writer of the same (session_key, seq) is refused by the primary key; the first event stays #LN-1', () => {
    const path = join(dir, 'two-writers.db');
    const a = new SqliteSessionLog({ path });
    const b = new SqliteSessionLog({ path });
    expect([a.head('s'), b.head('s')]).toEqual([0, 0]); // both believe seq 1 is next
    expect(a.append('s', draft({ t: 'headline', text: 'from a' })).seq).toBe(1);
    expect(() => b.append('s', draft({ t: 'headline', text: 'from b' }))).toThrow(/UNIQUE|PRIMARY KEY/i);
    expect(b.head('s')).toBe(0);
    const c = new SqliteSessionLog({ path });
    expect(c.read('s', 0).map((e) => [e.seq, (e.body as { text: string }).text])).toEqual([[1, 'from a']]);
    for (const l of [a, b, c]) l.close();
  });

  it('compacts old events into a stored snapshot #LN-1 #RS-1', () => {
    const path = join(dir, 'compact.db');
    const a = new SqliteSessionLog({ path });
    for (let i = 0; i < 6; i++) a.append('s', draft({ t: 'headline', text: `h${i}` }));
    a.append('s', draft({ t: 'plan.updated', steps: [{ text: 'x', status: 'pending' }] }));
    a.compact('s', 2);
    expect(a.floor('s')).toBe(5);
    expect(a.read('s', 0).map((e) => e.seq)).toEqual([6, 7]);
    a.close();
    const b = new SqliteSessionLog({ path });
    expect(b.floor('s')).toBe(5);
    expect(b.head('s')).toBe(7);
    expect(b.snapshot('s')).toMatchObject({ headline: 'h5', plan: [{ text: 'x' }] });
    b.close();
  });
});
