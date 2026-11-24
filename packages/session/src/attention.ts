import type { Attention, AttentionReason, AttentionState, SessionEvent } from '@agents-io/protocol';
import type { SessionSnapshot } from './log.js';

/*
 * The attention fold (core-slimming G7, INVARIANTS LN-11): what is pending in a session now, from
 * its log alone. The rules are the language-neutral fixtures' (`test/fixtures/attention/*.json`,
 * format in docs/design/core-slimming §3 G7/G8): an implementation in another language that passes
 * them computes the same value from the same events.
 */

type RequestReason = Extract<AttentionReason, { kind: 'request' }>;
type FailedReason = Extract<AttentionReason, { kind: 'failed' }>;
type StalledReason = Extract<AttentionReason, { kind: 'stalled' }>;
type QueuedReason = Extract<AttentionReason, { kind: 'queued' }>;

/** An attention taken apart; `compose` puts it together in the one order the wire has. */
interface Parts {
  requests: RequestReason[];
  failed?: FailedReason;
  stalled?: StalledReason;
  queued?: QueuedReason;
  turnId?: string;
}

/** A session before any event changed its attention. */
export function emptyAttention(): Attention {
  return { state: 'idle', reasons: [], since: 0, seq: 0 };
}

function partsOf(a: Attention): Parts {
  const p: Parts = { requests: [] };
  for (const r of a.reasons) {
    if (r.kind === 'request') p.requests.push(r);
    else if (r.kind === 'failed') p.failed = r;
    else if (r.kind === 'stalled') p.stalled = r;
    else p.queued = r;
  }
  if (a.turnId !== undefined) p.turnId = a.turnId;
  return p;
}

/** A person is asked > something runs or waits > the last turn failed > nothing. */
function stateOf(p: Parts): AttentionState {
  if (p.requests.length) return 'needs_you';
  if (p.turnId !== undefined || p.queued || p.stalled) return 'working';
  return p.failed ? 'failed' : 'idle';
}

function reasonsOf(p: Parts): AttentionReason[] {
  return [...p.requests, ...(p.failed ? [p.failed] : []), ...(p.stalled ? [p.stalled] : []), ...(p.queued ? [p.queued] : [])];
}

/** Plain JSON values (what an attention is made of) compared by value. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** `p` as the value after `e`, or `a` itself when nothing a reader sees changed (`seq` stays). */
function settle(a: Attention, p: Parts, e: Pick<SessionEvent, 'seq' | 'ts'>): Attention {
  const state = stateOf(p);
  const reasons = reasonsOf(p);
  if (state === a.state && p.turnId === a.turnId && same(reasons, a.reasons)) return a;
  return { state, reasons, since: state === a.state ? a.since : e.ts, seq: e.seq, ...(p.turnId !== undefined ? { turnId: p.turnId } : {}) };
}

function dropInputs(p: Parts, ids: readonly string[]): void {
  if (!p.queued) return;
  const left = p.queued.inputIds.filter((id) => !ids.includes(id));
  if (left.length === p.queued.inputIds.length) return;
  if (left.length) p.queued = { ...p.queued, inputIds: left };
  else delete p.queued;
}

/**
 * One event of a session's log folded into its attention. Pure: `a` is never changed; it comes back
 * as it is when the event changes nothing (so its `seq` stays the seq of the last change). The
 * rules (each the same as the snapshot's where the snapshot has the same thing):
 *
 * - `request.opened` (not `internal`) whose resolver is `human`: a `request` reason, upserted by
 *   `requestId` (a re-open keeps its place and `since`); with another resolver (a review that has
 *   not escalated, `auto`, `host`) it is none, and a re-open that is no longer `human` removes it.
 *   `request.resolved` removes it.
 * - `input.admitted` `new_turn` / `queued`: the input waits (`queued`); `input.consumed`,
 *   `input.cancelled`, `input.rejected` and the `inputIds` of `turn.started` / `turn.adopted` end that.
 * - `turn.started` / `turn.adopted`: the turn runs (`turnId`); the last turn's `failed` and any
 *   `stalled` end. `turn.completed` of that turn: it no longer runs, its requests end with it,
 *   `stalled` ends; `failed` if its status is `failed`, else no `failed`. With no turn running (a
 *   late or repeated report): the requests and `stalled` end (as the snapshot's), `failed` stays as
 *   it was. A `turn.completed` of another turn while one runs changes nothing.
 * - `session.state` `stalled`: `stalled`; any other state ends it.
 *
 * `state` follows from the reasons (`needs_you` > `working` > `failed` > `idle`); `since` is the
 * `ts` of the event that moved it to its `state`; `seq` the seq of the event that last changed it.
 */
export function foldAttention(a: Attention, e: Pick<SessionEvent, 'seq' | 'ts' | 'body' | 'visibility'>): Attention {
  const b = e.body;
  // Every event of the log comes through here (deltas too): the others are done with at once.
  if (!FOLDED.has(b.t)) return a;
  const p = partsOf(a);
  switch (b.t) {
    case 'session.state':
      if (b.state === 'stalled') p.stalled ??= { kind: 'stalled', since: e.ts };
      else delete p.stalled;
      break;
    case 'input.admitted':
      if (b.disposition !== 'new_turn' && b.disposition !== 'queued') return a;
      if (p.queued?.inputIds.includes(b.inputId)) return a;
      p.queued = p.queued ? { ...p.queued, inputIds: [...p.queued.inputIds, b.inputId] } : { kind: 'queued', inputIds: [b.inputId], since: e.ts };
      break;
    case 'input.consumed':
    case 'input.cancelled':
    case 'input.rejected':
      dropInputs(p, b.inputIds);
      break;
    case 'turn.started':
    case 'turn.adopted':
      p.turnId = b.turnId;
      dropInputs(p, b.inputIds);
      delete p.failed;
      delete p.stalled;
      break;
    case 'turn.completed':
      if (p.turnId !== undefined && p.turnId !== b.turnId) return a;
      // With none running (a late or repeated report of a turn already over): requests and a stall
      // end, as in the snapshot; how the last turn ended stays.
      if (p.turnId !== undefined) {
        if (b.status === 'failed') p.failed = { kind: 'failed', turnId: b.turnId, ...(b.error?.code !== undefined ? { code: b.error.code } : {}), since: e.ts };
        else delete p.failed;
      }
      delete p.turnId;
      p.requests = [];
      delete p.stalled;
      break;
    case 'request.opened': {
      // As the snapshot's pendingRequests: an `internal` request is nobody's to see.
      if (e.visibility === 'internal') return a;
      const i = p.requests.findIndex((r) => r.requestId === b.requestId);
      if (b.resolver?.kind === 'human') {
        const r: RequestReason = { kind: 'request', requestId: b.requestId, requestKind: b.kind, title: b.title, since: i >= 0 ? p.requests[i]!.since : e.ts };
        if (i >= 0) p.requests[i] = r;
        else p.requests.push(r);
      } else if (i >= 0) p.requests.splice(i, 1);
      break;
    }
    case 'request.resolved':
      p.requests = p.requests.filter((r) => r.requestId !== b.requestId);
      break;
  }
  return settle(a, p, e);
}

/** The event kinds the fold reads; every other leaves the attention as it is. */
const FOLDED: ReadonlySet<SessionEvent['body']['t']> = new Set<SessionEvent['body']['t']>([
  'session.state',
  'input.admitted',
  'input.consumed',
  'input.cancelled',
  'input.rejected',
  'turn.started',
  'turn.adopted',
  'turn.completed',
  'request.opened',
  'request.resolved',
]);

/**
 * The attention of a snapshot stored before snapshots carried one (a log compacted by an older
 * version): what the snapshot shows (its human requests, queued inputs, running turn, a `stalled`
 * state), with every `since` unknown (0) and `seq` the snapshot's. Whether its last turn failed is
 * not in it: none.
 */
export function attentionFromSnapshot(s: Omit<SessionSnapshot, 'attention'>): Attention {
  const p: Parts = {
    requests: s.pendingRequests
      .filter((r) => r.resolver?.kind === 'human')
      .map((r): RequestReason => ({ kind: 'request', requestId: r.requestId, requestKind: r.kind, title: r.title, since: 0 })),
    ...(s.queued.length ? { queued: { kind: 'queued', inputIds: [...s.queued], since: 0 } } : {}),
    ...(s.state === 'stalled' ? { stalled: { kind: 'stalled', since: 0 } } : {}),
    ...(s.turn ? { turnId: s.turn.turnId } : {}),
  };
  return { state: stateOf(p), reasons: reasonsOf(p), since: 0, seq: s.seq, ...(p.turnId !== undefined ? { turnId: p.turnId } : {}) };
}
