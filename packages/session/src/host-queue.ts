import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mediaBlocks, type InboundEnvelope, type InboundItem } from '@agents-io/protocol';

/*
 * The durable host inbound queue (docs/HOSTS.md §2.1, decision 1). Inputs a rule
 * routes to the host (`on: "host"`) are appended here; each consumer has its own
 * cursor that only moves forward on `ack`, so delivery is at least once and a
 * host that is down only gets its inputs later. The channel message reference is
 * the idempotency key: a channel redelivering a message gets the cursor of the
 * first copy. Two ways to consume, same semantics: pull (`read`, with long-poll)
 * and push (`subscribe`, which redelivers whatever is unacked after a reconnect).
 * `peek` is neither: a look at a target's items by someone who is no consumer (PB-7).
 *
 * Items and consumers may carry a target (a backend id; `InboundItem.to`). A
 * consumer registered with a target walks only that target's items, one without
 * walks only items without a target; they share the cursor sequence and nothing
 * else. Appending a targeted item also records, in the same transaction, the
 * conversation and the messages it came from (what that target may later answer)
 * and the blob refs of its media blocks (what that target may read and attach, PB-6).
 *
 * An item for a target may also be set aside before it is appended (`defer`, PB-8):
 * it is in no queue and has no cursor until it is released (`release`: appended then,
 * behind everything queued meanwhile) or thrown away (`discard`). Set-aside items
 * survive a restart like queued ones.
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
  /** How long a message a target received stays one it may reply to or mark, and its media readable by the target (default 30 days). */
  grantMsgTtlMs?: number;
}

/** A conversation as a target's grants are keyed: no thread, no reply target. */
export interface GrantRoute {
  channel: string;
  account: string;
  conversationId: string;
}

export interface AppendResult {
  cursor: number;
  /** The channel reference was already queued: nothing was added. */
  duplicate: boolean;
}

/** An item set aside for its target (`HostQueue.defer`): not queued, no cursor yet. */
export interface DeferredItem {
  id: number;
  item: Omit<InboundItem, 'cursor'> & { to: string };
  /** `append`'s option, kept for the release. */
  grantConversation?: boolean;
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
    'refGet' | 'refPut' | 'trefGet' | 'trefPut' | 'pruneTrefs' | 'pruneTargeted' | 'headTarget' | 'consumerRegister' | 'consumerTarget' | 'consumersOf' | 'routePut' | 'routeGet' | 'routeCount' | 'msgPut' | 'msgGet' | 'pruneMsgs' | 'blobPut' | 'blobGet' | 'pruneBlobs' | 'forgetBlobs' | 'forgetItems' | 'forgetTrefs' | 'forgetConsumers' | 'forgetRoutes' | 'forgetMsgs' | 'insert' | 'after' | 'one' | 'consumerGet' | 'consumerPut' | 'consumerAck' | 'consumers' | 'consumerDel' | 'head' | 'prune' | 'pruneRefs' | 'pending' | 'deferPut' | 'deferGet' | 'deferAll' | 'deferDel' | 'forgetDeferred' | 'redispatchGet' | 'redispatchPut' | 'redispatchSet' | 'redispatchDel' | 'pruneRedispatch',
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
      CREATE TABLE IF NOT EXISTS host_inbound (cursor INTEGER PRIMARY KEY AUTOINCREMENT, channel_ref TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL, target TEXT);
      CREATE TABLE IF NOT EXISTS host_inbound_refs (channel_ref TEXT PRIMARY KEY, cursor INTEGER NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS host_consumers (name TEXT PRIMARY KEY, acked INTEGER NOT NULL, seen INTEGER NOT NULL, target TEXT);
      CREATE TABLE IF NOT EXISTS host_redispatch (cursor INTEGER PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_inbound_trefs (target TEXT NOT NULL, channel_ref TEXT NOT NULL, cursor INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (target, channel_ref)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS host_routes (target TEXT NOT NULL, channel TEXT NOT NULL, account TEXT NOT NULL, conversation TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (target, channel, account, conversation)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS host_route_msgs (target TEXT NOT NULL, channel TEXT NOT NULL, account TEXT NOT NULL, message_id TEXT NOT NULL, conversation TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (target, channel, account, message_id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS host_blob_grants (target TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (target, ref)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS host_deferred (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
    `);
    // `target` came later: a database from before gains the column, NULL (no target) on every row it has.
    for (const table of ['host_inbound', 'host_consumers']) {
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('target')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN target TEXT`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS host_inbound_target ON host_inbound (target, cursor)');
    const p = (sql: string) => this.db.prepare(sql);
    this.q = {
      refGet: p('SELECT cursor FROM host_inbound_refs WHERE channel_ref = ?'),
      refPut: p('INSERT INTO host_inbound_refs (channel_ref, cursor, at) VALUES (?, ?, ?)'),
      trefGet: p('SELECT cursor FROM host_inbound_trefs WHERE target = ? AND channel_ref = ?'),
      trefPut: p('INSERT INTO host_inbound_trefs (target, channel_ref, cursor, at) VALUES (?, ?, ?, ?)'),
      insert: p('INSERT INTO host_inbound (channel_ref, at, json, target) VALUES (?, ?, ?, ?)'),
      after: p('SELECT cursor, json FROM host_inbound WHERE cursor > ? AND target IS ? ORDER BY cursor LIMIT ?'),
      one: p('SELECT cursor, json FROM host_inbound WHERE cursor = ?'),
      redispatchGet: p('SELECT json FROM host_redispatch WHERE cursor = ?'),
      redispatchPut: p('INSERT INTO host_redispatch (cursor, at, json) VALUES (?, ?, ?) ON CONFLICT(cursor) DO NOTHING'),
      redispatchSet: p('UPDATE host_redispatch SET at = ?, json = ? WHERE cursor = ?'),
      redispatchDel: p('DELETE FROM host_redispatch WHERE cursor = ?'),
      pruneRedispatch: p('DELETE FROM host_redispatch WHERE at < ? AND cursor NOT IN (SELECT cursor FROM host_inbound)'),
      consumerGet: p('SELECT acked FROM host_consumers WHERE name = ?'),
      consumerPut: p('INSERT INTO host_consumers (name, acked, seen) VALUES (?, 0, ?) ON CONFLICT(name) DO UPDATE SET seen = excluded.seen'),
      consumerAck: p('UPDATE host_consumers SET acked = MAX(acked, ?), seen = ? WHERE name = ?'),
      consumerRegister: p('INSERT INTO host_consumers (name, acked, seen, target) VALUES (?, 0, ?, ?) ON CONFLICT(name) DO UPDATE SET target = excluded.target, seen = excluded.seen'),
      consumerTarget: p('SELECT target FROM host_consumers WHERE name = ?'),
      consumersOf: p('SELECT name FROM host_consumers WHERE target = ?'),
      consumers: p('SELECT name, acked, seen, target FROM host_consumers ORDER BY name'),
      consumerDel: p('DELETE FROM host_consumers WHERE name = ?'),
      head: p("SELECT seq FROM sqlite_sequence WHERE name = 'host_inbound'"),
      headTarget: p('SELECT MAX(cursor) AS head FROM host_inbound WHERE target = ?'),
      prune: p('DELETE FROM host_inbound WHERE target IS NULL AND cursor <= ? AND at < ?'),
      // One target's items up to what all its consumers acked (walks the (target, cursor) index, not the table).
      pruneTargeted: p('DELETE FROM host_inbound WHERE target = ? AND cursor <= ? AND at < ?'),
      pruneTrefs: p('DELETE FROM host_inbound_trefs WHERE at < ? AND cursor NOT IN (SELECT cursor FROM host_inbound)'),
      routePut: p('INSERT INTO host_routes (target, channel, account, conversation, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(target, channel, account, conversation) DO NOTHING'),
      routeGet: p('SELECT 1 AS ok FROM host_routes WHERE target = ? AND channel = ? AND account = ? AND conversation = ?'),
      routeCount: p('SELECT COUNT(*) AS n FROM host_routes WHERE target = ?'),
      msgPut: p('INSERT INTO host_route_msgs (target, channel, account, message_id, conversation, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(target, channel, account, message_id) DO UPDATE SET conversation = excluded.conversation, at = excluded.at'),
      msgGet: p('SELECT 1 AS ok FROM host_route_msgs WHERE target = ? AND channel = ? AND account = ? AND message_id = ? AND conversation = ? AND at >= ?'),
      pruneMsgs: p('DELETE FROM host_route_msgs WHERE at < ?'),
      blobPut: p('INSERT INTO host_blob_grants (target, ref, at) VALUES (?, ?, ?) ON CONFLICT(target, ref) DO UPDATE SET at = excluded.at'),
      blobGet: p('SELECT 1 AS ok FROM host_blob_grants WHERE target = ? AND ref = ? AND at >= ?'),
      pruneBlobs: p('DELETE FROM host_blob_grants WHERE at < ?'),
      forgetBlobs: p('DELETE FROM host_blob_grants WHERE target = ?'),
      forgetItems: p('DELETE FROM host_inbound WHERE target = ?'),
      forgetTrefs: p('DELETE FROM host_inbound_trefs WHERE target = ?'),
      forgetConsumers: p('DELETE FROM host_consumers WHERE target = ?'),
      forgetRoutes: p('DELETE FROM host_routes WHERE target = ?'),
      forgetMsgs: p('DELETE FROM host_route_msgs WHERE target = ?'),
      pruneRefs: p('DELETE FROM host_inbound_refs WHERE at < ? AND cursor NOT IN (SELECT cursor FROM host_inbound)'),
      pending: p('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM host_inbound WHERE cursor > ? AND target IS ?'),
      deferPut: p('INSERT INTO host_deferred (target, at, json) VALUES (?, ?, ?)'),
      deferGet: p('SELECT id, json FROM host_deferred WHERE id = ?'),
      deferAll: p('SELECT id, json FROM host_deferred ORDER BY id'),
      deferDel: p('DELETE FROM host_deferred WHERE id = ?'),
      forgetDeferred: p('DELETE FROM host_deferred WHERE target = ?'),
    };
  }

  /**
   * Append an item; a channel reference seen before returns the first copy's cursor.
   * An item with `to` is deduplicated per target (the same message for two targets is
   * two items), and grants its target the conversation and messages of its reply route.
   * `o.grantConversation: false` (a click on a message the target sent itself): the
   * messages only. Sending that message already took the conversation; a click, which
   * its sender cannot stop people from making, must not give it back once it was taken away.
   */
  append(item: Omit<InboundItem, 'cursor'>, o: { grantConversation?: boolean } = {}): AppendResult {
    // Message ids are unique per account: dedup on (account, channelRef).
    const key = `${item.account}\n${item.channelRef}`;
    const to = item.to;
    const prior = (to !== undefined ? this.q.trefGet.get(to, key) : this.q.refGet.get(key)) as { cursor: number } | undefined;
    if (prior) return { cursor: prior.cursor, duplicate: true };
    const at = this.now();
    let cursor: number;
    this.db.exec('BEGIN');
    try {
      const { raw: _raw, ...envelope } = item.envelope;
      const stored = { ...item, envelope };
      cursor = Number(this.q.insert.run(item.channelRef, at, JSON.stringify(stored), to ?? null).lastInsertRowid);
      if (to === undefined) this.q.refPut.run(key, cursor, at);
      else {
        this.q.trefPut.run(to, key, cursor, at);
        const r = item.input.replyRoute;
        if (r) {
          if (o.grantConversation !== false) this.q.routePut.run(to, r.channel, r.account, r.conversationId, at);
          // Both ids: a card click's envelope id is not a message, its reply target is the card.
          for (const id of new Set([item.envelope.id, r.replyToMessageId])) {
            if (id) this.q.msgPut.run(to, r.channel, r.account, id, r.conversationId, at);
          }
        }
        // PB-6: the media of an item routed to a target is the target's to read and attach, whatever
        // the item is (no reply route, a click). Only media blocks count: a ref anywhere else grants nothing.
        for (const ref of new Set([...mediaBlocks(stored.input.content), ...mediaBlocks(stored.envelope.content)].map((b) => b.ref))) {
          if (typeof ref === 'string' && ref) this.q.blobPut.run(to, ref, at);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    for (const w of [...this.waiters]) w();
    return { cursor, duplicate: false };
  }

  /**
   * PB-8: set an item for a target aside instead of appending it: it is in no queue, has no cursor
   * and grants nothing until `release` appends it (as `append` would now, with `o`) or `discard`
   * throws it away. Durable like the queue. Returns the id to release or discard it by.
   */
  defer(item: Omit<InboundItem, 'cursor'> & { to: string }, o: { grantConversation?: boolean } = {}): number {
    const { raw: _raw, ...envelope } = item.envelope;
    const stored = { item: { ...item, envelope }, ...(o.grantConversation === false ? { grantConversation: false } : {}) };
    return Number(this.q.deferPut.run(item.to, this.now(), JSON.stringify(stored)).lastInsertRowid);
  }

  /** The items set aside and neither released nor discarded yet, oldest first. */
  deferred(): DeferredItem[] {
    return (this.q.deferAll.all() as { id: number; json: string }[]).map((r) => ({ id: r.id, ...(JSON.parse(r.json) as Omit<DeferredItem, 'id'>) }));
  }

  /**
   * Append an item set aside (`defer`): it gets its cursor now, behind what was queued meanwhile.
   * Undefined when there is no such item (released, discarded, or its target was forgotten).
   * Appended before its row goes: a stop in between appends it again next time, as a duplicate.
   */
  release(id: number): AppendResult | undefined {
    const row = this.q.deferGet.get(id) as { id: number; json: string } | undefined;
    if (!row) return undefined;
    const d = JSON.parse(row.json) as Omit<DeferredItem, 'id'>;
    const r = this.append(d.item, d.grantConversation === false ? { grantConversation: false } : {});
    this.q.deferDel.run(id);
    return r;
  }

  /** Throw an item set aside away: it is never queued. False when there is no such item. */
  discard(id: number): boolean {
    return Number(this.q.deferDel.run(id).changes) > 0;
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

  /**
   * Make `consumer` known and set which items it walks: `target`'s, or (without one)
   * the items without a target. Its acked cursor is kept.
   */
  register(consumer: string, target?: string): void {
    if (!consumer) throw new Error('consumer name is empty');
    this.q.consumerRegister.run(consumer, this.now(), target ?? null);
  }

  /** The target a known consumer walks (undefined: none, or not a known consumer). Reads only. */
  consumerTarget(consumer: string): string | undefined {
    const r = this.q.consumerTarget.get(consumer) as { target: string | null } | undefined;
    return r?.target ?? undefined;
  }

  /**
   * The highest cursor this consumer can reach (registers it): the queue's head, or
   * for a consumer with a target the last of its target's items (never below what it acked).
   */
  headOf(consumer: string): number {
    const acked = this.cursor(consumer);
    const target = this.consumerTarget(consumer);
    if (target === undefined) return this.head();
    const r = this.q.headTarget.get(target) as { head: number | null };
    return Math.max(acked, r.head ?? 0);
  }

  /** Known consumers; `target` only on those that have one. */
  consumers(): { name: string; acked: number; seen: number; target?: string }[] {
    return (this.q.consumers.all() as { name: string; acked: number; seen: number; target: string | null }[]).map(({ target, ...c }) => (target === null ? c : { ...c, target }));
  }

  /**
   * How many items of `target` (default: items without one) there are after `after`,
   * and when the oldest of them arrived (Unix ms). Reads only.
   */
  pending(after: number, target?: string): { count: number; oldestAt?: number } {
    const r = this.q.pending.get(after, target ?? null) as { n: number; oldest: number | null };
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

  private load(after: number, limit: number, target: string | undefined): InboundItem[] {
    return (this.q.after.all(after, target ?? null, Math.max(1, Math.min(limit, 10_000))) as { cursor: number; json: string }[]).map((r) => ({ ...(JSON.parse(r.json) as Omit<InboundItem, 'cursor'>), cursor: r.cursor }));
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
    const target = this.consumerTarget(consumer);
    const deadline = this.now() + (o.waitMs ?? 0);
    for (;;) {
      const items = this.load(after, limit, target);
      const left = deadline - this.now();
      if (items.length || left <= 0 || this.closed || o.signal?.aborted) return items;
      await this.waitAppend(left, o.signal);
    }
  }

  /**
   * What a known consumer acked, 0 for a name that is no consumer. Reads only: unlike `cursor`
   * it registers nothing and does not touch `seen` (PB-7).
   */
  ackedOf(consumer: string): number {
    const r = this.q.consumerGet.get(consumer) as { acked: number } | undefined;
    return r?.acked ?? 0;
  }

  /** The last cursor among `target`'s items (0 when it has none). Reads only. */
  targetHead(target: string): number {
    const r = this.q.headTarget.get(target) as { head: number | null };
    return r.head ?? 0;
  }

  /**
   * Look at `target`'s items after `after` without being a consumer (PB-7): the same rows and the
   * same long-poll as `read`, and nothing is written. No consumer is registered or touched, no
   * cursor moves, and retention ignores whoever peeks (an item its consumers acked is pruned
   * whether or not it was peeked). An empty target is refused: it would name the items without a
   * target, the host's own backlog.
   */
  async peek(target: string, o: { after: number; limit?: number; waitMs?: number; signal?: AbortSignal }): Promise<InboundItem[]> {
    if (!target) throw new Error('target is empty');
    const limit = o.limit ?? 100;
    const deadline = this.now() + (o.waitMs ?? 0);
    for (;;) {
      const items = this.load(o.after, limit, target);
      const left = deadline - this.now();
      if (items.length || left <= 0 || this.closed || o.signal?.aborted) return items;
      await this.waitAppend(left, o.signal);
    }
  }

  /** Move the consumer's cursor forward (never back). Returns the acked cursor. */
  ack(consumer: string, cursor: number): number {
    const c = Math.min(Math.max(0, Math.floor(cursor)), this.headOf(consumer));
    this.q.consumerAck.run(c, this.now(), consumer);
    this.prune();
    return this.cursor(consumer);
  }

  /**
   * Delete items every known consumer of theirs has acked, once older than
   * `retainAckedMs`: items without a target count the consumers without one, a
   * target's items count that target's consumers. Without any known consumer
   * nothing is deleted. Returns how many were deleted.
   */
  prune(): number {
    const cs = this.consumers();
    if (!cs.length) return 0;
    const plain = cs.filter((c) => c.target === undefined);
    const now = this.now();
    const before = now - (this.o.retainAckedMs ?? DAY);
    let n = plain.length ? Number(this.q.prune.run(Math.min(...plain.map((c) => c.acked)), before).changes) : 0;
    // A targeted item goes once every consumer of its target acked it; a target nobody consumes keeps its items.
    const acked = new Map<string, number>();
    for (const c of cs) if (c.target !== undefined) acked.set(c.target, Math.min(acked.get(c.target) ?? Infinity, c.acked));
    for (const [target, upTo] of acked) if (upTo > 0) n += Number(this.q.pruneTargeted.run(target, upTo, before).changes);
    this.q.pruneRefs.run(now - (this.o.refTtlMs ?? 7 * DAY));
    this.q.pruneTrefs.run(now - (this.o.refTtlMs ?? 7 * DAY));
    this.q.pruneMsgs.run(now - (this.o.grantMsgTtlMs ?? 30 * DAY));
    this.q.pruneBlobs.run(now - (this.o.grantMsgTtlMs ?? 30 * DAY));
    this.q.pruneRedispatch.run(now - (this.o.refTtlMs ?? 7 * DAY));
    return n;
  }

  /** Whether an item routed to `target` came from this conversation (any thread). Never lapses. */
  granted(target: string, r: GrantRoute): boolean {
    return this.q.routeGet.get(target, r.channel, r.account, r.conversationId) !== undefined;
  }

  /**
   * Whether `messageId` is a message of this conversation that `target` received
   * (an item's envelope id or its reply target) within `grantMsgTtlMs`.
   */
  grantedMessage(target: string, r: GrantRoute & { messageId: string }): boolean {
    const since = this.now() - (this.o.grantMsgTtlMs ?? 30 * DAY);
    return this.q.msgGet.get(target, r.channel, r.account, r.messageId, r.conversationId, since) !== undefined;
  }

  /**
   * PB-6: whether `ref` is the blob of a media block (`image`, `file`, `audio`) of an item routed
   * to `target` within `grantMsgTtlMs`.
   */
  grantedBlob(target: string, ref: string): boolean {
    const since = this.now() - (this.o.grantMsgTtlMs ?? 30 * DAY);
    return this.q.blobGet.get(target, ref, since) !== undefined;
  }

  /** How many conversations `target` was granted by the items routed to it. */
  grantCount(target: string): number {
    return (this.q.routeCount.get(target) as { n: number }).n;
  }

  /**
   * Remove everything kept for `target`: its items (those set aside too), their idempotency keys, its
   * consumers (their pushes are closed first) and its grants (media grants too). Others are untouched.
   * `o.consumer`: a consumer name to remove as well, whatever it walks (the name a
   * target's consumer goes by, registered without the target before targets existed:
   * such a row counts for the untargeted items' retention and nothing else removes it).
   */
  forgetTarget(target: string, o: { consumer?: string } = {}): { items: number; routes: number } {
    for (const c of this.q.consumersOf.all(target) as { name: string }[]) this.pushes.get(c.name)?.close();
    if (o.consumer !== undefined) this.pushes.get(o.consumer)?.close();
    this.db.exec('BEGIN');
    try {
      const items = Number(this.q.forgetItems.run(target).changes);
      this.q.forgetTrefs.run(target);
      this.q.forgetConsumers.run(target);
      if (o.consumer !== undefined) this.q.consumerDel.run(o.consumer);
      const routes = Number(this.q.forgetRoutes.run(target).changes);
      this.q.forgetMsgs.run(target);
      this.q.forgetBlobs.run(target);
      this.q.forgetDeferred.run(target);
      this.db.exec('COMMIT');
      return { items, routes };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
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
  next(after: number, target?: string): InboundItem | undefined {
    return this.load(after, 1, target)[0];
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
    // Taken once: a consumer's target is set before it subscribes.
    const target = this.queue.consumerTarget(this.consumer);
    while (!signal.aborted) {
      const item = this.queue.next(after, target);
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
        // Not for a target that was forgotten meanwhile: an ack would bring the consumer back without its target.
        if (ok && this.queue.consumerTarget(this.consumer) === target) this.queue.ack(this.consumer, item.cursor);
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
