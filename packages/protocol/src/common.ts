import { Type, type Static } from '@sinclair/typebox';

/** Wire protocol major version. Frames and envelopes carry it as `v`. */
export const PROTOCOL_VERSION = 1 as const;

export const V = Type.Literal(PROTOCOL_VERSION);

/** Where a reply goes. Opaque to the core except for routing and equality. */
export const ReplyRoute = Type.Object({
  channel: Type.String(),
  account: Type.String(),
  conversationId: Type.String(),
  threadId: Type.Optional(Type.String()),
  replyToMessageId: Type.Optional(Type.String()),
});
export type ReplyRoute = Static<typeof ReplyRoute>;

/** `${channel}:${account}:${conversation}[:${thread}]` — the stable key of a route, ignoring reply target. */
export function routeKey(r: ReplyRoute): string {
  const base = `${r.channel}:${r.account}:${r.conversationId}`;
  return r.threadId ? `${base}:${r.threadId}` : base;
}

/**
 * Content of an input. Large payloads are never inlined: `ref` points to a blob the
 * host stores (e.g. `sha256:<hex>`), so envelopes stay small.
 */
export const ContentBlock = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }),
  Type.Object({
    type: Type.Union([Type.Literal('image'), Type.Literal('file'), Type.Literal('audio')]),
    ref: Type.String(),
    mime: Type.String(),
    name: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal('quote'), text: Type.String(), fromMessageId: Type.Optional(Type.String()) }),
  Type.Object({
    type: Type.Literal('transcript'),
    speaker: Type.Optional(Type.String()),
    text: Type.String(),
    startMs: Type.Number(),
    endMs: Type.Number(),
    /** Live captions are revised; only stable segments should trigger work. */
    stable: Type.Boolean(),
  }),
  /** Non-message events: meeting invite, card click, doc comment, webhook. */
  Type.Object({ type: Type.Literal('event'), name: Type.String(), data: Type.Record(Type.String(), Type.Unknown()) }),
  /** A pointer the agent can fetch on demand. */
  Type.Object({ type: Type.Literal('ref'), uri: Type.String(), title: Type.Optional(Type.String()) }),
]);
export type ContentBlock = Static<typeof ContentBlock>;

/** What an adapter can prove about a sender. Evidence, not a conclusion. */
export const Evidence = Type.Union([
  Type.Literal('platform_signed'),
  Type.Literal('dkim_pass'),
  Type.Literal('device_only'),
  Type.Literal('none'),
]);
export type Evidence = Static<typeof Evidence>;

/** A host-side subject. `labels` are defined by the host; agents-io never interprets them. */
export const Principal = Type.Object({ id: Type.String(), labels: Type.Array(Type.String()) });
export type Principal = Static<typeof Principal>;
