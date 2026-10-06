import {
  routeKey,
  type ChannelAdapter,
  type Policy,
  type RenderedMessage,
  type ReplyRoute,
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

/** Where settled deliveries are remembered. Must be durable for idempotency across restarts. */
export interface OutboxStore {
  get(operationId: string): DeliveryRecord | undefined;
  put(rec: DeliveryRecord): void;
}

export class MemoryOutboxStore implements OutboxStore {
  private m = new Map<string, DeliveryRecord>();
  get(id: string) {
    return this.m.get(id);
  }
  put(rec: DeliveryRecord) {
    this.m.set(rec.operationId, rec);
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
  sleep?: (ms: number) => Promise<void>;
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
 * the attempt runs again only while the outcome is still open. Retries use
 * exponential backoff; an outcome that stays unclear is `unknown` and never replayed.
 */
export class Outbox {
  private readonly store: OutboxStore;
  private inflight = new Map<string, Promise<DeliveryRecord>>();

  constructor(private readonly o: OutboxOptions = {}) {
    this.store = o.store ?? new MemoryOutboxStore();
  }

  get(operationId: string): DeliveryRecord | undefined {
    return this.store.get(operationId);
  }

  deliver(d: Delivery, attempt: (n: number) => Promise<SendResult | void>): Promise<DeliveryRecord> {
    const done = this.store.get(d.operationId);
    if (done) return Promise.resolve(done);
    const running = this.inflight.get(d.operationId);
    if (running) return running;
    const p = this.run(d, attempt).finally(() => this.inflight.delete(d.operationId));
    this.inflight.set(d.operationId, p);
    return p;
  }

  /** `deliver` around `adapter.send`. The adapter also gets the operationId for its own dedup. */
  send(adapter: ChannelAdapter, d: Delivery & { msg: RenderedMessage; as?: string }): Promise<DeliveryRecord> {
    return this.deliver(d, () => adapter.send(d.route, d.msg, { operationId: d.operationId, ...(d.as !== undefined ? { as: d.as } : {}) }));
  }

  private async run(d: Delivery, attempt: (n: number) => Promise<SendResult | void>): Promise<DeliveryRecord> {
    const max = this.o.maxAttempts ?? 5;
    const base = this.o.baseDelayMs ?? 200;
    const cap = this.o.maxDelayMs ?? 10_000;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const rec: DeliveryRecord = { operationId: d.operationId, sessionKey: d.sessionKey, route: d.route, status: 'unknown', attempts: 0 };

    if (d.from !== undefined && this.o.policy?.outbound) {
      const verdict = await this.o.policy.outbound({ from: d.from, to: d.route });
      if (verdict !== 'allow') return this.settle(d, { ...rec, status: 'rejected', error: `outbound denied: ${routeKey(d.route)}` });
    }

    for (let n = 1; n <= max; n++) {
      rec.attempts = n;
      try {
        const r = await attempt(n);
        return this.settle(d, {
          ...rec,
          status: 'delivered',
          ...(r && r.providerMessageId !== undefined ? { providerMessageId: r.providerMessageId } : {}),
        });
      } catch (err) {
        rec.error = err instanceof Error ? err.message : String(err);
        if ((err as { retryable?: unknown })?.retryable === false) return this.settle(d, { ...rec, status: 'rejected' });
        if (n < max) await sleep(Math.min(cap, base * 2 ** (n - 1)));
      }
    }
    return this.settle(d, rec);
  }

  private settle(d: Delivery, rec: DeliveryRecord): DeliveryRecord {
    this.store.put(rec);
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
