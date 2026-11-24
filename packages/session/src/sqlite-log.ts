import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SessionEvent } from '@agents-io/protocol';
import { attentionFromSnapshot } from './attention.js';
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
  /** Depth of `transaction` calls in progress (names their savepoints). */
  private savepoints = 0;

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
    // Inside a batch whose transaction has ended (a failed statement can end all of it: SQLITE_FULL,
    // IOERR, a nested batch's), a write would autocommit on its own, ahead of what the batch rolls back.
    if (this.savepoints > 0 && !this.db.isTransaction) throw new Error('session log: the transaction this append belongs to has ended (an earlier statement failed); nothing more is written in it');
    // The primary key makes a duplicate seq (two writers) fail loudly instead of forking the log.
    this.q.insert.run(e.sessionKey, e.seq, JSON.stringify(e));
  }

  protected load(sessionKey: string, fromSeq: number, limit: number): SessionEvent[] {
    const rows = this.q.range.all(sessionKey, fromSeq, Math.min(limit, 2 ** 31 - 1)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as SessionEvent);
  }

  private storedSnapshot(sessionKey: string): SessionSnapshot | undefined {
    const row = this.q.snapGet.get(sessionKey) as { seq: number; json: string } | undefined;
    if (!row) return undefined;
    const snap = JSON.parse(row.json) as SessionSnapshot;
    // Stored before snapshots had an attention (LN-11): from what the snapshot shows.
    snap.attention ??= attentionFromSnapshot(snap);
    return snap;
  }

  protected restore(sessionKey: string) {
    const fold = this.storedSnapshot(sessionKey) ?? emptySnapshot(sessionKey);
    for (const e of this.load(sessionKey, fold.seq, Number.MAX_SAFE_INTEGER)) foldSnapshot(fold, e);
    return { head: fold.seq, fold };
  }

  floor(sessionKey: string): number {
    return this.storedSnapshot(sessionKey)?.seq ?? 0;
  }

  /**
   * One transaction on this database (`SessionLog.transaction`): `BEGIN IMMEDIATE`, or a
   * savepoint when one is already open (by this log or by another writer of the same
   * connection, e.g. the daemon's records). A throw rolls the store and the memory view back.
   * The memory view follows only this log's own transactions: under another writer's, its
   * appends are in memory once the savepoint is released, so that writer must not roll back
   * after it (as for a plain `append` inside its transaction). Once the transaction has ended
   * underneath (a failed statement can end all of it), further appends in it throw instead of
   * autocommitting (`persist`).
   */
  transaction<T>(fn: () => T): T {
    const nested = this.db.isTransaction;
    const sp = `aio_log_${this.savepoints + 1}`;
    this.db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
    this.savepoints++;
    this.beginMemory();
    try {
      const r = fn();
      this.db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
      this.commitMemory();
      return r;
    } catch (err) {
      // A failed statement may have ended the transaction already; the first error is the one to report.
      try {
        if (nested) this.db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        else if (this.db.isTransaction) this.db.exec('ROLLBACK');
      } catch {
        // nothing left to roll back
      }
      this.rollbackMemory();
      throw err;
    } finally {
      this.savepoints--;
    }
  }

  /** Fold and delete all but the newest `keep` durable events of a session. */
  compact(sessionKey: string, keep = 0): void {
    const cut = this.head(sessionKey) - keep;
    const from = this.floor(sessionKey);
    if (cut <= from) return;
    const fold = this.storedSnapshot(sessionKey) ?? emptySnapshot(sessionKey);
    // Only stored (durable) events are folded here, so ephemeral deltas never leak into it.
    for (const r of this.q.upTo.all(sessionKey, from, cut) as { json: string }[]) foldSnapshot(fold, JSON.parse(r.json) as SessionEvent);
    this.transaction(() => {
      this.q.snapPut.run(sessionKey, cut, JSON.stringify(fold));
      this.q.del.run(sessionKey, cut);
    });
  }

  sessions(): string[] {
    return (this.q.sessions.all() as { session_key: string }[]).map((r) => r.session_key);
  }

  close(): void {
    this.db.close();
  }
}
