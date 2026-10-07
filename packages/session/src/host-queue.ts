import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { InboundEnvelope, InboundItem } from '@agents-io/protocol';

/*
 * The durable host inbound queue (docs/HOSTS.md §2.1, decision 1). Inputs a rule
 * routes to the host (`on: "host"`) are appended here; each consumer has its own
 * cursor that only moves forward on `ack`, so delivery is at least once and a
 * host that is down only gets its inputs later. The channel message reference is
 * the idempotency key: a channel redelivering a message gets the cursor of the
 * first copy. Two ways to consume, same semantics: pull (`read`, with long-poll)
 * and push (`subscribe`, which redelivers whatever is unacked after a reconnect).
 */

export interface HostQueueOptions {
  /** SQLite file, or `:memory:` (default). Ignored when `db` is given. */
  path?: string;
  /** Share an open database (e.g. `SqliteSessionLog.db`); the queue then never closes it. */
  db?: DatabaseSync;
  now?: () => number;
  /** Items every known consumer acked are deleted once older than this (default 24 h). */
  retainAckedMs?: number;
  /** How long a channel reference stays an idempotency key after its item was deleted (default 7 days). */
  refTtlMs?: number;
}

export interface AppendResult {
  cursor: number;
  /** The channel reference was already queued: nothing was added. */
  duplicate: boolean;
}

export interface ReadOptions {
  /** Exclusive; default the consumer's acked cursor. */
  after?: number;
  /** Default 100. */
  limit?: number;
  /** Long-poll: wait up to this long for an item when none is pending (default 0). */
  waitMs?: number;
  signal?: AbortSignal;
}

/** Push consumer: resolve true (or nothing) once the item is durably taken; false or a throw retries it. */
export type PushHandler = (item: InboundItem) => Promise<boolean | void> | boolean | void;

export interface PushSubscription {
  close(): void;
  /** Resolves when the push loop has stopped. */
  readonly done: Promise<void>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** `channel:<channel>/<message id>`: the queue's idempotency key for an envelope. */
export function channelRefOf(env: Pick<InboundEnvelope, 'channel' | 'id'>): string {
  return `channel:${env.channel}/${env.id}`;
}

export class HostQueue {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly now: () => number;
  private q: Record<
    'refGet' | 'refPut' | 'insert' | 'after' | 'one' | 'consumerGet' | 'consumerPut' | 'consumerAck' | 'consumers' | 'consumerDel' | 'head' | 'prune' | 'pruneRefs' | 'pending' | 'redispatchGet' | 'redispatchPut' | 'redispatchSet' | 'redispatchDel' | 'pruneRedispatch',
    StatementSync
  >;
  private waiters = new Set<() => void>();
  private pushes = new Map<string, Push>();
  private closed = false;

  constructor(private readonly o: HostQueueOptions = {}) {
    this.ownsDb = !o.db;
    this.db = o.db ?? new DatabaseSync(o.path ?? ':memory:');
    this.now = o.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_inbound (cursor INTEGER PRIMARY KEY AUTOINCREMENT, channel_ref TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_inbound_refs (channel_ref TEXT PRIMARY KEY, cursor INTEGER NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS host_consumers (name TEXT PRIMARY KEY, acked INTEGER NOT NULL, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS host_redispatch (cursor INTEGER PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL);
    `);
    const p = (sql: string) => this.db.prepare(sql);
    this.q = {
      refGet: p('SELECT cursor FROM host_inbound_refs WHERE channel_ref = ?'),
      refPut: p('INSERT INTO host_inbound_refs (channel_ref, cursor, at) VALUES (?, ?, ?)'),
      insert: p('INSERT INTO host_inbound (channel_ref, at, json) VALUES (?, ?, ?)'),
      after: p('SELECT cursor, json FROM host_inbound WHERE cursor > ? ORDER BY cursor LIMIT ?'),
      one: p('SELECT cursor, json FROM host_inbound WHERE cursor = ?'),
      redispatchGet: p('SELECT json FROM host_redispatch WHERE cursor = ?'),
      redispatchPut: p('INSERT INTO host_redispatch (cursor, at, json) VALUES (?, ?, ?) ON CONFLICT(cursor) DO NOTHING'),
      redispatchSet: p('UPDATE host_redispatch SET at = ?, json = ? WHERE cursor = ?'),
      redispatchDel: p('DELETE FROM host_redispatch WHERE cursor = ?'),
      pruneRedispatch: p('DELETE FROM host_redispatch WHERE at < ? AND cursor NOT IN (SELECT cursor FROM host_inbound)'),
      consumerGet: p('SELECT acked FROM host_consumers WHERE name = ?'),
      consumerPut: p('INSERT INTO host_consumers (name, acked, seen) VALUES (?, 0, ?) ON CONFLICT(name) DO UPDATE SET seen = excluded.seen'),
      consumerAck: p('UPDATE host_consumers SET acked = MAX(acked, ?), seen = ? WHERE name = ?'),
      consumers: p('SELECT name, acked, seen FROM host_consumers ORDER BY name'),
      consumerDel: p('DELETE FROM host_consumers WHERE name = ?'),
      head: p("SELECT seq FROM sqlite_sequence WHERE name = 'host_inbound'"),
      prune: p('DELETE FROM host_inbound WHERE cursor <= ? AND at < ?'),
      pruneRefs: p('DELETE FROM host_inbound_refs WHERE at < ? AND cursor NOT IN (SELECT cursor FROM host_inbound)'),
      pending: p('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM host_inbound WHERE cursor > ?'),
    };
  }

  /** Append an item; a channel reference seen before returns the first copy's cursor. */
  append(item: Omit<InboundItem, 'cursor'>): AppendResult {
    // Message ids are unique per account: dedup on (account, channelRef).
    const key = `${item.account}\n${item.channelRef}`;
    const prior = this.q.refGet.get(key) as { cursor: number } | undefined;
    if (prior) return { cursor: prior.cursor, duplicate: true };
    const at = this.now();
    let cursor: number;
    this.db.exec('BEGIN');
    try {
      const { raw: _raw, ...envelope } = item.envelope;
      const stored = { ...item, envelope };
      cursor = Number(this.q.insert.run(item.channelRef, at, JSON.stringify(stored)).lastInsertRowid);
      this.q.refPut.run(key, cursor, at);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    for (const w of [...this.waiters]) w();
    return { cursor, duplicate: false };
  }

  /** Highest cursor ever assigned (0 when empty). */
  head(): number {
    const r = this.q.head.get() as { seq: number } | undefined;
    return r?.seq ?? 0;
  }

  /** The consumer's acked cursor (registers it: known consumers bound retention). */
  cursor(consumer: string): number {
    this.touch(consumer);
    return (this.q.consumerGet.get(consumer) as { acked: number }).acked;
  }

  consumers(): { name: string; acked: number; seen: number }[] {
    return this.q.consumers.all() as { name: string; acked: number; seen: number }[];
  }

  /** How many items there are after `after`, and when the oldest of them arrived (Unix ms). Reads only. */
  pending(after: number): { count: number; oldestAt?: number } {
    const r = this.q.pending.get(after) as { n: number; oldest: number | null };
    return { count: r.n, ...(r.oldest !== null ? { oldestAt: r.oldest } : {}) };
  }

  /** Stop counting a consumer for retention. */
  forget(consumer: string): void {
    this.pushes.get(consumer)?.close();
    this.q.consumerDel.run(consumer);
  }

  private touch(consumer: string): void {
    if (!consumer) throw new Error('consumer name is empty');
    this.q.consumerPut.run(consumer, this.now());
  }

  private load(after: number, limit: number): InboundItem[] {
    return (this.q.after.all(after, Math.max(1, Math.min(limit, 10_000))) as { cursor: number; json: string }[]).map((r) => ({ ...(JSON.parse(r.json) as Omit<InboundItem, 'cursor'>), cursor: r.cursor }));
  }

  /** One queued item by cursor (undefined once pruned, or never queued). */
  get(cursor: number): InboundItem | undefined {
    if (!Number.isSafeInteger(cursor) || cursor <= 0) return undefined;
    const r = this.q.one.get(cursor) as { cursor: number; json: string } | undefined;
    return r ? { ...(JSON.parse(r.json) as Omit<InboundItem, 'cursor'>), cursor: r.cursor } : undefined;
  }

  /**
   * The recorded outcome of the item's redispatch (`inbound.redispatch` is
   * idempotent per cursor). Kept while the item is, and `refTtlMs` after.
   */
  redispatched<T = unknown>(cursor: number): T | undefined {
    const r = this.q.redispatchGet.get(cursor) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : undefined;
  }

  /**
   * Record a redispatch; false when the cursor already has one (the first stays).
   * The gateway records a pending one before it delivers (so a delivery cut off by
   * a stop is never repeated: at most once), then replaces it (`finishRedispatch`)
   * or removes it when the delivery failed (`dropRedispatch`).
   */
  recordRedispatch(cursor: number, value: unknown): boolean {
    return Number(this.q.redispatchPut.run(cursor, this.now(), JSON.stringify(value)).changes) > 0;
  }

  /** Replace the cursor's recorded redispatch (the pending one with its outcome). */
  finishRedispatch(cursor: number, value: unknown): void {
    this.q.redispatchSet.run(this.now(), JSON.stringify(value), cursor);
  }

  /** Forget the cursor's redispatch (its delivery failed: the host may try again). */
  dropRedispatch(cursor: number): void {
    this.q.redispatchDel.run(cursor);
  }

  /** Pull: items after `after` (default the acked cursor), waiting up to `waitMs` when there are none yet. */
  async read(consumer: string, o: ReadOptions = {}): Promise<InboundItem[]> {
    const after = o.after ?? this.cursor(consumer);
    if (o.after !== undefined) this.touch(consumer);
    const limit = o.limit ?? 100;
    const deadline = this.now() + (o.waitMs ?? 0);
    for (;;) {
      const items = this.load(after, limit);
      const left = deadline - this.now();
      if (items.length || left <= 0 || this.closed || o.signal?.aborted) return items;
      await this.waitAppend(left, o.signal);
    }
  }

  /** Move the consumer's cursor forward (never back). Returns the acked cursor. */
  ack(consumer: string, cursor: number): number {
    this.touch(consumer);
    const c = Math.min(Math.max(0, Math.floor(cursor)), this.head());
    this.q.consumerAck.run(c, this.now(), consumer);
    this.prune();
    return this.cursor(consumer);
  }

  /**
   * Delete items every known consumer has acked, once older than `retainAckedMs`.
   * Without any known consumer nothing is deleted. Returns how many were deleted.
   */
  prune(): number {
    const cs = this.consumers();
    if (!cs.length) return 0;
    const min = Math.min(...cs.map((c) => c.acked));
    const now = this.now();
    const n = Number(this.q.prune.run(min, now - (this.o.retainAckedMs ?? DAY)).changes);
    this.q.pruneRefs.run(now - (this.o.refTtlMs ?? 7 * DAY));
    this.q.pruneRedispatch.run(now - (this.o.refTtlMs ?? 7 * DAY));
    return n;
  }

  /**
   * Push: deliver unacked items to `handler` in order, one at a time, acking each
   * it accepts. A refused or failed item is retried after `retryMs` (default 1 s).
   * One push per consumer: a new subscription (a reconnect) replaces the old one
   * and starts again from the acked cursor, so unacked items are redelivered.
   */
  subscribe(consumer: string, handler: PushHandler, o: { retryMs?: number } = {}): PushSubscription {
    this.pushes.get(consumer)?.close();
    this.touch(consumer);
    const push = new Push(this, consumer, handler, o.retryMs ?? 1000, () => {
      if (this.pushes.get(consumer) === push) this.pushes.delete(consumer);
    });
    this.pushes.set(consumer, push);
    return push;
  }

  /** @internal Wait for the next append (or the timeout / abort / close). */
  waitAppend(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const t = setTimeout(done, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** @internal */
  next(after: number): InboundItem | undefined {
    return this.load(after, 1)[0];
  }

  close(): void {
    this.closed = true;
    for (const p of [...this.pushes.values()]) p.close();
    for (const w of [...this.waiters]) w();
    if (this.ownsDb) this.db.close();
  }
}

class Push implements PushSubscription {
  private readonly ac = new AbortController();
  readonly done: Promise<void>;

  constructor(
    private readonly queue: HostQueue,
    private readonly consumer: string,
    private readonly handler: PushHandler,
    private readonly retryMs: number,
    private readonly onEnd: () => void,
  ) {
    this.done = this.run().finally(onEnd);
  }

  private async run(): Promise<void> {
    const signal = this.ac.signal;
    let after = this.queue.cursor(this.consumer);
    while (!signal.aborted) {
      const item = this.queue.next(after);
      if (!item) {
        await this.queue.waitAppend(60_000, signal);
        continue;
      }
      let ok: boolean;
      try {
        ok = (await this.handler(item)) !== false;
      } catch {
        ok = false;
      }
      if (signal.aborted) {
        // Closed while the host had it: an accepted item still counts; anything else waits for the next subscription.
        if (ok) this.queue.ack(this.consumer, item.cursor);
        return;
      }
      if (ok) after = this.queue.ack(this.consumer, item.cursor);
      else await sleep(this.retryMs, signal);
    }
  }

  close(): void {
    this.ac.abort();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
