import { Type, type Static } from '@sinclair/typebox';
import { ContentBlock, Evidence, OriginEvidence, Principal, ReplyRoute, V } from './common.js';

export const ConversationKind = Type.Union([
  Type.Literal('dm'),
  Type.Literal('group'),
  Type.Literal('thread'),
  Type.Literal('meeting'),
  Type.Literal('call'),
  Type.Literal('mail'),
  Type.Literal('other'),
]);

/**
 * What a channel adapter claims about one inbound message. Everything here is a
 * claim: identity conclusions are made by the host's `Policy.identify`, never by
 * the adapter.
 */
export const InboundEnvelope = Type.Object({
  v: V,
  /** Message id in the adapter's namespace; the dedup key together with `channel`. */
  id: Type.String(),
  channel: Type.String(),
  account: Type.String(),
  conversation: Type.Object({
    id: Type.String(),
    kind: ConversationKind,
    threadId: Type.Optional(Type.String()),
  }),
  sender: Type.Object({
    /** Platform account id within this channel (e.g. a Lark union_id, an email address). */
    channelUserId: Type.String(),
    displayName: Type.Optional(Type.String()),
    isBot: Type.Optional(Type.Boolean()),
    evidence: Evidence,
    /**
     * Identity the sender declared out-of-band of the text, e.g. the run reference an
     * agent attached to its own outbound message. Adapters must only fill it from
     * message metadata they control, never from message text.
     */
    declared: Type.Optional(Type.String()),
    /**
     * Where the sending agent says this message sits in a chain of agent messages, from
     * metadata the adapter controls (mail `X-Agents-IO-Hop`, only on an authenticated
     * message): `hop` is the hop this message has at the recipient, `chain` an opaque id.
     * A claim like `declared`: the gateway takes it only from trusted agent accounts
     * (`policy.agentAccounts`), as `InputRecord.cause` with basis `declared`.
     */
    cause: Type.Optional(Type.Object({ hop: Type.Integer({ minimum: 1 }), chain: Type.Optional(Type.String()) })),
  }),
  content: Type.Array(ContentBlock),
  /** People and bots @-mentioned in the message, in platform ids. */
  mentions: Type.Optional(
    Type.Array(Type.Object({ id: Type.String(), name: Type.Optional(Type.String()), isBot: Type.Optional(Type.Boolean()) })),
  ),
  /** Small scalar facts (subject, chat name…); becomes InputRecord.channelContext. */
  context: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
  /** null = do not reply (e.g. observe-only meeting transcript). */
  replyRoute: Type.Union([ReplyRoute, Type.Null()]),
  /** Adapter's hint (`dispatch` = addressed to us); binding tables decide where the input goes. */
  admission: Type.Optional(
    Type.Union([Type.Literal('dispatch'), Type.Literal('observe'), Type.Literal('drop')]),
  ),
  modeHint: Type.Optional(Type.Union([Type.Literal('queue'), Type.Literal('steer'), Type.Literal('interrupt')])),
  /** Revision of an earlier envelope (latest wins), e.g. a re-recognized caption sentence. */
  revisionOf: Type.Optional(Type.String()),
  /** Unix ms when the platform says the message was sent. */
  sentAt: Type.Optional(Type.Number()),
  /** Platform payload. The core never reads it. */
  raw: Type.Optional(Type.Unknown()),
});
export type InboundEnvelope = Static<typeof InboundEnvelope>;

export const OriginKind = Type.Union([
  Type.Literal('human'),
  Type.Literal('agent'),
  Type.Literal('channel_event'),
  Type.Literal('system'),
  Type.Literal('peer'),
]);

/** Stamped by the gateway after `Policy.identify`. Clients cannot set it. */
export const Origin = Type.Object({
  kind: OriginKind,
  /** null = unknown sender. */
  principal: Type.Union([Principal, Type.Null()]),
  /** What the channel proved, or `daemon` for a record this daemon produced itself (an agent's turn). */
  evidence: OriginEvidence,
  /** Accepted declared identity (only when policy trusts the sending account). */
  declared: Type.Optional(Type.String()),
  /** Message produced by this deployment's own agents, echoed back by the channel. */
  self: Type.Optional(Type.Boolean()),
  /** routeKey of where it came from. */
  via: Type.String(),
  adapter: Type.String(),
});
export type Origin = Static<typeof Origin>;

/**
 * Where an agent-originated input comes from in a chain of agent messages
 * (docs/design/agent-messaging §4.3). Concluded by the daemon, never by a client or an
 * adapter; only on inputs with `origin.kind === "agent"`. Human, host and system inputs
 * have none: they are hop 0, the root of their own chain.
 */
export const InputCause = Type.Object({
  /** The sender: a session address `<agent>/<sessionKey>` of this deployment, or the channel identity `<channel>:<channelUserId>` of an outside agent. */
  peer: Type.String(),
  /**
   * How the daemon knows: `internal` (produced inside this daemon by an agent's turn),
   * `recovered` (a message this deployment sent, back through a channel: found in the
   * outbound index), `declared` (a trusted agent account said so out-of-band), `none`
   * (only that it is an agent; the chain is broken).
   */
  basis: Type.Union([Type.Literal('internal'), Type.Literal('recovered'), Type.Literal('declared'), Type.Literal('none')]),
  /** Hops from the root: 1 = produced by a turn the root input triggered. Absent when the chain is broken (`none`). */
  hop: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Chain id: the root input's inputId (`declared`: the opaque id the sender gave). */
  chain: Type.Optional(Type.String()),
  /** The turn of this deployment that produced it. */
  from: Type.Optional(Type.Object({ sessionKey: Type.String(), turnId: Type.String() })),
  /** Principal id of the root input (null = unknown). A tag only, never used to grant anything. */
  rootPrincipal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Provenance flags of the producing turn, carried over so relaying never launders them (decision 4/5). */
  carried: Type.Optional(Type.Object({ external: Type.Boolean(), watched: Type.Boolean(), group: Type.Boolean() })),
});
export type InputCause = Static<typeof InputCause>;

export const InputRecord = Type.Object({
  inputId: Type.String(),
  origin: Origin,
  content: Type.Array(ContentBlock),
  replyRoute: Type.Union([ReplyRoute, Type.Null()]),
  /**
   * `channel:<channel>/<message id>` of the channel message this input is, stamped by the
   * gateway from the (verified) envelope; absent for local, host, system and agent-tool inputs.
   * The same key `input.verify` / `aio verify` and the host queue use, so an agent can hand it
   * to a host command and the host can check the author itself. Clients cannot set it.
   */
  channelRef: Type.Optional(Type.String()),
  /**
   * Agent-originated inputs only: the chain this input is part of (`InputCause`), stamped
   * by the daemon; copied unchanged when the same input moves (watch forwarding, topic
   * handover, `inbound.redispatch`). Clients and adapters cannot set it.
   */
  cause: Type.Optional(InputCause),
  /** Small scalar facts a harness may surface to the model (chat name, sender name…). */
  channelContext: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
});
export type InputRecord = Static<typeof InputRecord>;
