import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SessionEvent } from '@agents-io/protocol';
import { BaseSessionLog, emptySnapshot, foldSnapshot, type LogOptions, type SessionSnapshot } from './log.js';

export interface SqliteLogOptions extends LogOptions {
  /** File path, or `:memory:` (default). */
  path?: string;
}

/**
 * Durable log on `node:sqlite` (built into Node 22.5+/24). Only durable events are
 * written; ephemeral ones stay in the in-memory ring. `compact()` folds old events
 * into a stored snapshot so readers behind the floor get a snapshot instead.
 */
export class SqliteSessionLog extends BaseSessionLog {
  readonly db: DatabaseSync;
  private q: {
    insert: StatementSync;
    range: StatementSync;
    upTo: StatementSync;
    snapGet: StatementSync;
    snapPut: StatementSync;
    del: StatementSync;
    sessions: StatementSync;
  };

  constructor(opts: SqliteLogOptions = {}) {
    super(opts);
    this.db = new DatabaseSync(opts.path ?? ':memory:');
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        session_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (session_key, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS snapshots (
        session_key TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL
      );
    `);
    this.q = {
      insert: this.db.prepare('INSERT INTO events (session_key, seq, json) VALUES (?, ?, ?)'),
      range: this.db.prepare('SELECT json FROM events WHERE session_key = ? AND seq > ? ORDER BY seq LIMIT ?'),
      upTo: this.db.prepare('SELECT json FROM events WHERE session_key = ? AND seq > ? AND seq <= ? ORDER BY seq'),
      snapGet: this.db.prepare('SELECT seq, json FROM snapshots WHERE session_key = ?'),
      snapPut: this.db.prepare(
        'INSERT INTO snapshots (session_key, seq, json) VALUES (?, ?, ?) ON CONFLICT(session_key) DO UPDATE SET seq = excluded.seq, json = excluded.json',
      ),
      del: this.db.prepare('DELETE FROM events WHERE session_key = ? AND seq <= ?'),
      sessions: this.db.prepare('SELECT session_key FROM events UNION SELECT session_key FROM snapshots'),
    };
  }

  protected persist(e: SessionEvent): void {
    // The primary key makes a duplicate seq (two writers) fail loudly instead of forking the log.
    this.q.insert.run(e.sessionKey, e.seq, JSON.stringify(e));
  }

  protected load(sessionKey: string, fromSeq: number, limit: number): SessionEvent[] {
    const rows = this.q.range.all(sessionKey, fromSeq, Math.min(limit, 2 ** 31 - 1)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as SessionEvent);
  }

  private storedSnapshot(sessionKey: string): SessionSnapshot | undefined {
    const row = this.q.snapGet.get(sessionKey) as { seq: number; json: string } | undefined;
    return row ? (JSON.parse(row.json) as SessionSnapshot) : undefined;
  }

  protected restore(sessionKey: string) {
    const fold = this.storedSnapshot(sessionKey) ?? emptySnapshot(sessionKey);
    for (const e of this.load(sessionKey, fold.seq, Number.MAX_SAFE_INTEGER)) foldSnapshot(fold, e);
    return { head: fold.seq, fold };
  }

  floor(sessionKey: string): number {
    return this.storedSnapshot(sessionKey)?.seq ?? 0;
  }

  /** Fold and delete all but the newest `keep` durable events of a session. */
  compact(sessionKey: string, keep = 0): void {
    const cut = this.head(sessionKey) - keep;
    const from = this.floor(sessionKey);
    if (cut <= from) return;
    const fold = this.storedSnapshot(sessionKey) ?? emptySnapshot(sessionKey);
    // Only stored (durable) events are folded here, so ephemeral deltas never leak into it.
    for (const r of this.q.upTo.all(sessionKey, from, cut) as { json: string }[]) foldSnapshot(fold, JSON.parse(r.json) as SessionEvent);
    this.db.exec('BEGIN');
    try {
      this.q.snapPut.run(sessionKey, cut, JSON.stringify(fold));
      this.q.del.run(sessionKey, cut);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  sessions(): string[] {
    return (this.q.sessions.all() as { session_key: string }[]).map((r) => r.session_key);
  }

  close(): void {
    this.db.close();
  }
}
