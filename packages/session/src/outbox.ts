import {
  routeKey,
  type ChannelAdapter,
  type Policy,
  type RenderedMessage,
  type ReplyRoute,
  type SendOp,
  type SendResult,
  type TurnContext,
} from '@agents-io/protocol';
import type { Hub } from './hub.js';

export type DeliveryStatus = 'delivered' | 'rejected' | 'unknown';

export interface DeliveryRecord {
  operationId: string;
  sessionKey: string;
  route: ReplyRoute;
  status: DeliveryStatus;
  attempts: number;
  providerMessageId?: string;
  error?: string;
}

/**
 * An attempt that has started and not settled yet. Written before the adapter is
 * called, so a process that dies mid-send leaves it behind: the next process
 * settles it as `unknown` and never sends it again (decision 13).
 */
export interface InFlightDelivery {
  operationId: string;
  sessionKey: string;
  route: ReplyRoute;
  turnId?: string;
  /** The attempt that was started (1-based). */
  attempts: number;
  startedAt: number;
}

/**
 * Where deliveries are remembered: settled outcomes and in-flight marks. Must be
 * durable for idempotency across restarts (the daemon keeps it in its SQLite records).
 */
export interface OutboxStore {
  /** The settled outcome of an operation. */
  get(operationId: string): DeliveryRecord | undefined;
  /** Settle: write the outcome and drop the operation's in-flight mark. */
  put(rec: DeliveryRecord): void;
  /** Mark an attempt as started, before the adapter is called (replaces an earlier mark). */
  begin(rec: InFlightDelivery): void;
  /** The in-flight mark of an operation that has no settled outcome. */
  inFlight(operationId: string): InFlightDelivery | undefined;
  /** Every in-flight mark that has no settled outcome. */
  allInFlight(): InFlightDelivery[];
}

export class MemoryOutboxStore implements OutboxStore {
  private m = new Map<string, DeliveryRecord>();
  private f = new Map<string, InFlightDelivery>();
  get(id: string) {
    return this.m.get(id);
  }
  put(rec: DeliveryRecord) {
    this.m.set(rec.operationId, rec);
    this.f.delete(rec.operationId);
  }
  begin(rec: InFlightDelivery) {
    this.f.set(rec.operationId, rec);
  }
  inFlight(id: string) {
    return this.m.has(id) ? undefined : this.f.get(id);
  }
  allInFlight() {
    return [...this.f.values()].filter((r) => !this.m.has(r.operationId));
  }
}

/** Throw this (or any error with `retryable: false`) from an attempt to stop retrying. */
export class DeliveryRejected extends Error {
  readonly retryable = false;
}

export interface OutboxOptions {
  /** Where `delivery.settled` events are written. */
  hub?: Hub;
  store?: OutboxStore;
  /** Checked when a delivery names the turn it comes from (agent-initiated sends). */
  policy?: Pick<Policy, 'outbound'>;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Upper bound of one attempt (default 60 s). An attempt that runs out settles as
   * `unknown` without a retry: the platform may have received it.
   */
  attemptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Every settled outcome of a delivery (not a duplicate answered from the store), e.g. to
   * index which turn sent which platform message (agent-messaging §4.3.3) and to explain a
   * side effect by its operationId. Errors are ignored.
   */
  onSettled?: (d: Pick<Delivery, 'sessionKey' | 'turnId'>, rec: DeliveryRecord) => void;
  /** The chain position an agent-authored send (`as` set) carries out-of-band (`SendOp.cause`). */
  causeOf?: (d: Delivery) => SendOp['cause'] | undefined;
}

export interface Delivery {
  operationId: string;
  sessionKey: string;
  route: ReplyRoute;
  turnId?: string;
  /**
   * The turn this send comes from. When given, `Policy.outbound` must allow the
   * destination. Leave out for the turn's own reply route rendering.
   */
  from?: TurnContext | null;
}

/**
 * Delivery obligations: one operationId produces at most one settled outcome, and
 * the attempt runs again only while the outcome is still open. Each attempt is
 * marked in flight in the store before the adapter is called; a mark left by a
 * process that died is settled as `unknown` (by `recover`, or by the next
 * `deliver` of that id) and never replayed. Retries use exponential backoff; an
 * outcome that stays unclear (retries run out, an attempt times out) is `unknown`.
 */
export class Outbox {
  private readonly store: OutboxStore;
  private inflight = new Map<string, Promise<DeliveryRecord>>();
  private draining = false;
  private closed = false;
  private wake!: () => void;
  /** Resolves when stopping begins: retries waiting in backoff stop waiting. */
  private readonly stopping = new Promise<void>((r) => (this.wake = r));

  constructor(private readonly o: OutboxOptions = {}) {
    this.store = o.store ?? new MemoryOutboxStore();
  }

  /** The settled outcome of an operation (one in flight has none yet). */
  get(operationId: string): DeliveryRecord | undefined {
    return this.store.get(operationId);
  }

  deliver(d: Delivery, attempt: (n: number) => Promise<SendResult | void>): Promise<DeliveryRecord> {
    const done = this.store.get(d.operationId);
    if (done) return Promise.resolve(done);
    const running = this.inflight.get(d.operationId);
    if (running) return running;
    // Nothing is sent and nothing recorded: the store may be closed already.
    if (this.closed) return Promise.resolve({ operationId: d.operationId, sessionKey: d.sessionKey, route: d.route, status: 'rejected', attempts: 0, error: 'outbox closed' });
    // Marked in flight by an earlier process (not recovered yet): unknown, never resent.
    const stale = this.store.inFlight(d.operationId);
    if (stale) return Promise.resolve(this.settleStale(stale));
    const p = this.run(d, attempt).finally(() => this.inflight.delete(d.operationId));
    this.inflight.set(d.operationId, p);
    return p;
  }

  /** `deliver` around `adapter.send`. The adapter also gets the operationId for its own dedup. */
  send(adapter: ChannelAdapter, d: Delivery & { msg: RenderedMessage; as?: string }): Promise<DeliveryRecord> {
    return this.deliver(d, () => {
      const cause = d.as !== undefined ? this.o.causeOf?.(d) : undefined;
      return adapter.send(d.route, d.msg, { operationId: d.operationId, ...(d.as !== undefined ? { as: d.as } : {}), ...(cause ? { cause } : {}) });
    });
  }

  /**
   * Settle every in-flight mark an earlier process left (the platform may or may
   * not have received it) as `unknown`, with `delivery.settled` in its session.
   * Nothing is resent. Call once at start.
   */
  recover(): DeliveryRecord[] {
    return this.store
      .allInFlight()
      .filter((r) => !this.inflight.has(r.operationId))
      .map((r) => this.settleStale(r));
  }

  /**
   * Stopping: no more retries (a delivery waiting for one settles `unknown` now),
   * and wait at most `ms` for the attempts that are running. One still running
   * after that keeps its in-flight mark and the next `recover` settles it.
   */
  async drain(ms: number): Promise<void> {
    this.draining = true;
    this.wake();
    const all = Promise.all([...this.inflight.values()].map((p) => p.catch(() => undefined)));
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise((r) => (t = setTimeout(r, ms)))]);
    clearTimeout(t);
  }

  /** The store and the log are about to close: nothing is written any more, new deliveries are refused. */
  close(): void {
    this.draining = true;
    this.closed = true;
    this.wake();
  }

  private settleStale(r: InFlightDelivery): DeliveryRecord {
    return this.settle(
      { sessionKey: r.sessionKey, ...(r.turnId !== undefined ? { turnId: r.turnId } : {}) },
      { operationId: r.operationId, sessionKey: r.sessionKey, route: r.route, status: 'unknown', attempts: r.attempts, error: 'in flight when the previous process stopped; not resent' },
    );
  }

  private async run(d: Delivery, attempt: (n: number) => Promise<SendResult | void>): Promise<DeliveryRecord> {
    const max = this.o.maxAttempts ?? 5;
    const base = this.o.baseDelayMs ?? 200;
    const cap = this.o.maxDelayMs ?? 10_000;
    const timeout = this.o.attemptTimeoutMs ?? 60_000;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const rec: DeliveryRecord = { operationId: d.operationId, sessionKey: d.sessionKey, route: d.route, status: 'unknown', attempts: 0 };

    if (d.from !== undefined && this.o.policy?.outbound) {
      let verdict: string;
      try {
        verdict = await this.o.policy.outbound({ from: d.from, to: d.route });
      } catch (err) {
        // Fail closed: a check that cannot answer denies.
        return this.settle(d, { ...rec, status: 'rejected', error: `outbound check failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      if (verdict !== 'allow') return this.settle(d, { ...rec, status: 'rejected', error: `outbound denied: ${routeKey(d.route)}` });
    }

    for (let n = 1; n <= max; n++) {
      // Closed while waiting (policy check): never sent, and there is no store to mark in.
      if (this.closed) return { ...rec, status: 'rejected', error: 'outbox closed' };
      rec.attempts = n;
      this.store.begin({
        operationId: d.operationId,
        sessionKey: d.sessionKey,
        route: d.route,
        ...(d.turnId !== undefined ? { turnId: d.turnId } : {}),
        attempts: n,
        startedAt: Date.now(),
      });
      try {
        const r = await withTimeout(Promise.resolve().then(() => attempt(n)), timeout);
        // The platform may have it: unknown, not retried.
        if (r === TIMED_OUT) return this.settle(d, { ...rec, error: `attempt ${n} timed out after ${timeout} ms` });
        return this.settle(d, {
          ...rec,
          status: 'delivered',
          ...(r && r.providerMessageId !== undefined ? { providerMessageId: r.providerMessageId } : {}),
        });
      } catch (err) {
        rec.error = err instanceof Error ? err.message : String(err);
        if ((err as { retryable?: unknown })?.retryable === false) return this.settle(d, { ...rec, status: 'rejected' });
        if (n < max) {
          if (!this.draining) await Promise.race([sleep(Math.min(cap, base * 2 ** (n - 1))), this.stopping]);
          if (this.draining) return this.settle(d, { ...rec, error: `${rec.error}; not retried: stopping` });
        }
      }
    }
    return this.settle(d, rec);
  }

  private settle(d: Pick<Delivery, 'sessionKey' | 'turnId'>, rec: DeliveryRecord): DeliveryRecord {
    // Closed: the in-flight mark stays, and the next process settles it as unknown.
    if (this.closed) return rec;
    this.store.put(rec);
    try {
      this.o.onSettled?.(d, rec);
    } catch {
      // an index is best effort; the outcome is recorded
    }
    this.o.hub?.append(d.sessionKey, {
      ts: Date.now(),
      ...(d.turnId !== undefined ? { turnId: d.turnId } : {}),
      level: 'detail',
      audience: 'status',
      durability: 'durable',
      visibility: 'operators',
      body: {
        t: 'delivery.settled',
        operationId: rec.operationId,
        route: rec.route,
        result: rec.status,
        ...(rec.providerMessageId !== undefined ? { providerMessageId: rec.providerMessageId } : {}),
      },
    });
    return rec;
  }
}

const TIMED_OUT = Symbol('timed out');

/** `p`, or `TIMED_OUT` after `ms`. A late outcome of `p` is ignored (a late rejection too). */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  p.catch(() => undefined);
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TIMED_OUT>((r) => (t = setTimeout(() => r(TIMED_OUT), ms)))]);
  } finally {
    clearTimeout(t);
  }
}
