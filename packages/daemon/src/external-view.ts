import type { KernelContext, KernelSubscription, SessionEvent } from '@agents-io/protocol';
import { withholding } from '@agents-io/session';

/*
 * A session's events as a reader outside the daemon may see them while they come (the north
 * projections, core-slimming G9): U20 (INVARIANTS DL-7) for a live stream. Nothing of a checked turn
 * reaches the reader before its answer is past the host's exit check: an event `withholding` withholds
 * waits, and so does everything after it (the order stays the log's), until the check releases it;
 * one held for good is dropped (its text never reaches the reader). Withheld ephemeral events (text
 * deltas) are dropped, not kept: a checked turn does not stream (DL-7), and its snapshot says it all.
 * While no event of the log is checked (no `outbound.scoped` host ever declared a scope that took a
 * turn of this session), events go through as they come, unread.
 */

/** Events that a checked turn may make withheld (`withholding`); every other kind never is. */
const MAY_WITHHOLD = new Set<string>(['text.delta', 'text.snapshot', 'item.started', 'item.completed', 'item.progress', 'headline', 'native', 'request.opened', 'input.admitted']);

/** An event that makes the log's later events checked (`withholding` reads them). */
function checks(e: SessionEvent): boolean {
  const b = e.body;
  if (b.t === 'turn.started' || b.t === 'turn.adopted' || b.t === 'turn.delivery_added') return b.checked === true;
  return b.t === 'topic.changed' && b.check !== undefined;
}

/**
 * A session's durable events from `fromSeq` as an external reader may read them now (U20): those
 * shown, and those still withheld (`checking`; give them to an `ExternalView` as `waiting`). Held
 * ones are left out.
 */
export function replay(k: KernelContext, sessionKey: string, fromSeq: number): { shown: SessionEvent[]; waiting: SessionEvent[]; head: number } {
  const all = k.events(sessionKey, 0);
  const head = all.at(-1)?.seq ?? 0;
  const from = all.filter((e) => e.seq > fromSeq);
  const w = withholding(all);
  if (w.none) return { shown: from, waiting: [], head };
  const shown: SessionEvent[] = [];
  const waiting: SessionEvent[] = [];
  for (const e of from) {
    const s = w.of(e);
    // In the log's order: after the first one still checking, everything waits.
    if (waiting.length || s === 'checking') waiting.push(e);
    else if (s === undefined) shown.push(e);
  }
  return { shown, waiting, head };
}

/** A subscription's events through the U20 gate: iterate it; `close` ends it. */
export class ExternalView implements AsyncIterable<SessionEvent> {
  private readonly sub: KernelSubscription;
  private active: boolean;
  private readonly waiting: SessionEvent[] = [];
  private closed = false;

  /**
   * From `fromSeq` (as `KernelContext.subscribe`). `waiting`: events before it still withheld when
   * the reader read them (`replay`), given once released, before what comes after.
   */
  constructor(
    private readonly k: KernelContext,
    private readonly sessionKey: string,
    o: { fromSeq?: number; waiting?: readonly SessionEvent[] } = {},
  ) {
    this.active = this.k.events(sessionKey, 0).some(checks);
    this.waiting.push(...(o.waiting ?? []));
    this.sub = k.subscribe(sessionKey, o.fromSeq !== undefined ? { fromSeq: o.fromSeq } : {});
  }

  close(): void {
    this.closed = true;
    this.sub.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    for await (const e of this.sub) {
      if (this.closed) return;
      if (!this.active && checks(e)) this.active = true;
      if (!this.active || (!this.waiting.length && !MAY_WITHHOLD.has(e.body.t))) {
        yield e;
        continue;
      }
      // Read the log as it is now: what is withheld, and what was released since.
      const w = withholding(this.k.events(this.sessionKey, 0));
      if (w.none) {
        yield* this.waiting.splice(0);
        yield e;
        continue;
      }
      const state = w.of(e);
      if (state === undefined || e.durability !== 'ephemeral') this.waiting.push(e);
      while (this.waiting.length) {
        const s = w.of(this.waiting[0]!);
        if (s === 'checking') break;
        const next = this.waiting.shift()!;
        if (s === undefined) yield next;
      }
    }
  }
}
