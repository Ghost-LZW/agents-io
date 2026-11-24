import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Attention, SessionEvent, errors, type Body } from '@agents-io/protocol';
import { Hub, MemorySessionLog, SqliteSessionLog, emptyAttention, foldAttention, type EventDraft, type SessionLog } from '../src/index.js';
import { draft } from './helpers.js';

/*
 * The attention fold (core-slimming G7, INVARIANTS LN-11), pinned by language-neutral fixtures:
 * `fixtures/attention/*.json`, each `{ description, input, expected }` (format: docs/design/core-slimming
 * §3 G7/G8). `input` is a session's log as SessionEvent bodies with `ts` (and, where they matter,
 * `visibility`, `durability`, `audience`, `level`, `turnId`, `itemId`); the log stamps the rest, `seq`
 * included; `expected` is the attention after the last of them.
 */

interface FixtureEvent {
  ts: number;
  body: Body;
  visibility?: SessionEvent['visibility'];
  durability?: SessionEvent['durability'];
  audience?: SessionEvent['audience'];
  level?: SessionEvent['level'];
  turnId?: string;
  itemId?: string;
}
interface Fixture {
  description: string;
  input: FixtureEvent[];
  expected: Attention;
}

const DIR = join(import.meta.dirname, 'fixtures', 'attention');
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const load = (file: string) => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Fixture;
const KEY = 's';
const ENTRY_KEYS = new Set(['ts', 'body', 'visibility', 'durability', 'audience', 'level', 'turnId', 'itemId']);

const tmp = mkdtempSync(join(tmpdir(), 'aio-attention-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A fixture entry as the log gets it: `level` primary, `audience` status, `durability` durable unless it says otherwise. */
function draftOf(e: FixtureEvent): EventDraft {
  return {
    ts: e.ts,
    level: e.level ?? 'primary',
    audience: e.audience ?? 'status',
    durability: e.durability ?? 'durable',
    ...(e.visibility !== undefined ? { visibility: e.visibility } : {}),
    ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
    ...(e.itemId !== undefined ? { itemId: e.itemId } : {}),
    body: e.body,
  };
}

const appendAll = (log: SessionLog, f: Fixture) => f.input.map((e) => log.append(KEY, draftOf(e)));

describe('attention fixtures', () => {
  it('every fixture is a description, a log of valid session events and a valid attention, nothing else #LN-11', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
    for (const file of FIXTURES) {
      const f = load(file);
      expect(Object.keys(f).sort(), file).toEqual(['description', 'expected', 'input']);
      expect(f.description.length, file).toBeGreaterThan(10);
      for (const e of f.input) expect(Object.keys(e).filter((k) => !ENTRY_KEYS.has(k)), file).toEqual([]);
      for (const e of appendAll(new MemorySessionLog(), f)) expect(errors(SessionEvent, e), `${file} seq ${e.seq}`).toEqual([]);
      expect(errors(Attention, f.expected), file).toEqual([]);
    }
  });

  it.each(FIXTURES)('%s: folded from its events, through a log, and from a SQLite log reopened and compacted, the attention is the expected one #LN-11', (file) => {
    const f = load(file);
    // The fold alone, over the events as the log stamps them.
    const events = appendAll(new MemorySessionLog(), f);
    expect(events.reduce(foldAttention, emptyAttention())).toStrictEqual(f.expected);
    // The log's own (its snapshot, and the accessor without the rest).
    const mem = new MemorySessionLog();
    appendAll(mem, f);
    expect(mem.snapshot(KEY).attention).toStrictEqual(f.expected);
    expect(mem.attention(KEY)).toStrictEqual(f.expected);
    // A SQLite log: reopened (restored from its events), then compacted further and further into its stored snapshot.
    const path = join(tmp, `${file}.db`);
    const db = new SqliteSessionLog({ path });
    appendAll(db, f);
    const head = db.head(KEY);
    db.close();
    for (let keep = head; keep >= 0; keep--) {
      const w = new SqliteSessionLog({ path });
      w.compact(KEY, keep);
      w.close();
      const r = new SqliteSessionLog({ path });
      expect(r.snapshot(KEY).attention, `${file}, compacted keeping ${keep}`).toStrictEqual(f.expected);
      r.close();
    }
  });

  it('a snapshot stored before snapshots had an attention gives one from what it shows: its human requests, queued inputs and turn, with since unknown #LN-11', () => {
    const path = join(tmp, 'legacy.db');
    const a = new SqliteSessionLog({ path });
    const human = { kind: 'human' as const, principals: ['owner'], routes: [] };
    const req = (requestId: string, resolver?: { kind: 'human'; principals: string[]; routes: string[] } | { kind: 'host' }) => ({
      t: 'request.opened' as const, requestId, kind: 'tool_approval' as const, title: `ask ${requestId}`, risk: {}, allowedDecisions: [], allowAlways: false, defaultDeny: true, ...(resolver ? { resolver } : {}),
    });
    a.append(KEY, draft({ t: 'input.admitted', inputId: 'i1', disposition: 'new_turn' }));
    a.append(KEY, draft({ t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: null }));
    a.append(KEY, draft({ t: 'input.admitted', inputId: 'i2', disposition: 'queued' }));
    a.append(KEY, draft(req('r1', human)));
    a.append(KEY, draft(req('r2', { kind: 'host' })));
    a.compact(KEY, 0);
    // What an older version stored: the same snapshot without `attention`.
    const row = a.db.prepare('SELECT json FROM snapshots WHERE session_key = ?').get(KEY) as { json: string };
    const { attention: _a, ...old } = JSON.parse(row.json) as Record<string, unknown>;
    a.db.prepare('UPDATE snapshots SET json = ? WHERE session_key = ?').run(JSON.stringify(old), KEY);
    a.close();
    const b = new SqliteSessionLog({ path });
    expect(b.snapshot(KEY).attention).toStrictEqual({
      state: 'needs_you',
      reasons: [
        { kind: 'request', requestId: 'r1', requestKind: 'tool_approval', title: 'ask r1', since: 0 },
        { kind: 'queued', inputIds: ['i2'], since: 0 },
      ],
      since: 0,
      seq: 5,
      turnId: 't1',
    });
    // Events after it fold on from there.
    b.append(KEY, { ...draft({ t: 'request.resolved', requestId: 'r1', decision: null, by: 'timeout' }), ts: 7000 });
    expect(b.attention(KEY)).toMatchObject({ state: 'working', since: 7000, seq: 6, reasons: [{ kind: 'queued', inputIds: ['i2'] }] });
    b.close();
  });
});

describe('Hub.onAttention', () => {
  const human = { kind: 'human' as const, principals: ['owner'], routes: [] };
  const opened = { t: 'request.opened' as const, requestId: 'r1', kind: 'question' as const, title: 'Which?', risk: {}, allowedDecisions: [], allowAlways: false, defaultDeny: false, resolver: human };

  it('tells each change once, after its batch commits, with the value after the batch, in seq order; nothing for events that change nothing or a batch rolled back #LN-11', () => {
    const hub = new Hub(new SqliteSessionLog());
    const told: [string, Attention][] = [];
    const off = hub.onAttention((key, a) => told.push([key, a]));
    const seqs = () => told.map(([k, a]) => `${k}:${a.state}@${a.seq}`);
    hub.append('a', draft({ t: 'input.admitted', inputId: 'i1', disposition: 'new_turn' }));
    hub.append('a', draft({ t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: null }));
    hub.append('a', draft({ t: 'session.state', state: 'running' }));
    hub.append('a', draft({ t: 'text.delta', delta: 'x', stream: 'answer' }));
    expect(seqs()).toEqual(['a:working@1', 'a:working@2']);
    hub.batch(() => {
      hub.append('a', draft(opened, { audience: 'approval' }));
      hub.append('a', draft({ t: 'session.state', state: 'requires_action' }));
      expect(seqs()).toHaveLength(2); // not before the commit
    });
    expect(seqs()).toEqual(['a:working@1', 'a:working@2', 'a:needs_you@4']);
    expect(() =>
      hub.batch(() => {
        hub.append('a', draft({ t: 'request.resolved', requestId: 'r1', decision: null, by: 'timeout' }));
        throw new Error('rolled back');
      }),
    ).toThrow('rolled back');
    expect(seqs()).toHaveLength(3);
    expect(hub.attention('a')).toMatchObject({ state: 'needs_you', seq: 4 });
    // Two changes in one batch: told once, the value after both.
    hub.batch(() => {
      hub.append('a', draft({ t: 'request.resolved', requestId: 'r1', decision: null, by: 'timeout' }));
      hub.append('a', draft({ t: 'turn.completed', turnId: 't1', status: 'completed' }));
    });
    hub.append('b', draft({ t: 'input.admitted', inputId: 'j1', disposition: 'queued' }));
    expect(seqs()).toEqual(['a:working@1', 'a:working@2', 'a:needs_you@4', 'a:idle@7', 'b:working@1']);
    expect(told[3]![1]).toStrictEqual({ state: 'idle', reasons: [], since: 1, seq: 7 });
    off();
    hub.append('b', draft({ t: 'input.cancelled', inputIds: ['j1'], reason: 'x' }));
    expect(told).toHaveLength(5);
  });

  it('on a log without transactions each change is told as it is appended #LN-11', () => {
    const hub = new Hub(new MemorySessionLog());
    const told: number[] = [];
    hub.onAttention((_k, a) => told.push(a.seq));
    hub.batch(() => {
      hub.append('a', draft({ t: 'input.admitted', inputId: 'i1', disposition: 'new_turn' }));
      hub.append('a', draft({ t: 'session.state', state: 'running' }));
      hub.append('a', draft({ t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: null }));
    });
    expect(told).toEqual([1, 3]);
  });
});
