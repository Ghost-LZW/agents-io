import { Type, type Static, type TObject, type TSchema } from '@sinclair/typebox';
import { ContentBlock, Evidence, ReplyRoute, V } from './common.js';
import { Body } from './events.js';
import { Resolver } from './requests.js';
import { RunSpec } from './run.js';
import { ConversationKind, InboundEnvelope, InputRecord, OriginKind } from './inbound.js';
import { RenderedMessage } from './channel.js';
import { ResultFrame } from './wire.js';

/*
 * Host protocol (docs/HOSTS.md r2, docs/design/locus/DECISIONS.md). A host keeps
 * its own state and hands IO and harness wiring to the agents-io daemon. Routing
 * is a deterministic binding table; inputs routed to the host go through a
 * durable queue; identities come from a host-pushed map. A host connection may
 * also send every client frame (client.ts).
 */

// ---- Binding table --------------------------------------------------------

export const BindingAction = Type.Union([
  /** Start or continue a turn of `agent` in the resolved session. */
  Type.Literal('dispatch'),
  /** Record as context for `agent`'s session; no turn. */
  Type.Literal('context'),
  /** Record as context and batch into one turn per period (see `digest`). */
  Type.Literal('digest'),
  /** Put into the durable host inbound queue. */
  Type.Literal('host'),
  /** Ignore (still logged for `aio explain`). */
  Type.Literal('drop'),
]);
export type BindingAction = Static<typeof BindingAction>;

/** Fixed match fields; every field set must hold. No regex, OR or time windows. */
export const BindingMatch = Type.Object({
  channel: Type.Optional(Type.String()),
  account: Type.Optional(Type.String()),
  conversation: Type.Optional(Type.String()),
  conversationKind: Type.Optional(ConversationKind),
  /** Channel user ids of the sender. */
  senders: Type.Optional(Type.Array(Type.String())),
  /** Sender must carry at least one of these identity labels (from the identity map). */
  labels: Type.Optional(Type.Array(Type.String())),
  /** Sender's host principal id (from the identity map). */
  principal: Type.Optional(Type.String()),
  /** true: only senders with a principal; false: only senders without one (not mapped, or not enough evidence). */
  known: Type.Optional(Type.Boolean()),
  /** Message must mention one of these channel user ids; `self` = this deployment's bot account. */
  mentions: Type.Optional(Type.Array(Type.String())),
  /** Case-insensitive substrings; any match passes. */
  keywords: Type.Optional(Type.Array(Type.String())),
  /** Card actions whose id starts with this prefix (e.g. `xwo:`). */
  actionPrefix: Type.Optional(Type.String()),
  /** Include this deployment's own echoes (default false). */
  includeSelf: Type.Optional(Type.Boolean()),
});
export type BindingMatch = Static<typeof BindingMatch>;

export const SessionScope = Type.Union([
  Type.Literal('main'),
  Type.Literal('per-conversation'),
  Type.Literal('per-thread'),
  /** The current topic of a flat conversation (decision 6; `topic.ts`). Threaded conversations keep one session per thread. */
  Type.Literal('topic'),
  Type.Object({ key: Type.String() }),
]);
export type SessionScope = Static<typeof SessionScope>;

export const Binding = Type.Object({
  id: Type.String(),
  match: BindingMatch,
  on: BindingAction,
  /** Target agent (a named run configuration) for dispatch/context/digest. Never a `mode: task` agent. */
  agent: Type.Optional(Type.String()),
  /** Default `per-conversation`. */
  session: Type.Optional(SessionScope),
  digest: Type.Optional(Type.Object({ everyMs: Type.Number(), maxItems: Type.Optional(Type.Number()) })),
  /**
   * Opt-in synchronous callout to the host for this rule only (Envoy ext_authz style).
   * The host may replace `on` / `agent` / `session`; on timeout, error or no host, `onFailure` applies.
   */
  callout: Type.Optional(
    Type.Object({
      timeoutMs: Type.Optional(Type.Number()),
      onFailure: Type.Optional(BindingAction),
      /**
       * Skip the callout once the rule's own target session is pinned (has a
       * recorded `launch`): later inputs of that session are routed by the rule
       * alone, so the host is asked once per session key (decision 7). Only for
       * rules whose own `on` targets a session.
       */
      skipWhenPinned: Type.Optional(Type.Boolean()),
    }),
  ),
  note: Type.Optional(Type.String()),
});
export type Binding = Static<typeof Binding>;

/**
 * How one interactive session's harness is launched (decision 7): its working
 * directory and extra child-process environment, within the bounds the agent's
 * `sessionParams` sets. Fixed with the session once accepted.
 */
export const SessionLaunch = Type.Object({
  /** Absolute; must be under one of the agent's `sessionParams.cwdRoots` (after realpath). */
  cwd: Type.Optional(Type.String()),
  /** Child-process environment only; never logged, never on argv. Keys must be in `sessionParams.envKeys`. */
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type SessionLaunch = Static<typeof SessionLaunch>;

/** Channel identity → host principal. The host guarantees one member per channel identity (e.g. x-work-os 0010). */
export const IdentityEntry = Type.Object({
  channel: Type.String(),
  channelUserId: Type.String(),
  principal: Type.String(),
  labels: Type.Array(Type.String()),
  /** Evidence an input must carry to be stamped with this principal. Default `platform_signed`, `dkim_pass`. */
  evidence: Type.Optional(Type.Array(Evidence)),
});
export type IdentityEntry = Static<typeof IdentityEntry>;

export const BindingTable = Type.Object({
  version: Type.String(),
  bindings: Type.Array(Binding),
  identities: Type.Array(IdentityEntry),
  /** Unix ms after which the table is suspended. */
  expiresAt: Type.Optional(Type.Number()),
  /** What happens to this table while its host is disconnected. Default `suspend` for host-pushed tables. */
  onHostDown: Type.Optional(Type.Union([Type.Literal('keep'), Type.Literal('suspend')])),
});
export type BindingTable = Static<typeof BindingTable>;

/** Why an input went where it went (`aio explain`). */
export const RouteExplanation = Type.Object({
  inputId: Type.String(),
  tableVersions: Type.Array(Type.String()),
  matched: Type.Array(
    Type.Object({
      bindingId: Type.String(),
      source: Type.Union([Type.Literal('config'), Type.Literal('host'), Type.Literal('watch')]),
      on: BindingAction,
      agent: Type.Optional(Type.String()),
      sessionKey: Type.Optional(Type.String()),
      callout: Type.Optional(
        Type.Object({
          outcome: Type.Union([
            Type.Literal('answered'),
            Type.Literal('timeout'),
            Type.Literal('error'),
            Type.Literal('no_host'),
            /** `callout.skipWhenPinned`: the rule's session is pinned, the host was not asked. */
            Type.Literal('skipped_pinned'),
          ]),
          on: BindingAction,
          /** Why an answer counted as an error, e.g. `launch_conflict`. */
          reason: Type.Optional(Type.String()),
        }),
      ),
      /**
       * The callout answer carried a `launch` for this session: its cwd and env
       * keys (never values), and what became of it: `applied` (new session),
       * `same` (already pinned to it), or the refusal code.
       */
      launch: Type.Optional(Type.Object({ cwd: Type.Optional(Type.String()), envKeys: Type.Array(Type.String()), outcome: Type.String() })),
      /**
       * The target session refused the delivery before it reached a lane, with a
       * stable code, e.g. `agent_unavailable`: the agent the session is pinned to is
       * no longer configured (or no longer interactive).
       */
      rejected: Type.Optional(Type.Object({ code: Type.String(), message: Type.Optional(Type.String()) })),
    }),
  ),
  principal: Type.Union([Type.String(), Type.Null()]),
  evidence: Evidence,
  /** Unix ms of the routing decision. */
  at: Type.Optional(Type.Number()),
  /** This input is a host-inbound item redispatched by the host (`inbound.redispatch`): the original input and queue cursor. */
  redispatchOf: Type.Optional(Type.Object({ inputId: Type.String(), cursor: Type.Number(), by: Type.String() })),
  /** The host redispatched this (queued) input later: where each redispatch went. */
  redispatched: Type.Optional(
    Type.Array(Type.Object({ cursor: Type.Number(), inputId: Type.String(), sessionKey: Type.String(), agent: Type.Optional(Type.String()), by: Type.String(), at: Type.Number() })),
  ),
  /** Why nothing was delivered, when nothing was. */
  dropped: Type.Optional(Type.Union([Type.Literal('adapter'), Type.Literal('no_match'), Type.Literal('drop_rule')])),
});
export type RouteExplanation = Static<typeof RouteExplanation>;

/** Summary of where a turn's inputs came from; attached to host write calls (decision 4: tag, never block). */
export const TurnProvenance = Type.Object({
  sessionKey: Type.String(),
  turnId: Type.String(),
  /** Principal ids (Origin.principal.id, or null) of the inputs that triggered the turn. */
  triggeredBy: Type.Array(Type.Union([Type.String(), Type.Null()])),
  /** The turn's context includes watched / digest / context-only inputs. */
  watched: Type.Boolean(),
  /** Some input came from a sender without a principal (stranger, unverified). */
  external: Type.Boolean(),
  /** Some input came from a group conversation. */
  group: Type.Boolean(),
});
export type TurnProvenance = Static<typeof TurnProvenance>;

// ---- host → daemon --------------------------------------------------------

const Req = <K extends string>(type: K) => ({ v: V, type: Type.Literal(type), id: Type.String() });

export const HostHello = Type.Object({
  ...Req('host.hello'),
  /** Daemon-generated secret, read from a 0600 file next to the socket. */
  token: Type.String(),
  name: Type.String(),
  /** Push-consume the inbound queue as this consumer (omit to only pull with `aio tail`). */
  consumer: Type.Optional(Type.String()),
  /**
   * Which synchronous hooks this host answers (`policy` frames): `true` = `["route"]`;
   * a list names them: `route` (rule callouts), `resolve` (who answers a request),
   * `outbound` (may an agent send there). Unknown names are ignored; the result's
   * `callouts` lists what was granted. Any hook (or `consumer`) makes this connection the host.
   */
  callouts: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
  /**
   * Presence lease for a pull-only host (one with neither `consumer` nor
   * `callouts`, e.g. a long-running `aio tail`): the host named `name` counts as
   * connected, so its `onHostDown: "suspend"` table stays active, until `ttlMs`
   * after its last frame on any authenticated connection of that name; every
   * frame renews it. A lease for another name while a host is connected is
   * refused with `host_connected`.
   */
  lease: Type.Optional(Type.Object({ ttlMs: Type.Number() })),
});
export type HostHello = Static<typeof HostHello>;

export const BindingsPut = Type.Object({ ...Req('bindings.put'), table: BindingTable });
export const BindingsGet = Type.Object({ ...Req('bindings.get') });

/** Run one headless turn of a `mode: task` agent: a fresh session `run:<runId>`, closed when the turn ends. */
export const RunStart = Type.Object({
  ...Req('run.start'),
  runId: Type.String(),
  agent: Type.String(),
  cwd: Type.Optional(Type.String()),
  input: Type.Array(ContentBlock),
  /** Child-process environment only; never logged or put on argv. */
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** Render the run's progress on these routes (observation only). */
  observe: Type.Optional(Type.Object({ routes: Type.Array(ReplyRoute) })),
  timeoutMs: Type.Optional(Type.Number()),
  /** Replace the agent's run defaults for this run only. `profile` must be one the deployment config defines. */
  overrides: Type.Optional(
    Type.Object({ model: Type.Optional(Type.String()), effort: Type.Optional(Type.String()), profile: Type.Optional(Type.String()) }),
  ),
});
export type RunStart = Static<typeof RunStart>;

export const RunCancel = Type.Object({ ...Req('run.cancel'), runId: Type.String(), reason: Type.Optional(Type.String()) });

/** Deliver to people; idempotent per operationId. Clicks come back through bindings (e.g. `actionPrefix`). */
export const Deliver = Type.Object({ ...Req('deliver'), operationId: Type.String(), route: ReplyRoute, message: RenderedMessage });
export type Deliver = Static<typeof Deliver>;

/** Platform author and evidence of a channel message, e.g. to verify who confirmed something. */
export const InputVerify = Type.Object({ ...Req('input.verify'), channelRef: Type.String() });

/** Pull-consume the inbound queue (what `aio tail` uses). */
export const InboundRead = Type.Object({
  ...Req('inbound.read'),
  consumer: Type.String(),
  /** Exclusive; omit to continue from the consumer's acked cursor. */
  after: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
  /** Long-poll for up to this long when nothing is pending. */
  waitMs: Type.Optional(Type.Number()),
});
export const InboundAck = Type.Object({ ...Req('inbound.ack'), consumer: Type.String(), cursor: Type.Number() });

export const Explain = Type.Object({ ...Req('explain'), inputId: Type.String() });

/**
 * Pin an agent and a launch to a session key before any input opens it (inputs
 * from the host connection, `aio input`, `aio attach`, watches). Records only; the
 * harness opens with the first input. The same values again are a no-op
 * (`created: false`); different ones fail `launch_conflict` / `agent_conflict`.
 */
export const SessionPrepare = Type.Object({ ...Req('session.prepare'), sessionKey: Type.String(), agent: Type.String(), launch: SessionLaunch });
export type SessionPrepare = Static<typeof SessionPrepare>;

/**
 * Deliver a queued host-inbound item (feature `inbound.redispatch`) to a session,
 * with the origin it was stamped with when it arrived (sender, evidence, route).
 * Idempotent per cursor. `agent` / `session` resolve the session as a binding's
 * would (default: the default agent, `per-conversation`); `launch` as in a callout answer.
 */
export const InboundRedispatch = Type.Object({
  ...Req('inbound.redispatch'),
  cursor: Type.Number(),
  agent: Type.Optional(Type.String()),
  session: Type.Optional(SessionScope),
  launch: Type.Optional(SessionLaunch),
});
export type InboundRedispatch = Static<typeof InboundRedispatch>;

export const HostRequestFrame = Type.Union([HostHello, BindingsPut, BindingsGet, RunStart, RunCancel, Deliver, InputVerify, InboundRead, InboundAck, Explain, SessionPrepare, InboundRedispatch]);
export type HostRequestFrame = Static<typeof HostRequestFrame>;

// ---- daemon → host --------------------------------------------------------

/** One entry of the durable host inbound queue. */
export const InboundItem = Type.Object({
  cursor: Type.Number(),
  /** `channel:<channel>/<message id>` (x-work-os 0010 form). Message ids are unique per account, so dedup is on (account, channelRef). */
  channelRef: Type.String(),
  account: Type.String(),
  bindingId: Type.String(),
  input: InputRecord,
  /** The envelope without `raw`. */
  envelope: InboundEnvelope,
  receivedAt: Type.Number(),
});
export type InboundItem = Static<typeof InboundItem>;

/** Push-consume: answer with `result { accepted: true }` once durably taken; then the cursor advances. */
export const InboundFrame = Type.Object({ ...Req('inbound'), item: InboundItem });

/** A `route` callout for a binding with `callout`. Answer `result { on, agent?, session? }`. */
export const RouteCallout = Type.Object({
  ...Req('policy'),
  hook: Type.Literal('route'),
  args: Type.Object({ bindingId: Type.String(), input: InputRecord, envelope: InboundEnvelope }),
});

export const RunStatus = Type.Union([
  Type.Literal('completed'),
  /** Cancelled (`run.cancel`, daemon stopping). */
  Type.Literal('interrupted'),
  Type.Literal('failed'),
  /** Outcome unknown (e.g. the daemon stopped mid-run). */
  Type.Literal('ambiguous'),
  /** `timeoutMs` elapsed and the run was interrupted (older daemons said `interrupted` with `error.code: "timeout"`). */
  Type.Literal('timeout'),
]);
export type RunStatus = Static<typeof RunStatus>;

export const RunEnded = Type.Object({
  v: V,
  type: Type.Literal('run.ended'),
  runId: Type.String(),
  sessionKey: Type.String(),
  status: RunStatus,
  /** 0 completed, 1 failed, 3 ambiguous, 124 timeout, 130 interrupted (cancelled). */
  exitCode: Type.Number(),
  error: Type.Optional(Type.Object({ code: Type.String(), message: Type.Optional(Type.String()) })),
  /** Wall time from `run.start` to the end. */
  durationMs: Type.Optional(Type.Number()),
  /** The harness's usage report for the turn, passed through (as `turn.completed.usage`). */
  usage: Type.Optional(Type.Unknown()),
});
export type RunEnded = Static<typeof RunEnded>;

/** The `request.opened` event body (what `Policy.resolve` gets as `req`). */
export const RequestOpenedBody = (Body.anyOf as TObject[]).find((b) => (b.properties.t as { const?: unknown }).const === 'request.opened')!;

/** `Policy`'s `TurnContext` on the wire. */
export const TurnContextView = Type.Object({
  sessionKey: Type.String(),
  turnId: Type.String(),
  run: RunSpec,
  inputs: Type.Array(InputRecord),
  replyRoute: Type.Union([ReplyRoute, Type.Null()]),
  owner: Type.Optional(Type.String()),
  deliveries: Type.Array(ReplyRoute),
  provenance: Type.Optional(TurnProvenance),
});

/**
 * `Policy.resolve` asked of a host whose hello lists `resolve`: who answers this
 * request. Answer a `Resolver`. On timeout, error, a bad answer or no host the
 * daemon's own policy decides (fail closed to built-in behaviour).
 */
export const ResolveCallout = Type.Object({
  ...Req('policy'),
  hook: Type.Literal('resolve'),
  args: Type.Object({ request: RequestOpenedBody, ctx: TurnContextView }),
});

/**
 * `Policy.outbound` asked of a host whose hello lists `outbound`: may a turn send
 * to `to` (`from: null` outside a turn). Answer `{ verdict }`; timeout, error or a
 * bad answer deny.
 */
export const OutboundCallout = Type.Object({
  ...Req('policy'),
  hook: Type.Literal('outbound'),
  args: Type.Object({ from: Type.Union([TurnContextView, Type.Null()]), to: ReplyRoute }),
});

export const HostEventFrame = Type.Union([InboundFrame, RouteCallout, ResolveCallout, OutboundCallout, RunEnded, ResultFrame]);
export type HostEventFrame = Static<typeof HostEventFrame>;

export const HOST_REQUEST_FRAME_TYPES = ['host.hello', 'bindings.put', 'bindings.get', 'run.start', 'run.cancel', 'deliver', 'input.verify', 'inbound.read', 'inbound.ack', 'explain', 'session.prepare', 'inbound.redispatch'] as const;
export const HOST_EVENT_FRAME_TYPES = ['inbound', 'policy', 'run.ended', 'result'] as const;

// ---- result values --------------------------------------------------------
// The `value` of the `result` frame that answers each host request, and of the
// host's answers to daemon requests. Receivers ignore unknown fields.

const Suspended = Type.Union([Type.Literal('expired'), Type.Literal('host_down')]);

/** The host table as the router holds it. */
export const HostTableState = Type.Object({
  table: BindingTable,
  /** Unix ms it was installed. */
  putAt: Type.Number(),
  active: Type.Boolean(),
  /** Why it is not active. */
  suspended: Type.Optional(Suspended),
});
export type HostTableState = Static<typeof HostTableState>;

/** `host.hello`. */
export const HostHelloResult = Type.Object({
  name: Type.String(),
  /** The daemon's PROTOCOL_VERSION. */
  protocol: Type.Number(),
  /** This connection is the host (push consumer and/or callout answerer). */
  host: Type.Boolean(),
  /** The host table as the router has it. */
  bindings: Type.Object({ version: Type.Union([Type.String(), Type.Null()]), active: Type.Boolean(), suspended: Type.Optional(Suspended) }),
  /** Push consumption: the consumer's acked cursor and the queue head. */
  inbound: Type.Optional(Type.Object({ consumer: Type.String(), acked: Type.Number(), head: Type.Number() })),
  /** The granted presence lease, when the hello asked for one. */
  lease: Type.Optional(Type.Object({ ttlMs: Type.Number(), expiresAt: Type.Number() })),
  /**
   * Capabilities by name, e.g. `session.launch` (callout answers may carry
   * `launch`; `session.prepare`). A daemon without one ignores what it adds, so
   * a host must not rely on a feature this list lacks.
   */
  features: Type.Optional(Type.Array(Type.String())),
  /** The `policy` hooks this connection answers (from the hello's `callouts`). */
  callouts: Type.Optional(Type.Array(Type.String())),
});
export type HostHelloResult = Static<typeof HostHelloResult>;

/** `bindings.put`. The same version and content again is a no-op (`changed: false`). */
export const BindingsPutResult = Type.Object({
  version: Type.String(),
  previous: Type.Optional(Type.String()),
  changed: Type.Boolean(),
  active: Type.Boolean(),
  suspended: Type.Optional(Suspended),
});
export type BindingsPutResult = Static<typeof BindingsPutResult>;

/** `bindings.get`. */
export const BindingsGetResult = Type.Object({
  /** The local config table. */
  config: Type.Union([BindingTable, Type.Null()]),
  host: Type.Union([HostTableState, Type.Null()]),
  hostConnected: Type.Boolean(),
});
export type BindingsGetResult = Static<typeof BindingsGetResult>;

/** `run.start`. */
export const RunStartResult = Type.Object({
  runId: Type.String(),
  sessionKey: Type.String(),
  /** started: this request started it; running: already running (this connection now gets its run.ended too); ended: it ran before. */
  state: Type.Union([Type.Literal('started'), Type.Literal('running'), Type.Literal('ended')]),
  /** How it ended, for `state: "ended"` (its `run.ended` frame is sent again too). */
  ended: Type.Optional(RunEnded),
});
export type RunStartResult = Static<typeof RunStartResult>;

/** `run.cancel` (errors `unknown_run`, `run_ended`). */
export const RunCancelResult = Type.Object({ runId: Type.String(), cancelled: Type.Boolean() });
export type RunCancelResult = Static<typeof RunCancelResult>;

/** `deliver`: the settled delivery record. */
export const DeliverResult = Type.Object({
  /** As the host sent it. */
  operationId: Type.String(),
  sessionKey: Type.String(),
  route: ReplyRoute,
  status: Type.Union([Type.Literal('delivered'), Type.Literal('rejected'), Type.Literal('unknown')]),
  attempts: Type.Number(),
  providerMessageId: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  /** An earlier `deliver` with this operationId settled it; nothing was sent now. */
  duplicate: Type.Boolean(),
});
export type DeliverResult = Static<typeof DeliverResult>;

/** What the daemon recorded about one channel message for one receiving account. Never a guess. */
export const VerifiedInput = Type.Object({
  channelRef: Type.String(),
  channel: Type.String(),
  account: Type.String(),
  conversation: Type.Object({ id: Type.String(), kind: ConversationKind, threadId: Type.Optional(Type.String()) }),
  /** The platform author as the channel adapter reported it. */
  author: Type.Object({ channelUserId: Type.String(), displayName: Type.Optional(Type.String()), isBot: Type.Optional(Type.Boolean()) }),
  /** What the adapter could prove about the author. */
  evidence: Evidence,
  /** The principal the identity map stamped (null: unknown sender, or not enough evidence). */
  principal: Type.Union([Type.String(), Type.Null()]),
  labels: Type.Array(Type.String()),
  /** Origin kind the daemon concluded. */
  kind: OriginKind,
  /** The deployment's own echo. */
  self: Type.Optional(Type.Boolean()),
  /** Input id it became (absent for clicks that were commands). */
  inputId: Type.Optional(Type.String()),
  /** Unix ms the daemon received it. */
  receivedAt: Type.Number(),
  /** Unix ms the platform says it was sent. */
  sentAt: Type.Optional(Type.Number()),
});
export type VerifiedInput = Static<typeof VerifiedInput>;

/** `input.verify`. */
export const InputVerifyResult = Type.Object({
  channelRef: Type.String(),
  /** false: the daemon never received it (or it is older than the retention). */
  found: Type.Boolean(),
  /** One per receiving account. */
  records: Type.Array(VerifiedInput),
});
export type InputVerifyResult = Static<typeof InputVerifyResult>;

/** `inbound.read`. Reads never move the cursor. */
export const InboundReadResult = Type.Object({
  items: Type.Array(InboundItem),
  /** The consumer's acked cursor. */
  acked: Type.Number(),
  head: Type.Number(),
});
export type InboundReadResult = Static<typeof InboundReadResult>;

/** `inbound.ack`: the consumer's cursor after the ack (it never moves back). */
export const InboundAckResult = Type.Object({ consumer: Type.String(), acked: Type.Number() });
export type InboundAckResult = Static<typeof InboundAckResult>;

/** `explain`: the persisted routing record (error `unknown_input` when there is none). */
export const ExplainResult = RouteExplanation;
export type ExplainResult = RouteExplanation;

/** The host's answer to an `inbound` push: `accepted: true` once durably taken; anything else is retried. */
export const InboundAnswer = Type.Object({ accepted: Type.Boolean() });
export type InboundAnswer = Static<typeof InboundAnswer>;

/**
 * The host's answer to a `route` callout: replaces the rule's `on` / `agent` / `session`.
 * `launch` (feature `session.launch`) applies to the session the input lands in;
 * only with an `on` that targets a session.
 */
export const RouteCalloutAnswer = Type.Object({ on: BindingAction, agent: Type.Optional(Type.String()), session: Type.Optional(SessionScope), launch: Type.Optional(SessionLaunch) });

/** `session.prepare`: the pinned agent and launch (env keys only, never values). */
export const SessionPrepareResult = Type.Object({
  sessionKey: Type.String(),
  agent: Type.String(),
  launch: Type.Object({ cwd: Type.Optional(Type.String()), envKeys: Type.Array(Type.String()) }),
  /** false: the key was already prepared with these values. */
  created: Type.Boolean(),
});
export type SessionPrepareResult = Static<typeof SessionPrepareResult>;
export type RouteCalloutAnswer = Static<typeof RouteCalloutAnswer>;

/** The host's answer to a `resolve` callout: who answers the request. */
export const ResolveCalloutAnswer = Resolver;
export type ResolveCalloutAnswer = Resolver;

/** The host's answer to an `outbound` callout. */
export const OutboundCalloutAnswer = Type.Object({ verdict: Type.Union([Type.Literal('allow'), Type.Literal('deny')]) });
export type OutboundCalloutAnswer = Static<typeof OutboundCalloutAnswer>;

/** `inbound.redispatch`: where the item went. `duplicate`: this cursor was redispatched before (nothing was sent now). */
export const InboundRedispatchResult = Type.Object({
  cursor: Type.Number(),
  /** The original input id (as queued; `explain` it to see the redispatch). */
  of: Type.String(),
  /** The redispatched input's id: `<original>~r<cursor>`. */
  inputId: Type.String(),
  sessionKey: Type.String(),
  agent: Type.Optional(Type.String()),
  /** `on: "dispatch"`, or `context` for the deployment's own echo (never a turn). */
  on: Type.Union([Type.Literal('dispatch'), Type.Literal('context')]),
  launch: Type.Optional(Type.Object({ cwd: Type.Optional(Type.String()), envKeys: Type.Array(Type.String()), outcome: Type.String() })),
  /** The lane's disposition (e.g. `started`, `queued`). */
  disposition: Type.Optional(Type.String()),
  at: Type.Number(),
  by: Type.String(),
  duplicate: Type.Boolean(),
  /**
   * With `duplicate`: the first redispatch of this cursor was cut off (the daemon
   * stopped mid-delivery) before its outcome was recorded. The input may or may
   * not have reached the session; it is never sent again (at most once).
   */
  interrupted: Type.Optional(Type.Boolean()),
});
export type InboundRedispatchResult = Static<typeof InboundRedispatchResult>;

/** Result value schema per host request type. */
export const HOST_RESULT_VALUES = {
  'host.hello': HostHelloResult,
  'bindings.put': BindingsPutResult,
  'bindings.get': BindingsGetResult,
  'run.start': RunStartResult,
  'run.cancel': RunCancelResult,
  deliver: DeliverResult,
  'input.verify': InputVerifyResult,
  'inbound.read': InboundReadResult,
  'inbound.ack': InboundAckResult,
  explain: ExplainResult,
  'session.prepare': SessionPrepareResult,
  'inbound.redispatch': InboundRedispatchResult,
} as const satisfies Record<(typeof HOST_REQUEST_FRAME_TYPES)[number], TSchema>;
