import { HarnessEvent, errors, type InputRecord } from '@agents-io/protocol';

export interface StreamViolation {
  index: number;
  rule: string;
  message: string;
}

export interface CheckOptions {
  /** Inputs handed to each turn, to verify `input.consumed` only names real inputs. */
  turnInputs?: Record<string, string[]> | ((turnId: string) => string[] | undefined);
  /** Allow events to arrive after `close()` started (default false). */
  allowTrailing?: boolean;
}

/**
 * Checks the invariants every harness adapter's event stream must hold, whatever
 * the harness. Returns an empty array for a conforming stream.
 *
 *  - every event matches the HarnessEvent schema;
 *  - turns are started once, completed once, and nothing references a turn before
 *    it starts or after it completes;
 *  - turns do not overlap (the session layer owns the queue);
 *  - every started item completes, unless its turn ended other than `completed`;
 *  - every opened request resolves, unless its turn ended other than `completed`;
 *  - `input.consumed` names only inputs given to that turn;
 *  - ephemeral events are only deltas, progress, headlines, snapshots or native passthrough.
 */
export function checkEventStream(events: readonly unknown[], opts: CheckOptions = {}): StreamViolation[] {
  const out: StreamViolation[] = [];
  const v = (index: number, rule: string, message: string) => out.push({ index, rule, message });

  const started = new Set<string>();
  const completed = new Map<string, string>();
  const openItems = new Map<string, { turnId?: string; index: number }>();
  const openRequests = new Map<string, { turnId?: string; index: number }>();
  let active: string | undefined;

  const inputsOf = (turnId: string) =>
    typeof opts.turnInputs === 'function' ? opts.turnInputs(turnId) : opts.turnInputs?.[turnId];

  events.forEach((raw, i) => {
    const errs = errors(HarnessEvent, raw);
    if (errs.length) {
      v(i, 'schema', errs.slice(0, 3).join('; '));
      return;
    }
    const e = raw as HarnessEvent;
    const b = e.body;

    if (e.durability === 'ephemeral' && !['text.delta', 'item.progress', 'headline', 'text.snapshot', 'native'].includes(b.t)) {
      v(i, 'ephemeral', `${b.t} must be durable`);
    }

    if (b.t === 'turn.started' || b.t === 'turn.adopted') {
      if (started.has(b.turnId)) v(i, 'turn.once', `turn ${b.turnId} started twice`);
      if (active) v(i, 'turn.overlap', `turn ${b.turnId} started while ${active} is active`);
      if (e.turnId && e.turnId !== b.turnId) v(i, 'turn.id', 'envelope turnId differs from body turnId');
      started.add(b.turnId);
      active = b.turnId;
      return;
    }

    const turnId = e.turnId ?? (b.t === 'turn.completed' || b.t === 'input.consumed' ? b.turnId : undefined);
    if (turnId) {
      if (!started.has(turnId)) v(i, 'turn.order', `${b.t} for turn ${turnId} before turn.started`);
      else if (completed.has(turnId) && b.t !== 'delivery.settled' && b.t !== 'render.anchor')
        v(i, 'turn.order', `${b.t} for turn ${turnId} after turn.completed`);
    }

    switch (b.t) {
      case 'turn.completed': {
        if (completed.has(b.turnId)) v(i, 'turn.once', `turn ${b.turnId} completed twice`);
        completed.set(b.turnId, b.status);
        if (active === b.turnId) active = undefined;
        for (const [id, it] of openItems) {
          if (it.turnId === b.turnId) {
            if (b.status === 'completed') v(it.index, 'item.complete', `item ${id} never completed`);
            openItems.delete(id);
          }
        }
        for (const [id, r] of openRequests) {
          if (r.turnId === b.turnId) {
            if (b.status === 'completed') v(r.index, 'request.resolve', `request ${id} never resolved`);
            openRequests.delete(id);
          }
        }
        break;
      }
      case 'item.started':
        if (openItems.has(b.item.itemId)) v(i, 'item.once', `item ${b.item.itemId} started twice`);
        openItems.set(b.item.itemId, { turnId: e.turnId, index: i });
        break;
      case 'item.completed':
        if (!openItems.delete(b.item.itemId)) {
          // completing without start is allowed for one-shot items, but not twice
        }
        if (b.item.status === 'running') v(i, 'item.status', `item ${b.item.itemId} completed with status running`);
        break;
      case 'request.opened':
        openRequests.set(b.requestId, { turnId: e.turnId, index: i });
        break;
      case 'request.resolved':
        if (!openRequests.delete(b.requestId)) v(i, 'request.order', `request ${b.requestId} resolved but never opened`);
        break;
      case 'input.consumed': {
        const given = inputsOf(b.turnId);
        if (given) for (const id of b.inputIds) if (!given.includes(id)) v(i, 'input.consumed', `unknown input ${id}`);
        break;
      }
    }
  });

  if (!opts.allowTrailing && active) out.push({ index: events.length, rule: 'turn.complete', message: `turn ${active} never completed` });
  return out;
}

/** Convenience for tests: throws with all violations listed. */
export function assertConformingStream(events: readonly unknown[], opts?: CheckOptions): void {
  const vs = checkEventStream(events, opts);
  if (vs.length) throw new Error('non-conforming event stream:\n' + vs.map((x) => `  #${x.index} [${x.rule}] ${x.message}`).join('\n'));
}

export type { InputRecord };
