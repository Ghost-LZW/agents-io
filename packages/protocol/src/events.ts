import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ReplyRoute, V } from './common.js';
import { RunSpec } from './run.js';
import { Decision, RequestQuestion, ResolvedBy, Resolver } from './requests.js';
import { InputRecord } from './inbound.js';
import { TopicChangeReason } from './topic.js';

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
  /**
   * An MCP tool call (`type: "mcp_tool"`, docs/HOSTS.md §4.4, INVARIANTS HC-7): the server and the tool
   * as the harness names them; `title` starts with `<server>.<name>`. Every harness adapter sets it;
   * the session log keeps it only while an `outbound.scoped` or `outbound.content` host is declared
   * (feature `item.tool`), so the events of other hosts read as before.
   */
  tool: Type.Optional(Type.Object({ server: Type.String(), name: Type.String() })),
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
  /**
   * `reason` is a code, optionally `code: detail` (e.g. `start_failed: …`, `lane_closed: …`).
   * `replyRoute`: set when the inputs never reached a turn a renderer shows (still queued,
   * the turn failed to start): renderers tell the sender there. Unset when a turn's own
   * rendering already says how it ended, or the route is not known (`host_restarted`).
   */
  T('input.rejected', { inputIds: Type.Array(Type.String()), reason: Type.String(), replyRoute: Type.Optional(ReplyRoute) }),
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
    /**
     * Only while an `outbound.scoped` host's scope is declared (feature `reply.check`): `true` when the
     * reply route is in scope as the turn starts. The answer is then sent once, after the turn, past the
     * host's check; no streaming, no process. `false`: not checked.
     */
    checked: Type.Optional(Type.Boolean()),
  }),
  /**
   * A freshly opened harness session took over a turn that was already running
   * natively (e.g. after the host restarted). Opens the turn in this stream like
   * turn.started; events during the gap were not seen.
   */
  T('turn.adopted', {
    turnId: Type.String(),
    nativeTurnId: Type.Optional(Type.String()),
    inputIds: Type.Array(Type.String()),
    run: Type.Optional(RunSpec),
    /** As `turn.started.checked`. */
    checked: Type.Optional(Type.Boolean()),
  }),
  T('turn.delivery_added', {
    turnId: Type.String(),
    route: ReplyRoute,
    /** approval: a human request of a delegated turn is shown where its resolver's people are (the live's control route). */
    reason: Type.Union([Type.Literal('steer'), Type.Literal('handoff'), Type.Literal('mirror'), Type.Literal('approval')]),
    /** As `turn.started.checked`, for this route (scope as it is added); `true` makes the turn checked from here on. */
    checked: Type.Optional(Type.Boolean()),
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
   * The harness is up and took the turn's input (Claude Code: its `system/init`, at the start of each
   * CLI run; a session opened for the turn has booted by then). With the turn's id when one runs.
   * Hosts time a turn's start by it; the native event stays for operators (HC-6).
   */
  T('session.ready', { nativeId: Type.Optional(Type.String()), model: Type.Optional(Type.String()) }),
  /**
   * The turn's model was switched within the turn: by the harness itself (Claude Code's
   * `model_fallback`, a refusal fallback) or by agents-io's own deadlines (`first_byte_timeout`,
   * `idle_timeout`). `trigger` is the harness's reason (HC-6).
   */
  T('model.fallback', {
    from: Type.String(),
    to: Type.String(),
    trigger: Type.String(),
    scope: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  /** The permission mode the turn runs in (HC-5): at its start, and each tightening within it (HC-6). */
  T('permission.mode', { mode: Type.String(), previous: Type.String(), model: Type.String(), trigger: Type.String() }),
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
      /** An agent-originated input was stopped from starting a turn (hop or same-pair limit); recorded as context. */
      Type.Literal('loop_guard'),
      /** A turn carrying a live's delegation began under a wider profile than its speaker gets; interrupted (decision 11 amendment). */
      Type.Literal('live_profile'),
      /** A task run's `run.start.timeoutMs` elapsed; the run is interrupted and ends `timeout`. */
      Type.Literal('run_timeout'),
      /** The daemon is stopping while a task run goes; the run is interrupted and ends `interrupted` with `daemon_stopping`. */
      Type.Literal('run_stopping'),
      Type.Literal('other'),
    ]),
    message: Type.String(),
  }),
  T('delivery.settled', {
    operationId: Type.String(),
    route: ReplyRoute,
    /** `held`: an `outbound.content` / `outbound.scoped` host took it (or could not answer for a scoped route); never sent. */
    result: Type.Union([Type.Literal('delivered'), Type.Literal('rejected'), Type.Literal('unknown'), Type.Literal('held')]),
    providerMessageId: Type.Optional(Type.String()),
    /** While an `outbound.content` / `outbound.scoped` host is declared: what was sent (`OutboundKind`), its turn, the card's request. */
    kind: Type.Optional(Type.String()),
    turnId: Type.Optional(Type.String()),
    requestId: Type.Optional(Type.String()),
    /** `held` (and a denied check): why, as given to the agent. */
    reason: Type.Optional(Type.String()),
    /**
     * `rejected` because the exit check answered `deny` (U20; only with `kind`): never sent. Like `held`,
     * a checked turn's text it carried stays withheld from external readers, and the agent is told.
     */
    denied: Type.Optional(Type.Boolean()),
  }),
  T('render.anchor', {
    route: ReplyRoute,
    turnId: Type.String(),
    providerMessageId: Type.String(),
    leaseUntil: Type.Optional(Type.Number()),
  }),
  /**
   * The current topic of a flat conversation changed (decision 6). Appended to
   * the session being left (when there is one) and to the one now current.
   */
  T('topic.changed', {
    /** Route key of the conversation. */
    conversation: Type.String(),
    /** Topic id that was current; absent for the conversation's first topic. */
    from: Type.Optional(Type.String()),
    /** Topic id that is current now. */
    to: Type.String(),
    title: Type.Optional(Type.String()),
    reason: TopicChangeReason,
    /**
     * U20: the agent's `session_rotate` was asked of the `outbound.scoped` host (its title, with the
     * summary of the topic left): `allowed` kept both, `held` kept neither. Absent when nothing was asked.
     */
    check: Type.Optional(Type.Union([Type.Literal('allowed'), Type.Literal('held')])),
  }),
  /** A realtime voice session opened on this session (decision 11). Recorded by the session layer. */
  T('live.started', {
    liveId: Type.String(),
    title: Type.String(),
    /** Where the live happens (the channel's media peer). */
    route: ReplyRoute,
    /** Route of the turn that opened it; delegated turns may send text there. */
    controlRoute: Type.Union([ReplyRoute, Type.Null()]),
    /** Principal id of whoever started it (the owner of the turn that called `live_join`): approvals of delegated turns are asked of them. */
    startedBy: Type.Optional(Type.String()),
  }),
  /** One finished utterance of the live: `user` = the far side (everyone else, mixed), `assistant` = the voice. */
  T('live.transcript', { liveId: Type.String(), role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]), text: Type.String() }),
  /**
   * The voice side delegated to the harness's agent. The harness emits it before the
   * turn it starts (`turn.started{initiator:'harness', inputIds:[inputId]}`); the session
   * layer turns it into an input record.
   */
  T('live.handoff', { liveId: Type.String(), inputId: Type.String(), text: Type.String() }),
  T('live.ended', { liveId: Type.String(), reason: Type.String() }),
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
