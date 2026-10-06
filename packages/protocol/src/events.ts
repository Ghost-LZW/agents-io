import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ReplyRoute, V } from './common.js';
import { RunSpec } from './run.js';
import { Decision, RequestQuestion, ResolvedBy, Resolver } from './requests.js';
import { InputRecord } from './inbound.js';

export const Tier = Type.Union([Type.Literal('full'), Type.Literal('card'), Type.Literal('headline'), Type.Literal('final')]);
export type Tier = Static<typeof Tier>;

export const Level = Type.Union([Type.Literal('primary'), Type.Literal('detail'), Type.Literal('debug')]);
export type Level = Static<typeof Level>;

export const ItemSummary = Type.Object({
  itemId: Type.String(),
  type: Type.Union([
    Type.Literal('command'),
    Type.Literal('file_change'),
    Type.Literal('mcp_tool'),
    Type.Literal('tool'),
    Type.Literal('subagent'),
    Type.Literal('web_search'),
    Type.Literal('hook'),
    Type.Literal('compaction'),
    Type.Literal('user_message'),
    Type.Literal('agent_message'),
    Type.Literal('reasoning'),
  ]),
  title: Type.String(),
  status: Type.Union([
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('declined'),
    Type.Literal('skipped'),
  ]),
  inputSummary: Type.Optional(Type.String()),
  result: Type.Optional(
    Type.Object({ preview: Type.String(), truncated: Type.Union([Type.Boolean(), Type.Null()]), isError: Type.Boolean() }),
  ),
});
export type ItemSummary = Static<typeof ItemSummary>;

const T = <K extends string, P extends Record<string, TSchema>>(t: K, props: P) =>
  Type.Object({ t: Type.Literal(t), ...props });

const TurnStatus = Type.Union([
  Type.Literal('completed'),
  Type.Literal('interrupted'),
  Type.Literal('failed'),
  /** Outcome unknown (e.g. harness died mid-turn). Never auto-retried. */
  Type.Literal('ambiguous'),
]);

/** Event bodies. Unknown harness events go through `native` (full tier only). */
export const Body = Type.Union([
  T('session.state', {
    state: Type.Union([
      Type.Literal('idle'),
      Type.Literal('running'),
      Type.Literal('requires_action'),
      Type.Literal('stalled'),
      Type.Literal('error'),
    ]),
  }),
  T('input.admitted', {
    inputId: Type.String(),
    disposition: Type.Union([
      Type.Literal('new_turn'),
      Type.Literal('steer'),
      Type.Literal('queued'),
      Type.Literal('observe_only'),
    ]),
    principalId: Type.Optional(Type.String()),
    /** The admitted input itself, so a log replay can rebuild the queue. */
    input: Type.Optional(InputRecord),
  }),
  /** Reconciled from the harness (Claude user_message_uuids / Codex userMessage.clientId). */
  T('input.consumed', { inputIds: Type.Array(Type.String()), turnId: Type.String() }),
  T('input.cancelled', { inputIds: Type.Array(Type.String()), reason: Type.String() }),
  T('input.rejected', { inputIds: Type.Array(Type.String()), reason: Type.String() }),
  T('turn.started', {
    turnId: Type.String(),
    inputIds: Type.Array(Type.String()),
    replyRoute: Type.Union([ReplyRoute, Type.Null()]),
    /**
     * host: started by startTurn. harness: the harness started it by itself (e.g. a
     * background task finished). foreign: another client of the same native thread.
     * For non-host turns the adapter mints turnId, inputIds may be empty and run may be absent.
     */
    initiator: Type.Optional(Type.Union([Type.Literal('host'), Type.Literal('harness'), Type.Literal('foreign')])),
    nativeTurnId: Type.Optional(Type.String()),
    run: Type.Optional(RunSpec),
    owner: Type.Optional(Type.String()),
  }),
  T('turn.delivery_added', {
    turnId: Type.String(),
    route: ReplyRoute,
    reason: Type.Union([Type.Literal('steer'), Type.Literal('handoff'), Type.Literal('mirror')]),
  }),
  T('turn.completed', {
    turnId: Type.String(),
    status: TurnStatus,
    usage: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.Object({ code: Type.String(), retryable: Type.Boolean(), message: Type.Optional(Type.String()) })),
  }),
  T('text.delta', {
    delta: Type.String(),
    stream: Type.Union([Type.Literal('answer'), Type.Literal('reasoning'), Type.Literal('command_output')]),
  }),
  /** Cumulative text; idempotent, safe to drop intermediate ones. */
  T('text.snapshot', { text: Type.String(), final: Type.Boolean() }),
  T('item.started', { item: ItemSummary }),
  T('item.completed', { item: ItemSummary }),
  T('item.progress', { itemId: Type.String(), text: Type.Optional(Type.String()), elapsedMs: Type.Optional(Type.Number()) }),
  T('plan.updated', {
    steps: Type.Array(
      Type.Object({
        text: Type.String(),
        status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')]),
      }),
    ),
  }),
  T('diff.updated', {
    files: Type.Array(Type.Object({ path: Type.String(), added: Type.Number(), removed: Type.Number() })),
  }),
  /** The harness's own session/thread id became known (persist it for resume). */
  T('session.bound', { nativeId: Type.String() }),
  /**
   * Folded state for late joiners; sent before live events when the requested
   * fromSeq is no longer retained. `seq` on this event is the last folded seq.
   */
  T('session.snapshot', { snapshot: Type.Unknown() }),
  /** One-line status for low-bandwidth ends (speaker, watch, meeting screen). */
  T('headline', { text: Type.String() }),
  T('request.opened', {
    requestId: Type.String(),
    kind: Type.Union([
      Type.Literal('tool_approval'),
      Type.Literal('file_change'),
      Type.Literal('permissions'),
      Type.Literal('question'),
      Type.Literal('elicitation'),
    ]),
    title: Type.String(),
    risk: Type.Object({
      writes: Type.Optional(Type.Boolean()),
      network: Type.Optional(Type.Boolean()),
      elevated: Type.Optional(Type.Boolean()),
    }),
    detailRef: Type.Optional(Type.String()),
    /** Short preview of the tool input (command line, file path…). */
    inputPreview: Type.Optional(Type.String()),
    questions: Type.Optional(Type.Array(RequestQuestion)),
    /** Harness-native "always allow" / amendment suggestions, passed back via Decision. */
    suggestions: Type.Optional(Type.Unknown()),
    allowedDecisions: Type.Array(Type.String()),
    allowAlways: Type.Boolean(),
    defaultDeny: Type.Boolean(),
    expiresAt: Type.Optional(Type.Number()),
    /** Filled by the session layer from Policy.resolve; harness adapters leave it out. */
    resolver: Type.Optional(Resolver),
  }),
  T('request.resolved', { requestId: Type.String(), decision: Type.Union([Decision, Type.Null()]), by: ResolvedBy }),
  T('usage', { usage: Type.Unknown() }),
  T('notice', {
    code: Type.Union([
      Type.Literal('compacting'),
      Type.Literal('api_retry'),
      Type.Literal('rate_limited'),
      Type.Literal('runtime_restart'),
      Type.Literal('auto_review'),
      Type.Literal('continuity'),
      Type.Literal('other'),
    ]),
    message: Type.String(),
  }),
  T('delivery.settled', {
    operationId: Type.String(),
    route: ReplyRoute,
    result: Type.Union([Type.Literal('delivered'), Type.Literal('rejected'), Type.Literal('unknown')]),
    providerMessageId: Type.Optional(Type.String()),
  }),
  T('render.anchor', {
    route: ReplyRoute,
    turnId: Type.String(),
    providerMessageId: Type.String(),
    leaseUntil: Type.Optional(Type.Number()),
  }),
  T('native', { name: Type.String() }),
]);
export type Body = Static<typeof Body>;
export type BodyType = Body['t'];
export type BodyOf<K extends BodyType> = Extract<Body, { t: K }>;

export const Audience = Type.Union([
  Type.Literal('answer'),
  Type.Literal('commentary'),
  Type.Literal('status'),
  Type.Literal('approval'),
  Type.Literal('internal'),
]);
export type Audience = Static<typeof Audience>;

/** What a harness adapter emits. The session layer adds `seq` and `sessionKey`. */
export const HarnessEvent = Type.Object({
  ts: Type.Number(),
  turnId: Type.Optional(Type.String()),
  itemId: Type.Optional(Type.String()),
  parentItemId: Type.Optional(Type.String()),
  level: Level,
  audience: Audience,
  durability: Type.Union([Type.Literal('durable'), Type.Literal('ephemeral')]),
  body: Body,
  /** Raw harness event, only forwarded to `full` tier. */
  native: Type.Optional(Type.Unknown()),
});
export type HarnessEvent = Static<typeof HarnessEvent>;

/** The single output stream of a session. */
export const SessionEvent = Type.Composite([
  Type.Object({
    v: V,
    sessionKey: Type.String(),
    /**
     * Assigned by the session log: per-session, monotonic, gapless over durable events.
     * Ephemeral events carry the seq of the last durable event before them (not unique).
     */
    seq: Type.Number(),
    harness: Type.String(),
    /** Harness binding generation; late events from an older generation are dropped. */
    generation: Type.Number(),
    visibility: Type.Union([Type.Literal('participants'), Type.Literal('operators'), Type.Literal('internal')]),
  }),
  HarnessEvent,
]);
export type SessionEvent = Static<typeof SessionEvent>;
