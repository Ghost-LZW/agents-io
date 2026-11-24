import { Type, type Static } from '@sinclair/typebox';
import { V } from './common.js';

/*
 * A session's attention (core-slimming G7, INVARIANTS LN-11): what is pending in it now, folded
 * from its log like the snapshot, so every host stops computing it for itself. Mechanism only: it
 * says what waits, never who to tell or how (badges, pushes, counts are the host's).
 * The fold is pinned by language-neutral fixtures (`packages/testkit/conformance/scenarios/attention/`).
 */

/**
 * - `needs_you`: a person is asked something (an open request whose resolver is `human`).
 * - `working`: a turn runs, inputs wait for one, or the harness says it is stalled.
 * - `failed`: the last turn failed, and nothing runs or waits.
 * - `idle`: none of these.
 */
export const AttentionState = Type.Union([Type.Literal('needs_you'), Type.Literal('working'), Type.Literal('failed'), Type.Literal('idle')]);
export type AttentionState = Static<typeof AttentionState>;

/** What is pending, one entry per open request and at most one of each other kind. */
export const AttentionReason = Type.Union([
  /**
   * A request put to a person: `request.opened` with a `human` resolver (also when a review escalates
   * to one), until `request.resolved`, or until its turn completes (the snapshot's `pendingRequests`
   * rule). `since`: when it was first put to a person.
   */
  Type.Object({
    kind: Type.Literal('request'),
    requestId: Type.String(),
    /** The request's own `kind` (`tool_approval`, `question`, …). */
    requestKind: Type.String(),
    title: Type.String(),
    since: Type.Number(),
  }),
  /**
   * The last turn completed `failed` (its `error.code`, when it gave one), until the next turn starts.
   * Only that turn's own `turn.completed` says how it ended: a late or repeated one changes nothing.
   */
  Type.Object({ kind: Type.Literal('failed'), turnId: Type.String(), code: Type.Optional(Type.String()), since: Type.Number() }),
  /** The last `session.state` said `stalled`, until another state or a turn starts or ends. */
  Type.Object({ kind: Type.Literal('stalled'), since: Type.Number() }),
  /**
   * Inputs admitted (`new_turn` or `queued`) and not yet started, consumed, cancelled or rejected
   * (the snapshot's `queued`), oldest first; `since`: when the first of them came while none waited.
   */
  Type.Object({ kind: Type.Literal('queued'), inputIds: Type.Array(Type.String()), since: Type.Number() }),
]);
export type AttentionReason = Static<typeof AttentionReason>;

export const Attention = Type.Object({
  state: AttentionState,
  /** Requests first (in the order they were put to a person), then `failed`, `stalled`, `queued`. */
  reasons: Type.Array(AttentionReason),
  /** When the session entered `state` (the `ts` of the event that moved it there); 0 while no event has. */
  since: Type.Number(),
  /**
   * The seq of the event that last changed this value (0: none has). Events that change nothing
   * leave it, so a value with a higher `seq` is newer, and an equal one is the same.
   */
  seq: Type.Number(),
  /** The turn that runs (`turn.started` / `turn.adopted` until its `turn.completed`). */
  turnId: Type.Optional(Type.String()),
});
export type Attention = Static<typeof Attention>;

/**
 * Daemon → host, no answer (feature `attention`; the host's `host.hello` asked `optIn: ["attention"]`):
 * a session's attention changed. Sent once per change, after the events that changed it commit, in
 * `attention.seq` order per session; a batch of events that commit together is told once.
 */
export const AttentionChanged = Type.Object({ v: V, type: Type.Literal('attention.changed'), sessionKey: Type.String(), attention: Attention });
export type AttentionChanged = Static<typeof AttentionChanged>;
