import { PROTOCOL_VERSION, type SessionEvent, type Tier } from '@agents-io/protocol';
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

export interface SubscribeOptions {
  sessionKey: string;
  /**
   * Last seq the subscriber has seen. Omitted: start with a snapshot (late joiner).
   * Behind the log's floor: snapshot, then everything after it. Otherwise replay
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

/** Fan-out over a `SessionLog`. All writes to a session go through `append`. */
export class Hub {
  private subs = new Map<string, Set<Sub>>();

  constructor(
    readonly log: SessionLog,
    private readonly opts: { bufferSize?: number } = {},
  ) {}

  append(sessionKey: string, draft: EventDraft): SessionEvent {
    const e = this.log.append(sessionKey, draft);
    for (const s of this.subs.get(sessionKey) ?? []) s.offer(e);
    return e;
  }

  snapshot(sessionKey: string): SessionSnapshot {
    return this.log.snapshot(sessionKey);
  }

  subscribe(o: SubscribeOptions): Subscription {
    const sub = new Sub(this.log, o, o.bufferSize ?? this.opts.bufferSize ?? 1024, () => this.subs.get(o.sessionKey)?.delete(sub));
    let set = this.subs.get(o.sessionKey);
    if (!set) this.subs.set(o.sessionKey, (set = new Set()));
    set.add(sub);
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
    const head = log.head(o.sessionKey);
    if (o.fromSeq === undefined || o.fromSeq < log.floor(o.sessionKey)) {
      const snap = log.snapshot(o.sessionKey);
      this.queue.push(snapshotEvent(snap));
      this.cursor = snap.seq;
    } else {
      this.cursor = Math.min(o.fromSeq, head);
    }
    // Replay synchronously: appends are synchronous too, so nothing slips in between.
    this.catchUp();
    o.signal?.addEventListener('abort', () => this.close(), { once: true });
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
    if (this.queue.length >= this.cap) {
      // Never drop a durable event: stop buffering and re-read from the log later.
      this.lagging = true;
      return;
    }
    this.cursor = e.seq;
    this.push(e);
  }

  private push(e: SessionEvent): void {
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
      this.queue.push(snapshotEvent(snap));
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
    while (this.queue.length === 0 && this.lagging) {
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
