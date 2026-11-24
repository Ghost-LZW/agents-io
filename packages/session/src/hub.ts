import { PROTOCOL_VERSION, type Attention, type SessionEvent, type Tier } from '@agents-io/protocol';
import { isEphemeral, type EventDraft, type SessionLog, type SessionSnapshot, type Visibility } from './log.js';
import { passes, project, type TierFilter } from './tier.js';

/**
 * Name of the synthetic `native` event that carries a `SessionSnapshot` in its
 * `native` field. The protocol has no snapshot body kind yet.
 */
export const SNAPSHOT_EVENT = 'agents-io.snapshot';

export function isSnapshotEvent(e: SessionEvent): e is SessionEvent & { native: SessionSnapshot } {
  return e.body.t === 'native' && e.body.name === SNAPSHOT_EVENT;
}

export function snapshotEvent(s: SessionSnapshot): SessionEvent {
  return {
    v: PROTOCOL_VERSION,
    sessionKey: s.sessionKey,
    seq: s.seq,
    harness: s.harness,
    generation: s.generation,
    visibility: 'participants',
    ts: Date.now(),
    level: 'primary',
    audience: 'status',
    durability: 'ephemeral',
    body: { t: 'native', name: SNAPSHOT_EVENT },
    native: s,
  };
}

/** A snapshot as a tier shows it: item details (input, result) only on `full`, like `project`. */
function projectSnapshot(s: SessionSnapshot, tier: Tier): SessionSnapshot {
  if (tier === 'full') return s;
  return { ...s, activeItems: s.activeItems.map(({ inputSummary: _i, result: _r, ...item }) => item) };
}

export interface SubscribeOptions {
  sessionKey: string;
  /**
   * Last seq the subscriber has seen. Omitted: start with a snapshot (late joiner).
   * Behind the log's floor, or ahead of its head (a cursor from before the log was
   * rebuilt or replaced): snapshot, then everything after it. Otherwise replay
   * `seq > fromSeq`, then live.
   */
  fromSeq?: number;
  tier: Tier;
  filter?: TierFilter;
  /** Visibilities this subscriber may see (default: by tier, never `internal`). */
  visibility?: Visibility[];
  /** Max buffered events before ephemeral ones are dropped and durable ones re-read from the log. */
  bufferSize?: number;
  signal?: AbortSignal;
}

export interface Subscription extends AsyncIterable<SessionEvent> {
  /** Ephemeral events dropped because this subscriber was slow. */
  readonly dropped: number;
  /** True while durable events are being re-read from the log instead of buffered. */
  readonly lagging: boolean;
  close(): void;
}

/** How many turn/request ids `Hub.locate` remembers. */
const LOCATE_WINDOW = 10_000;

/** A `Hub.batch` in progress. */
interface Frame {
  events: SessionEvent[];
  /** `Hub.onRollback`, in the order given (run in reverse). */
  undo: (() => void)[];
  /** `Hub.afterCommit`, in the order given. */
  after: (() => void)[];
}

/**
 * Fan-out over a `SessionLog`. All writes to a session go through `append`. Subscribers get
 * events in seq order; a slow one loses only ephemeral events (`Subscription.dropped`) and
 * re-reads durable ones from the log (`lagging`), it is never cut off (INVARIANTS LN-10).
 */
export class Hub {
  private subs = new Map<string, Set<Sub>>();
  /** `turn:<id>` / `req:<id>` → session key, from what was appended in this process. */
  private where = new Map<string, string>();
  /** The innermost `batch` in progress: what it appended (published when the outermost commits) and what waits on its outcome. */
  private frame: Frame | undefined;
  /** Subscribers made inside the outermost `batch` in progress: they start reading once it has ended (`subscribe`). */
  private deferred: Sub[] = [];
  /** `onAttention` listeners. */
  private readonly attentionListeners = new Set<(sessionKey: string, attention: Attention) => void>();
  /** Per session, the `seq` of the last attention told to them. */
  private readonly toldAttention = new Map<string, number>();

  constructor(
    readonly log: SessionLog,
    private readonly opts: { bufferSize?: number } = {},
  ) {}

  append(sessionKey: string, draft: EventDraft): SessionEvent {
    const e = this.log.append(sessionKey, draft);
    if (this.frame) this.frame.events.push(e);
    else this.publish(e);
    return e;
  }

  /**
   * Run `fn` (synchronous) as one transaction of the log (`SessionLog.transaction`), with
   * whatever else it writes to the log's database: its appends commit together and reach
   * subscribers (and `locate`) only after the commit, in seq order. A throw rolls all of it
   * back, the log's memory view included; nobody sees those events, and the error is
   * rethrown. A batch inside a batch is a savepoint, published with the outer one. On a log
   * without transactions (in memory) `fn` just runs and each append is published at once.
   * A subscriber made inside a batch starts once the outermost one has ended (after its events
   * are published, or rolled back): it never reads what has not committed. What `fn` changes
   * outside the database follows the outcome: `onRollback` undoes it, `afterCommit` waits for it.
   */
  batch<T>(fn: () => T): T {
    if (!this.log.transaction) return fn();
    const outer = this.frame;
    const mine: Frame = { events: [], undo: [], after: [] };
    this.frame = mine;
    let r: T;
    try {
      r = this.log.transaction(fn);
    } catch (e) {
      this.frame = outer;
      for (const undo of mine.undo.reverse()) {
        try {
          undo();
        } catch {
          // memory put back as far as it goes: the write's error is the one to report
        }
      }
      if (!outer) this.startDeferred();
      throw e;
    } finally {
      this.frame = outer;
    }
    if (outer) {
      outer.events.push(...mine.events);
      outer.undo.push(...mine.undo);
      outer.after.push(...mine.after);
      return r;
    }
    for (const e of mine.events) this.publish(e);
    this.startDeferred();
    let failed: { err: unknown } | undefined;
    for (const after of mine.after) {
      try {
        after();
      } catch (err) {
        failed ??= { err };
      }
    }
    if (failed) throw failed.err;
    return r;
  }

  /**
   * Inside a `batch`: `undo` runs if the batch in progress rolls back (an outer one too, once this
   * one has committed into it), to put back what memory the caller changed with its writes; it is
   * dropped once the outermost batch commits. Outside a batch (nothing to roll back) it never runs.
   */
  onRollback(undo: () => void): void {
    this.frame?.undo.push(undo);
  }

  /**
   * `fn` runs once what is being written has committed: at once outside a `batch` (or on a log
   * without transactions); inside one, after the outermost batch commits and its events are
   * published, never if it rolls back. For what cannot be taken back (timers, closing a lane). A
   * throw is rethrown from that `batch`, after the rest have run.
   */
  afterCommit(fn: () => void): void {
    if (this.frame) this.frame.after.push(fn);
    else fn();
  }

  private startDeferred(): void {
    for (const sub of this.deferred.splice(0)) this.start(sub);
  }

  /** A subscriber starts: it reads what it missed from the log, then gets what is appended. */
  private start(sub: Sub): void {
    if (!sub.begin()) return;
    let set = this.subs.get(sub.sessionKey);
    if (!set) this.subs.set(sub.sessionKey, (set = new Set()));
    set.add(sub);
  }

  private publish(e: SessionEvent): void {
    this.index(e);
    for (const s of this.subs.get(e.sessionKey) ?? []) s.offer(e);
    if (this.attentionListeners.size && !isEphemeral(e)) this.tellAttention(e);
  }

  /**
   * After `e` is published: its session's attention as the log has it now, when an event from `e`
   * on changed it and it has not been told. Published after a commit, the log is already past the
   * whole batch: the first of its events tells the value after all of them, the rest nothing.
   */
  private tellAttention(e: SessionEvent): void {
    const a = this.attention(e.sessionKey);
    if (!a || a.seq < e.seq || a.seq <= (this.toldAttention.get(e.sessionKey) ?? 0)) return;
    this.toldAttention.set(e.sessionKey, a.seq);
    for (const fn of this.attentionListeners) {
      try {
        fn(e.sessionKey, a);
      } catch {
        // a listener's failure is its own: the append has happened
      }
    }
  }

  /** What is pending in a session now (the snapshot's `attention`, LN-11). */
  attention(sessionKey: string): Attention | undefined {
    return this.log.attention ? this.log.attention(sessionKey) : this.log.snapshot(sessionKey).attention;
  }

  /**
   * `fn` hears each change of a session's attention (LN-11), once the events that changed it are
   * committed and published (never what a batch rolled back), in `seq` order per session; the events
   * of one batch are told once, with the value after them all. Changes from before `fn` was added
   * are not told. Returns the function that removes it.
   */
  onAttention(fn: (sessionKey: string, attention: Attention) => void): () => void {
    this.attentionListeners.add(fn);
    return () => this.attentionListeners.delete(fn);
  }

  /**
   * The session a turn or request belongs to (a button click names only the id):
   * turns started or adopted, and requests opened, through this hub.
   */
  locate(ref: { turnId: string } | { requestId: string }): string | undefined {
    return this.where.get('turnId' in ref ? `turn:${ref.turnId}` : `req:${ref.requestId}`);
  }

  private index(e: SessionEvent): void {
    const b = e.body;
    const k = b.t === 'turn.started' || b.t === 'turn.adopted' ? `turn:${b.turnId}` : b.t === 'request.opened' ? `req:${b.requestId}` : undefined;
    if (!k) return;
    this.where.delete(k);
    this.where.set(k, e.sessionKey);
    for (const old of this.where.keys()) {
      if (this.where.size <= LOCATE_WINDOW) break;
      this.where.delete(old);
    }
  }

  snapshot(sessionKey: string): SessionSnapshot {
    return this.log.snapshot(sessionKey);
  }

  subscribe(o: SubscribeOptions): Subscription {
    const sub = new Sub(this.log, o, o.bufferSize ?? this.opts.bufferSize ?? 1024, () => {
      this.subs.get(o.sessionKey)?.delete(sub);
      const i = this.deferred.indexOf(sub);
      if (i >= 0) this.deferred.splice(i, 1);
    });
    // Inside a batch the log shows appends that may still roll back: start once it has ended.
    if (this.frame) this.deferred.push(sub);
    else this.start(sub);
    return sub;
  }

  subscriberCount(sessionKey: string): number {
    return this.subs.get(sessionKey)?.size ?? 0;
  }
}

class Sub implements Subscription {
  private queue: SessionEvent[] = [];
  private waiter: ((r: IteratorResult<SessionEvent>) => void) | undefined;
  /** Last durable seq handed to (or filtered for) this subscriber. */
  private cursor: number;
  private closed = false;
  dropped = 0;
  lagging = false;

  constructor(
    private readonly log: SessionLog,
    private readonly o: SubscribeOptions,
    private readonly cap: number,
    private readonly detach: () => void,
  ) {
    this.cursor = o.fromSeq ?? 0;
    o.signal?.addEventListener('abort', () => this.close(), { once: true });
  }

  get sessionKey(): string {
    return this.o.sessionKey;
  }

  /** Read what it missed (`Hub.start`); false once closed. */
  begin(): boolean {
    if (this.closed) return false;
    const o = this.o;
    const log = this.log;
    // Ahead of the head is not "nothing missed": the log this cursor came from is not this one.
    if (o.fromSeq === undefined || o.fromSeq < log.floor(o.sessionKey) || o.fromSeq > log.head(o.sessionKey)) {
      const snap = log.snapshot(o.sessionKey);
      this.queue.push(snapshotEvent(projectSnapshot(snap, this.o.tier)));
      this.cursor = snap.seq;
    } else {
      this.cursor = o.fromSeq;
    }
    // Replay synchronously: appends are synchronous too, so nothing slips in between.
    this.catchUp();
    return true;
  }

  /** Called by the hub for every appended event, in seq order. */
  offer(e: SessionEvent): void {
    if (this.closed) return;
    if (isEphemeral(e)) {
      if (this.lagging || this.queue.length >= this.cap) this.dropped++;
      else this.push(e);
      return;
    }
    if (this.lagging) return;
    // Already read from the log (never expected: a subscriber made inside a batch starts after it).
    if (e.seq <= this.cursor) return;
    if (this.queue.length >= this.cap) {
      // Never drop a durable event: stop buffering and re-read from the log later.
      this.lagging = true;
      return;
    }
    this.cursor = e.seq;
    this.push(e);
  }

  private push(e: SessionEvent): void {
    if (this.closed) return;
    if (!isSnapshotEvent(e) && !passes(e, this.o.tier, this.o.filter, this.o.visibility)) return;
    const out = isSnapshotEvent(e) ? e : project(e, this.o.tier);
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      w({ value: out, done: false });
    } else this.queue.push(out);
  }

  private catchUp(): void {
    const key = this.o.sessionKey;
    if (this.cursor < this.log.floor(key)) {
      const snap = this.log.snapshot(key);
      this.queue.push(snapshotEvent(projectSnapshot(snap, this.o.tier)));
      this.cursor = snap.seq;
    }
    for (const e of this.log.read(key, this.cursor, this.cap)) {
      this.cursor = e.seq;
      this.push(e);
    }
    this.lagging = this.cursor < this.log.head(key);
  }

  private next(): Promise<IteratorResult<SessionEvent>> {
    // Filtered-out batches can leave the queue empty while still behind; keep reading.
    while (this.queue.length === 0 && this.lagging && !this.closed) {
      const before = this.cursor;
      this.catchUp();
      if (this.cursor === before) break;
    }
    const e = this.queue.shift();
    if (e) return Promise.resolve({ value: e, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => (this.waiter = resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lagging = false;
    this.detach();
    this.queue = [];
    const w = this.waiter;
    this.waiter = undefined;
    w?.({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return {
      next: () => this.next(),
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
