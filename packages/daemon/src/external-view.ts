import type { KernelContext, KernelSubscription, SessionEvent } from '@agents-io/protocol';
import { passes, withholding, withholdingFold } from '@agents-io/session';

/*
 * A session's events as a reader outside the daemon may see them while they come (the north
 * projections, core-slimming G9): U20 (INVARIANTS DL-7) for a live stream. Nothing of a checked turn
 * reaches the reader before its answer is past the host's exit check: an event `withholding` withholds
 * waits, and so does everything after it (the order stays the log's), until the check releases it;
 * one held for good is dropped (its text never reaches the reader). Withheld ephemeral events (text
 * deltas) are dropped, not kept: a checked turn does not stream (DL-7), and its snapshot says it all.
 * While no event of the log is checked (no `outbound.scoped` host ever declared a scope that took a
 * turn of this session), events go through as they come. The log is read once, as the view starts;
 * after that what is withheld is folded in as the durable events come (`withholdingFold`), so an
 * ephemeral event (a text delta) is decided without reading the log.
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
 * ones are left out, and so are `internal` ones: what the live view never gives
 * (`KernelContext.subscribe`'s default visibility), a replay does not either.
 */
export function replay(k: KernelContext, sessionKey: string, fromSeq: number): { shown: SessionEvent[]; waiting: SessionEvent[]; head: number } {
  const all = k.events(sessionKey, 0);
  const head = all.at(-1)?.seq ?? 0;
  const from = all.filter((e) => e.seq > fromSeq && passes(e, 'full'));
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
  /** What the log withholds, folded as far as it was read: up to `folded`, its last seq. */
  private readonly fold = withholdingFold();
  private folded = 0;
  /** Some event folded in is checked: from then on events go through the gate. */
  private active = false;
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
    this.read();
    this.waiting.push(...(o.waiting ?? []));
    this.sub = k.subscribe(sessionKey, o.fromSeq !== undefined ? { fromSeq: o.fromSeq } : {});
  }

  close(): void {
    this.closed = true;
    this.sub.close();
  }

  /** Fold in what the log has after `folded`. */
  private read(): void {
    for (const e of this.k.events(this.sessionKey, this.folded)) this.take(e);
  }

  private take(e: SessionEvent): void {
    if (e.seq <= this.folded) return;
    this.folded = e.seq;
    this.fold.push(e);
    if (!this.active && checks(e)) this.active = true;
  }

  /**
   * The log folded up to `e` before it is decided. A durable event next in seq is folded as it
   * came; past a gap (events the subscription does not give, `internal` ones) the log is read from
   * `folded`. An ephemeral event carries the seq of the durable one before it, already folded in:
   * nothing is read for it.
   */
  private advance(e: SessionEvent): void {
    if (e.seq <= this.folded) return;
    if (e.durability !== 'ephemeral' && e.seq === this.folded + 1) this.take(e);
    else this.read();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    for await (const e of this.sub) {
      if (this.closed) return;
      this.advance(e);
      if (!this.active || (!this.waiting.length && !MAY_WITHHOLD.has(e.body.t))) {
        yield e;
        continue;
      }
      // The log as folded up to `e`: what is withheld, and what was released since.
      const w = this.fold;
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
