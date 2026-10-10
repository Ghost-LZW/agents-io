import { Type, type Static } from '@sinclair/typebox';
import { ContentBlock, Evidence, Principal, ReplyRoute, V } from './common.js';

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
  evidence: Evidence,
  /** Accepted declared identity (only when policy trusts the sending account). */
  declared: Type.Optional(Type.String()),
  /** Message produced by this deployment's own agents, echoed back by the channel. */
  self: Type.Optional(Type.Boolean()),
  /** routeKey of where it came from. */
  via: Type.String(),
  adapter: Type.String(),
});
export type Origin = Static<typeof Origin>;

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
  /** Small scalar facts a harness may surface to the model (chat name, sender name…). */
  channelContext: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
});
export type InputRecord = Static<typeof InputRecord>;
