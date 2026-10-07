import { Type, type Static } from '@sinclair/typebox';
import { ContentBlock, Evidence, ReplyRoute, V } from './common.js';
import { ConversationKind, InboundEnvelope, InputRecord } from './inbound.js';
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
  callout: Type.Optional(Type.Object({ timeoutMs: Type.Optional(Type.Number()), onFailure: Type.Optional(BindingAction) })),
  note: Type.Optional(Type.String()),
});
export type Binding = Static<typeof Binding>;

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
        Type.Object({ outcome: Type.Union([Type.Literal('answered'), Type.Literal('timeout'), Type.Literal('error'), Type.Literal('no_host')]), on: BindingAction }),
      ),
    }),
  ),
  principal: Type.Union([Type.String(), Type.Null()]),
  evidence: Evidence,
  /** Unix ms of the routing decision. */
  at: Type.Optional(Type.Number()),
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
  /** This host answers `route` callouts. */
  callouts: Type.Optional(Type.Boolean()),
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

export const HostRequestFrame = Type.Union([HostHello, BindingsPut, BindingsGet, RunStart, RunCancel, Deliver, InputVerify, InboundRead, InboundAck, Explain]);
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

export const RunEnded = Type.Object({
  v: V,
  type: Type.Literal('run.ended'),
  runId: Type.String(),
  sessionKey: Type.String(),
  status: Type.Union([Type.Literal('completed'), Type.Literal('interrupted'), Type.Literal('failed'), Type.Literal('ambiguous')]),
  /** 0 for completed, non-zero otherwise. */
  exitCode: Type.Number(),
  error: Type.Optional(Type.Object({ code: Type.String(), message: Type.Optional(Type.String()) })),
});
export type RunEnded = Static<typeof RunEnded>;

export const HostEventFrame = Type.Union([InboundFrame, RouteCallout, RunEnded, ResultFrame]);
export type HostEventFrame = Static<typeof HostEventFrame>;

export const HOST_REQUEST_FRAME_TYPES = ['host.hello', 'bindings.put', 'bindings.get', 'run.start', 'run.cancel', 'deliver', 'input.verify', 'inbound.read', 'inbound.ack', 'explain'] as const;
export const HOST_EVENT_FRAME_TYPES = ['inbound', 'policy', 'run.ended', 'result'] as const;
