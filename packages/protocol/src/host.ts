import { Type, type Static, type TObject, type TSchema } from '@sinclair/typebox';
import { ContentBlock, Evidence, OriginEvidence, ReplyRoute, V } from './common.js';
import { Body } from './events.js';
import { Decision, Resolver } from './requests.js';
import { RunSpec } from './run.js';
import { ConversationKind, InboundEnvelope, InputCause, InputRecord, OriginKind } from './inbound.js';
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

/**
 * An agent-originated input that was stopped from starting a turn at the lane
 * (docs/design/agent-messaging §4.4): `hops` — its hop is over `limit`; `pair` — the
 * same peer started `count` turns in this session within `windowMs` (`limit` = the
 * maximum). It was recorded as context instead.
 */
export const LoopGuardTrip = Type.Object({
  tripped: Type.Union([Type.Literal('hops'), Type.Literal('pair')]),
  limit: Type.Integer(),
  hop: Type.Optional(Type.Integer()),
  peer: Type.Optional(Type.String()),
  count: Type.Optional(Type.Integer()),
  windowMs: Type.Optional(Type.Integer()),
  /** The session it was stopped in. */
  sessionKey: Type.Optional(Type.String()),
});
export type LoopGuardTrip = Static<typeof LoopGuardTrip>;

/** The task run an input started (`run.start`), and the correlation id its host gave. */
export const RunOfInput = Type.Object({ runId: Type.String(), correlation: Type.Optional(Type.String()) });

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
  evidence: OriginEvidence,
  /**
   * The evidence the envelope claimed, when the emitting channel may not give it and
   * it was capped to `none` (channel-stamping): `evidence` is what identity saw.
   */
  claimedEvidence: Type.Optional(Evidence),
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
  /** An agent-originated input: the chain it is part of (`InputRecord.cause`). */
  cause: Type.Optional(InputCause),
  /** The loop guard stopped it from starting a turn (it was recorded as context). */
  loopGuard: Type.Optional(LoopGuardTrip),
  /** The input of a task run (`run.start`; `matched` names the `host:run` rule and the run's session): its run id and the host's correlation id. */
  run: Type.Optional(RunOfInput),
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
  /**
   * Where the turn sits in a chain of agent messages: the highest hop among its triggering
   * inputs (0 = a human, host or system input started it), that input's chain id and root
   * principal. A tag, never used to grant or block anything.
   */
  cause: Type.Optional(Type.Object({ hop: Type.Integer({ minimum: 0 }), chain: Type.String(), rootPrincipal: Type.Union([Type.String(), Type.Null()]) })),
});
export type TurnProvenance = Static<typeof TurnProvenance>;

// ---- host → daemon --------------------------------------------------------

const Req = <K extends string>(type: K) => ({ v: V, type: Type.Literal(type), id: Type.String() });

/**
 * What an `outbound` callout is about (`outbound.content` / `outbound.scoped` hosts): `reply` the turn's
 * answer on a checked route, `tool` an output tool's message, `question` a native question card, `request`
 * an approval card's title, `title` a topic title; settlements only: `notice` a notice of the daemon's
 * own (a rejection, a stranger asking in), `host` a host's own `deliver`, `live` what a live said
 * (`live_say`: never asked, a live does not open where a scoped host checks).
 */
export const OutboundKind = Type.Union([Type.Literal('reply'), Type.Literal('tool'), Type.Literal('question'), Type.Literal('request'), Type.Literal('title'), Type.Literal('notice'), Type.Literal('host'), Type.Literal('live')]);
export type OutboundKind = Static<typeof OutboundKind>;

/** One conversation of an `outbound.scoped` host's scope: every thread of it is in scope (U20). */
export const OutboundScopeRoute = Type.Object({ channel: Type.String(), account: Type.String(), conversationId: Type.String() });
export type OutboundScopeRoute = Static<typeof OutboundScopeRoute>;

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
   * `outbound` (may an agent send there), `contact` (may one agent contact another; nothing
   * asks it yet), `external` (may a client of the external MCP endpoint send or queue an
   * input). Unknown names are ignored; the result's
   * `callouts` lists what was granted. Any hook (or `consumer`) makes this connection the host.
   * `outbound.content` (feature `callouts.outbound.content`): `outbound` callouts carry `content`,
   * `turnId`, `kind` and may answer `hold`. `outbound.scoped` (feature `callouts.outbound.scope`):
   * the `outbound` hook only for the routes of `outboundScope`, with content (U20); naming it with
   * `outbound` fails `invalid_frame`. A daemon without these features ignores the names.
   */
  callouts: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
  /** With `callouts: [..., "outbound.scoped"]`: the conversations the host checks (every thread of each). */
  outboundScope: Type.Optional(Type.Object({ routes: Type.Array(OutboundScopeRoute) })),
  /**
   * What this host asks to see in the session logs, by the name of the result's `features`; only a
   * hello that makes this connection the host counts (kept while it is away, cleared by a host hello
   * without it). `item.tool`: an MCP tool item keeps `tool { server, name }` (HC-7), and nothing else
   * changes. Unknown names are ignored; the result's `optIn` lists what was granted.
   */
  optIn: Type.Optional(Type.Array(Type.String())),
  /**
   * When another connection holds the host role (`consumer` / `callouts`),
   * replace it instead of failing with `host_connected`: the daemon closes the
   * old connection (its unacked pushes are pushed again here) and logs the
   * takeover. For a host reconnecting while its previous connection is
   * half-open. Needs the valid token like any hello; a daemon that lists
   * `host.takeover` in `features` supports it (an older one ignores the flag).
   */
  takeover: Type.Optional(Type.Boolean()),
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
  /**
   * Replace the agent's run defaults for this run only (feature `run.overrides`; an older daemon
   * ignores them). `preset`: a configured preset's harness instance, model and effort; `model` /
   * `effort` go over that (passed through, never interpreted); `profile` must be one the run's
   * instance defines in `profiles`, or built in (`bypass`, `restricted`). A value the daemon cannot
   * apply fails the request with `bad_override`.
   */
  overrides: Type.Optional(
    Type.Object({
      model: Type.Optional(Type.String()),
      effort: Type.Optional(Type.String()),
      profile: Type.Optional(Type.String()),
      preset: Type.Optional(Type.String()),
    }),
  ),
  /**
   * The id of the run's input (feature `run.correlation`; default: one the daemon makes): 1-256
   * letters, digits, `.`, `_`, `:`, `-`, starting with a letter or digit. One another input already
   * has (a routing record) fails `input_id_taken`.
   */
  inputId: Type.Optional(Type.String()),
  /**
   * An opaque id of the host's (feature `run.correlation`), at most 256 characters: kept with the
   * run's input (`InputRecord.correlation`), echoed in `run.ended` and shown by `explain`; never
   * shown to the model.
   */
  correlation: Type.Optional(Type.String()),
});
export type RunStart = Static<typeof RunStart>;

export const RunCancel = Type.Object({ ...Req('run.cancel'), runId: Type.String(), reason: Type.Optional(Type.String()) });

/** Deliver to people; idempotent per operationId. Clicks come back through bindings (e.g. `actionPrefix`). */
export const Deliver = Type.Object({ ...Req('deliver'), operationId: Type.String(), route: ReplyRoute, message: RenderedMessage });
export type Deliver = Static<typeof Deliver>;

/**
 * Edit a message the host delivered (feature `deliver.update`): `providerMessageId` as its
 * `deliver` answered. `sequence` grows with each update of that message (a lower or equal one
 * is stale and skipped). `final` settles it (a channel's finalize: a process card's last layout,
 * its thinking bubble closed, an answer too long for the card continued in more messages); a
 * final update is idempotent per operationId, others are not recorded. A channel that cannot
 * edit answers `unsupported`.
 */
export const DeliverUpdate = Type.Object({
  ...Req('deliver.update'),
  operationId: Type.String(),
  route: ReplyRoute,
  providerMessageId: Type.String(),
  message: RenderedMessage,
  sequence: Type.Integer({ minimum: 1 }),
  final: Type.Optional(Type.Boolean()),
});
export type DeliverUpdate = Static<typeof DeliverUpdate>;

/**
 * Mark a channel message with how the host's handling of it stands (feature `message.ack`): the
 * channel's `acknowledge` (Lark: a reaction on it). `working` once taken, then `done` or
 * `failed`, or `none` to take the mark away. Cosmetic: a channel without marks answers
 * `unsupported`, a platform error `channel_error`; nothing is recorded.
 */
export const MessageAck = Type.Object({
  ...Req('message.ack'),
  route: ReplyRoute,
  messageId: Type.String(),
  state: Type.Union([Type.Literal('working'), Type.Literal('done'), Type.Literal('failed'), Type.Literal('none')]),
});
export type MessageAck = Static<typeof MessageAck>;

/**
 * Create a conversation on a channel (feature `conversation.create`), e.g. a Lark group with
 * the bot in it: `members` are channel user ids (the namespace of `sender.channelUserId`),
 * `owner` one of them. At most one conversation per operationId (the channel's own dedup,
 * where it has one, and the daemon's while it runs). A channel that cannot answers `unsupported`.
 */
export const ConversationCreate = Type.Object({
  ...Req('conversation.create'),
  operationId: Type.String(),
  channel: Type.String(),
  account: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  owner: Type.Optional(Type.String()),
  members: Type.Optional(Type.Array(Type.String())),
});
export type ConversationCreate = Static<typeof ConversationCreate>;

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

/**
 * `explain`: `inputId` is an input id (its routing record), or the operationId of a
 * delivery (the turn that made it and that turn's inputs). `chain: true` with an input id:
 * walk the input's cause back to the root of its chain.
 */
export const Explain = Type.Object({ ...Req('explain'), inputId: Type.String(), chain: Type.Optional(Type.Boolean()) });

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
  /** `false` (feature `callout.history`): this dispatch hands no channel history (IN-9), whatever the channel's config. */
  history: Type.Optional(Type.Boolean()),
});
export type InboundRedispatch = Static<typeof InboundRedispatch>;

/**
 * Compact a session's harness context now (feature `session.compact`, CT-3): a turn of its own
 * whose one input is the harness's command (Claude Code `/compact`), from the host, with no reply
 * route (nothing reaches a channel) and no context handed (it waits for the next turn). Only a
 * session with an open lane (`not_live`; it never opens a harness just to compact) whose harness
 * can compact (`unsupported`), and only while it is quiet: a turn running or starting, queued
 * inputs, open requests or a live answer `busy` and record nothing. Inputs arriving while it runs
 * queue behind it. `inputId` as `run.start`'s (`bad_input_id`); the same id again answers
 * `duplicate: true` and starts nothing.
 */
export const SessionCompact = Type.Object({ ...Req('session.compact'), sessionKey: Type.String(), inputId: Type.Optional(Type.String()) });
export type SessionCompact = Static<typeof SessionCompact>;

/**
 * Open a session's harness now, without a turn (feature `session.prewarm`): the host expects input
 * soon (a reminder or a routine coming due) and the first turn should not wait for the harness to
 * boot (Claude Code: the CLI process, its MCP servers and plugins). Nothing is admitted, recorded
 * or sent to a model. A session with a harness open already answers `opened: false`. Only a session
 * the daemon has run or registered (its log, a lane, a pinned agent or launch: else `not_found`),
 * never a task run.
 */
export const SessionPrewarm = Type.Object({ ...Req('session.prewarm'), sessionKey: Type.String() });
export type SessionPrewarm = Static<typeof SessionPrewarm>;

/**
 * Test hook (feature `test.hooks`, HOSTS §4.3; off unless the daemon was started with
 * `AIO_TEST_HOOKS=1`, else `test_hooks_off`): hand a channel message this process accepted
 * earlier (by the input id it became) to the gateway again, `times` times (default 1, at most
 * 10), as the platform redelivering it would: the original envelope, stamped against the same
 * running channel. The envelopes are kept in memory only while test hooks are on (bounded, gone
 * on restart): one not kept answers `not_found`. Fault injection only; logged at warn.
 */
export const TestReplay = Type.Object({ ...Req('test.replay'), inputId: Type.String(), times: Type.Optional(Type.Number()) });
export type TestReplay = Static<typeof TestReplay>;

/**
 * Test hook (feature `test.hooks`, same gate as `test.replay`): `drop-response` makes the next
 * `next` sends (1–100) through `channel` (and `account`, `conversation` — the reply route's
 * `conversationId`, e.g. a Lark chat_id — when given) go out to the platform as usual while their
 * response is thrown away: the attempt never answers, so the outbox settles it on its attempt
 * timeout as `unknown` and does not retry (DL-1). Only `send` calls count (`edit`, `finalize`,
 * `previewProgress` neither drop nor use one up), across sessions: `conversation` narrows it to one
 * chat. `clear` removes every
 * injection; `list` changes nothing. Every action answers the injections in effect. In memory
 * only: a restart clears them. Logged at warn.
 */
export const TestFault = Type.Object({
  ...Req('test.fault'),
  action: Type.Union([Type.Literal('drop-response'), Type.Literal('clear'), Type.Literal('list')]),
  channel: Type.Optional(Type.String()),
  account: Type.Optional(Type.String()),
  conversation: Type.Optional(Type.String()),
  next: Type.Optional(Type.Number()),
});
export type TestFault = Static<typeof TestFault>;

/**
 * Replace the connected `outbound.scoped` host's scope as a whole (feature `callouts.outbound.scope`);
 * in effect when answered. `not_scoped`: this connection is not the host that declared `outbound.scoped`.
 */
export const HostOutboundScope = Type.Object({ ...Req('host.outboundScope'), routes: Type.Array(OutboundScopeRoute) });
export type HostOutboundScope = Static<typeof HostOutboundScope>;

export const HostRequestFrame = Type.Union([HostHello, BindingsPut, BindingsGet, RunStart, RunCancel, Deliver, DeliverUpdate, MessageAck, ConversationCreate, InputVerify, InboundRead, InboundAck, Explain, SessionPrepare, InboundRedispatch, SessionCompact, SessionPrewarm, TestReplay, TestFault, HostOutboundScope]);
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
  /**
   * Feature `run.ended.usage`: from the run's first log record (its input admitted) to the record
   * of its end (turn completed, input rejected or cancelled; the daemon writes one when the harness
   * left none). Absent when the end is not known in time (a run a previous daemon left unfinished).
   */
  durationMs: Type.Optional(Type.Number()),
  /** Feature `run.ended.usage`: the harness's usage report for the turn, passed through (`turn.completed.usage`); absent when it gave none. */
  usage: Type.Optional(Type.Unknown()),
  /** Feature `run.ended.usage`: the run's turn (absent when none started), as in the session log. */
  turnId: Type.Optional(Type.String()),
  /** Feature `run.ended.usage`: the run's input. */
  inputId: Type.Optional(Type.String()),
  /** Feature `run.correlation`: `run.start.correlation`, as given. */
  correlation: Type.Optional(Type.String()),
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
  live: Type.Optional(Type.Object({ liveId: Type.String(), startedBy: Type.Union([Type.String(), Type.Null()]), controlRoute: Type.Union([ReplyRoute, Type.Null()]) })),
});

/**
 * `Policy.resolve` asked of a host whose hello lists `resolve`: who answers this
 * request. Answer a `Resolver`. On timeout, error, a bad answer or no host the
 * daemon's own policy decides (fail closed to built-in behaviour).
 */
export const ResolveCallout = Type.Object({
  ...Req('policy'),
  hook: Type.Literal('resolve'),
  args: Type.Object({
    request: RequestOpenedBody,
    ctx: TurnContextView,
    /**
     * The harness's own form of the request (feature `resolve.native`), as its `request.opened`
     * event carries it at the full tier: for Claude Code `{ toolName, input, suggestions,
     * decisionReason, blockedPath, mcpServer, … }`. What a host matches its own rules on.
     */
    native: Type.Optional(Type.Unknown()),
  }),
});

/**
 * The `model` resolver's review asked of a host whose hello lists `review` (feature
 * `callouts.review`): the request a `resolve` answer gave `{ kind: "model" }`. The host runs
 * its reviewer and answers a `ReviewCalloutAnswer`. The lane does not wait for it: the request
 * stays pending (shown to nobody) until the answer, and a timeout, an error or a bad answer
 * escalate (the model resolver's `escalate`, else `Policy.escalate`).
 */
export const ReviewCallout = Type.Object({
  ...Req('policy'),
  hook: Type.Literal('review'),
  args: Type.Object({
    request: RequestOpenedBody,
    ctx: TurnContextView,
    model: Type.String(),
    prompt: Type.Optional(Type.String()),
    native: Type.Optional(Type.Unknown()),
  }),
});

/**
 * `Policy.outbound` asked of a host whose hello lists `outbound`: may a turn send
 * to `to` (`from: null` outside a turn). Answer `{ verdict }`; timeout, error or a
 * bad answer deny.
 */
export const OutboundCallout = Type.Object({
  ...Req('policy'),
  hook: Type.Literal('outbound'),
  args: Type.Object({
    from: Type.Union([TurnContextView, Type.Null()]),
    to: ReplyRoute,
    /**
     * Only for an `outbound.scoped` host (U20), whose answer is `OutboundContentCalloutAnswer`
     * (`hold` too): what is sent and what it is. `attachmentText`: the text of text-like attachments
     * (`text/*`, JSON, Markdown, CSV; at most 64 KiB each) by blob ref.
     */
    kind: Type.Optional(OutboundKind),
    content: Type.Optional(RenderedMessage),
    attachmentText: Type.Optional(Type.Record(Type.String(), Type.String())),
    turnId: Type.Optional(Type.String()),
    requestId: Type.Optional(Type.String()),
  }),
});

const AgentAddressView = Type.Object({ agent: Type.String(), sessionKey: Type.String() });

/**
 * `Policy.contact` asked of a host whose hello lists `contact`: may agent session `from`
 * list / send to / run / observe / control `to` (agent-messaging §4.6). Answer `{ verdict }`;
 * timeout, error or a bad answer: the daemon's own policy decides (`policy.agentContacts`,
 * default deny). Nothing asks it yet: the agent-messaging tools will.
 */
export const ContactCallout = Type.Object({
  ...Req('policy'),
  hook: Type.Literal('contact'),
  args: Type.Object({
    from: AgentAddressView,
    to: Type.Union([AgentAddressView, Type.Object({ agent: Type.String() })]),
    op: Type.Union(['list', 'send', 'run', 'observe', 'control'].map((x) => Type.Literal(x))),
    turn: Type.Union([TurnContextView, Type.Null()]),
  }),
});

/**
 * `external` asked of a host whose hello lists it (feature `callouts.external`): may this
 * client of the external MCP endpoint do this write? `op`: `send` (a message to `route`)
 * or `input` (an input queued into `sessionKey`); `content` is what would be sent or
 * queued. `client` is the client's name in `externalMcp.clients`, `principal` the one its
 * actions are stamped with, `declared` whom it says it acts for (clients allowed to
 * declare). Answer `{ verdict }` (`reason` is shown to the client when it denies).
 * Timeout, error, a bad answer — and, once a host declared the hook, that host being away —
 * deny. Reads are not asked: the client's scopes decide them.
 */
export const ExternalCallout = Type.Object({
  ...Req('policy'),
  hook: Type.Literal('external'),
  args: Type.Object({
    client: Type.String(),
    principal: Type.String(),
    declared: Type.Optional(Type.String()),
    op: Type.Union([Type.Literal('send'), Type.Literal('input')]),
    route: Type.Optional(ReplyRoute),
    sessionKey: Type.Optional(Type.String()),
    content: Type.Array(ContentBlock),
    /** The send's operationId (`op: send`) or the input's id (`op: input`), as the daemon will record it. */
    id: Type.String(),
  }),
});

/** The host's answer to an `external` callout. */
export const ExternalCalloutAnswer = Type.Object({ verdict: Type.Union([Type.Literal('allow'), Type.Literal('deny')]), reason: Type.Optional(Type.String({ maxLength: 500 })) });
export type ExternalCalloutAnswer = Static<typeof ExternalCalloutAnswer>;

/**
 * The host's answer to a `review` callout: a decision (settled as `by: { kind: "model", id: model }`),
 * or `escalate` — to `resolver` when given (e.g. a human resolver whose `note` says why), else
 * to the model resolver's `escalate`, else to `Policy.escalate`.
 */
export const ReviewCalloutAnswer = Type.Union([
  Decision,
  Type.Object({
    escalate: Type.Literal(true),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
    resolver: Type.Optional(Resolver),
  }),
]);
export type ReviewCalloutAnswer = Static<typeof ReviewCalloutAnswer>;

/** The host's answer to a `contact` callout. */
export const ContactCalloutAnswer = Type.Object({ verdict: Type.Union([Type.Literal('allow'), Type.Literal('deny')]) });
export type ContactCalloutAnswer = Static<typeof ContactCalloutAnswer>;

export const HostEventFrame = Type.Union([InboundFrame, RouteCallout, ResolveCallout, ReviewCallout, OutboundCallout, ContactCallout, ExternalCallout, RunEnded, ResultFrame]);
export type HostEventFrame = Static<typeof HostEventFrame>;

export const HOST_REQUEST_FRAME_TYPES = ['host.hello', 'bindings.put', 'bindings.get', 'run.start', 'run.cancel', 'deliver', 'deliver.update', 'message.ack', 'conversation.create', 'input.verify', 'inbound.read', 'inbound.ack', 'explain', 'session.prepare', 'inbound.redispatch', 'session.compact', 'session.prewarm', 'test.replay', 'test.fault', 'host.outboundScope'] as const;
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
  /** The host connection this hello replaced (`takeover: true`). */
  replaced: Type.Optional(Type.Object({ name: Type.String() })),
  /**
   * Capabilities by name, e.g. `session.launch` (callout answers may carry
   * `launch`; `session.prepare`). A daemon without one ignores what it adds, so
   * a host must not rely on a feature this list lacks.
   */
  features: Type.Optional(Type.Array(Type.String())),
  /** The `policy` hooks this connection answers (from the hello's `callouts`). */
  callouts: Type.Optional(Type.Array(Type.String())),
  /** With `outbound.scoped` granted: the scope's revision and how many conversations it has. */
  outboundScope: Type.Optional(Type.Object({ revision: Type.Number(), routes: Type.Number() })),
  /** The hello's `optIn` this connection was granted (empty unless it is the host). */
  optIn: Type.Optional(Type.Array(Type.String())),
});
export type HostHelloResult = Static<typeof HostHelloResult>;

/** `host.outboundScope`: the new scope's revision. */
export const HostOutboundScopeResult = Type.Object({ revision: Type.Number() });
export type HostOutboundScopeResult = Static<typeof HostOutboundScopeResult>;

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
  /** The run's input (`started`, `running`; feature `run.correlation`). */
  inputId: Type.Optional(Type.String()),
  /** What the run's turn runs with: the agent's defaults with the overrides applied (`started`, `running`; feature `run.overrides`). */
  run: Type.Optional(RunSpec),
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
  /** The platform thread (topic) the message is in, when the channel reports one (`SendResult.providerThreadId`; Lark `thread_id`). */
  providerThreadId: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  /** An earlier `deliver` with this operationId settled it; nothing was sent now. */
  duplicate: Type.Boolean(),
});
export type DeliverResult = Static<typeof DeliverResult>;

/** `deliver.update`. `duplicate`: a final update with this operationId was applied before. */
export const DeliverUpdateResult = Type.Object({
  operationId: Type.String(),
  providerMessageId: Type.String(),
  status: Type.Union([Type.Literal('delivered'), Type.Literal('rejected'), Type.Literal('unknown')]),
  error: Type.Optional(Type.String()),
  duplicate: Type.Boolean(),
});
export type DeliverUpdateResult = Static<typeof DeliverUpdateResult>;

/** `message.ack`. */
export const MessageAckResult = Type.Object({ messageId: Type.String(), state: Type.String() });
export type MessageAckResult = Static<typeof MessageAckResult>;

/** `conversation.create`: the new conversation's id (a route's `conversationId`). */
export const ConversationCreateResult = Type.Object({
  operationId: Type.String(),
  channel: Type.String(),
  account: Type.String(),
  conversationId: Type.String(),
  duplicate: Type.Boolean(),
});
export type ConversationCreateResult = Static<typeof ConversationCreateResult>;

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

/** Who sent through the external MCP endpoint (`EffectExplanation.external`). */
export const ExternalSender = Type.Object({ client: Type.String(), principal: Type.String(), declared: Type.Optional(Type.String()) });
export type ExternalSender = Static<typeof ExternalSender>;

/**
 * `explain` of a side effect: a delivery's operationId (as its `delivery.settled` names it)
 * → the session and turn that made it → that turn's triggering inputs (`explain` each for
 * its routing record and chain).
 */
export const EffectExplanation = Type.Object({
  operationId: Type.String(),
  sessionKey: Type.String(),
  /** Absent for a delivery no turn made (a host `deliver`, a system reply). */
  turnId: Type.Optional(Type.String()),
  inputIds: Type.Array(Type.String()),
  route: ReplyRoute,
  result: Type.Union([Type.Literal('delivered'), Type.Literal('rejected'), Type.Literal('unknown'), Type.Literal('held')]),
  providerMessageId: Type.Optional(Type.String()),
  at: Type.Number(),
  /** A send by a client of the external MCP endpoint: which client, the principal it was stamped with, whom it declared it acts for. */
  external: Type.Optional(ExternalSender),
});
export type EffectExplanation = Static<typeof EffectExplanation>;

/** One input on the way from an agent-originated input back to its root (`explain { chain: true }`). */
export const ChainLink = Type.Object({
  inputId: Type.String(),
  /** 0 = the root (a human, host or system input). Absent where the chain is broken. */
  hop: Type.Optional(Type.Integer({ minimum: 0 })),
  /** The session it was delivered to, and its address `<agent>/<sessionKey>` when the agent is known. */
  sessionKey: Type.Optional(Type.String()),
  address: Type.Optional(Type.String()),
  principal: Type.Union([Type.String(), Type.Null()]),
  /** The turn it triggered in that session, if any. */
  turnId: Type.Optional(Type.String()),
  basis: Type.Optional(InputCause.properties.basis),
  /** It was stopped by the loop guard. */
  loopGuard: Type.Optional(LoopGuardTrip),
  /** The root is a task run's input: the run and the host's correlation id. */
  run: Type.Optional(RunOfInput),
});
export type ChainLink = Static<typeof ChainLink>;

/** `explain { chain: true }`: from the input (first) back to the root (last); `end` says why the walk stopped. */
export const ChainExplanation = Type.Object({
  inputId: Type.String(),
  chain: Type.Optional(Type.String()),
  links: Type.Array(ChainLink),
  /** `root`: reached hop 0; `broken`: a `basis: none` link (the sender's turn is unknown); `unknown`: a record is gone (retention, another machine). */
  end: Type.Union([Type.Literal('root'), Type.Literal('broken'), Type.Literal('unknown')]),
});
export type ChainExplanation = Static<typeof ChainExplanation>;

/** `explain`: a routing record (error `unknown_input` when there is none and no delivery has that id), a side effect, or a chain. */
export const ExplainResult = Type.Union([RouteExplanation, EffectExplanation, ChainExplanation]);
export type ExplainResult = Static<typeof ExplainResult>;

/** The host's answer to an `inbound` push: `accepted: true` once durably taken; anything else is retried. */
export const InboundAnswer = Type.Object({ accepted: Type.Boolean() });
export type InboundAnswer = Static<typeof InboundAnswer>;

/**
 * The host's answer to a `route` callout: replaces the rule's `on` / `agent` / `session`.
 * `launch` (feature `session.launch`) applies to the session the input lands in;
 * only with an `on` that targets a session.
 */
export const RouteCalloutAnswer = Type.Object({
  on: BindingAction,
  agent: Type.Optional(Type.String()),
  session: Type.Optional(SessionScope),
  launch: Type.Optional(SessionLaunch),
  /** `false` (feature `callout.history`): this dispatch hands no channel history (IN-9). */
  history: Type.Optional(Type.Boolean()),
});

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


/**
 * The answer of an `outbound.content` / `outbound.scoped` host: `hold` = not sent, the host takes it
 * (settles `held`, final, never retried). `reason` is shown to the agent: it must not carry content.
 */
export const OutboundContentCalloutAnswer = Type.Object({
  verdict: Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Literal('hold')]),
  reason: Type.Optional(Type.String()),
});
export type OutboundContentCalloutAnswer = Static<typeof OutboundContentCalloutAnswer>;

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

/** `session.compact`: the turn it started (none with `duplicate`: that id was taken before). */
export const SessionCompactResult = Type.Object({
  sessionKey: Type.String(),
  inputId: Type.String(),
  turnId: Type.Optional(Type.String()),
  duplicate: Type.Boolean(),
});
export type SessionCompactResult = Static<typeof SessionCompactResult>;

/** `session.prewarm`: `opened` when this request opened the harness (false: it was open already). */
export const SessionPrewarmResult = Type.Object({ sessionKey: Type.String(), opened: Type.Boolean() });
export type SessionPrewarmResult = Static<typeof SessionPrewarmResult>;

/** `test.replay`: the channel message replayed and what the gateway made of each copy. */
export const TestReplayResult = Type.Object({
  inputId: Type.String(),
  /** `channel:<channel>/<message id>` of the replayed message (what `input.verify` takes). */
  channelRef: Type.String(),
  channel: Type.String(),
  account: Type.String(),
  /** One per copy, in order: `duplicate` = the gateway recognised it (nothing new was admitted). */
  results: Type.Array(
    Type.Object({
      action: Type.Union([Type.Literal('accepted'), Type.Literal('duplicate'), Type.Literal('refused')]),
      inputId: Type.Optional(Type.String()),
      error: Type.Optional(Type.String()),
    }),
  ),
});
export type TestReplayResult = Static<typeof TestReplayResult>;

/** `test.fault`: the injections in effect after the action. */
export const TestFaultResult = Type.Object({
  faults: Type.Array(
    Type.Object({
      kind: Type.Literal('drop-response'),
      channel: Type.String(),
      account: Type.Optional(Type.String()),
      conversation: Type.Optional(Type.String()),
      remaining: Type.Number(),
      at: Type.Number(),
    }),
  ),
});
export type TestFaultResult = Static<typeof TestFaultResult>;

/** Result value schema per host request type. */
export const HOST_RESULT_VALUES = {
  'host.hello': HostHelloResult,
  'bindings.put': BindingsPutResult,
  'bindings.get': BindingsGetResult,
  'run.start': RunStartResult,
  'run.cancel': RunCancelResult,
  deliver: DeliverResult,
  'deliver.update': DeliverUpdateResult,
  'message.ack': MessageAckResult,
  'conversation.create': ConversationCreateResult,
  'input.verify': InputVerifyResult,
  'inbound.read': InboundReadResult,
  'inbound.ack': InboundAckResult,
  explain: ExplainResult,
  'session.prepare': SessionPrepareResult,
  'inbound.redispatch': InboundRedispatchResult,
  'session.compact': SessionCompactResult,
  'session.prewarm': SessionPrewarmResult,
  'test.replay': TestReplayResult,
  'test.fault': TestFaultResult,
  'host.outboundScope': HostOutboundScopeResult,
} as const satisfies Record<(typeof HOST_REQUEST_FRAME_TYPES)[number], TSchema>;
