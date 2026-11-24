import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { Hub, MemorySessionLog, SqliteSessionLog, passes } from '../src/index.js';
import { draft } from './helpers.js';

describe('Hub', () => {
  it('knows which session a turn or request belongs to', () => {
    const hub = new Hub(new MemorySessionLog());
    hub.append('a', draft({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: null }));
    hub.append('b', draft({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'x', risk: {}, allowedDecisions: [], allowAlways: false, defaultDeny: true }));
    hub.append('c', draft({ t: 'turn.adopted', turnId: 't2', nativeTurnId: 'n', inputIds: [] }));
    expect(hub.locate({ turnId: 't1' })).toBe('a');
    expect(hub.locate({ requestId: 'r1' })).toBe('b');
    expect(hub.locate({ turnId: 't2' })).toBe('c');
    expect(hub.locate({ turnId: 'nope' })).toBeUndefined();
  });

  it('a batch on a log without transactions (in memory) just runs: each append is published at once, a throw undoes nothing', () => {
    const hub = new Hub(new MemorySessionLog());
    const probe = hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'full', bufferSize: 1 });
    expect(() =>
      hub.batch(() => {
        hub.append('s', draft({ t: 'headline', text: 'a' }));
        hub.append('s', draft({ t: 'headline', text: 'b' }));
        expect(probe.lagging).toBe(true);
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(hub.log.head('s')).toBe(2);
    expect(hub.batch(() => 42)).toBe(42);
  });

  it('onRollback undoes with the batch that rolls back (an outer one too, once a nested one committed into it), afterCommit waits for the outermost commit; outside a batch the one never runs, the other at once', () => {
    const log = new SqliteSessionLog();
    const hub = new Hub(log);
    const heard: string[] = [];
    const note = (s: string) => () => void heard.push(s);
    hub.onRollback(note('never'));
    hub.afterCommit(note('now'));
    expect(heard).toEqual(['now']);

    heard.length = 0;
    hub.batch(() => {
      hub.append('s', draft({ t: 'headline', text: 'kept' }));
      hub.append('s', draft({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: null }));
      hub.onRollback(note('undo kept'));
      // Runs once the events are published (and indexed), outside the transaction.
      hub.afterCommit(() => heard.push(`after: ${hub.locate({ turnId: 't1' })}, in a transaction ${log.db.isTransaction}`));
      // A nested batch rolls back alone: its undo runs, its afterCommit never.
      expect(() =>
        hub.batch(() => {
          hub.onRollback(note('undo inner 1'));
          hub.onRollback(note('undo inner 2'));
          hub.afterCommit(note('after inner'));
          throw new Error('inner');
        }),
      ).toThrow('inner');
      expect(heard).toEqual(['undo inner 2', 'undo inner 1']);
      hub.batch(() => hub.afterCommit(note('after nested kept')));
      expect(heard).toHaveLength(2);
    });
    expect(heard).toEqual(['undo inner 2', 'undo inner 1', 'after: s, in a transaction false', 'after nested kept']);

    heard.length = 0;
    expect(() =>
      hub.batch(() => {
        hub.onRollback(note('undo outer'));
        hub.batch(() => {
          hub.onRollback(note('undo nested'));
          hub.afterCommit(note('after nested'));
        });
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect(heard).toEqual(['undo nested', 'undo outer']);

    // A throwing afterCommit: the batch has committed, the others run, the error is the caller's.
    heard.length = 0;
    expect(() =>
      hub.batch(() => {
        hub.append('s', draft({ t: 'headline', text: 'also kept' }));
        hub.afterCommit(() => {
          throw new Error('after failed');
        });
        hub.afterCommit(note('after 2'));
      }),
    ).toThrow('after failed');
    expect(heard).toEqual(['after 2']);
    expect(log.read('s', 0).map((e) => (e.body.t === 'headline' ? e.body.text : e.body.t))).toEqual(['kept', 'turn.started', 'also kept']);

    // On a log without transactions a batch just runs: afterCommit at once, onRollback never.
    const mem = new Hub(new MemorySessionLog());
    heard.length = 0;
    expect(() =>
      mem.batch(() => {
        mem.onRollback(note('never'));
        mem.afterCommit(note('at once'));
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(heard).toEqual(['at once']);
    log.close();
  });

  it('keeps internal events out unless asked for', () => {
    const e = { ...draft({ t: 'headline', text: 'x' }), v: 1, sessionKey: 's', seq: 1, harness: 'h', generation: 1, visibility: 'internal' } as SessionEvent;
    expect(passes(e, 'full')).toBe(false);
    expect(passes(e, 'full', {}, ['internal'])).toBe(true);
  });
});
