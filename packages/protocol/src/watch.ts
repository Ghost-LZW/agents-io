import { Type, type Static } from '@sinclair/typebox';

/**
 * A watch subscribes a session to inputs that were not addressed to it — a group
 * the agent only listens to, the owner's inbox. The mirror of output subscriptions:
 * ends subscribe to a session's events; a session subscribes to channel inputs.
 */
export const WatchSource = Type.Object({
  channel: Type.String(),
  account: Type.Optional(Type.String()),
  /** A conversation id, or a kind to match every conversation of that kind. */
  conversation: Type.Optional(Type.String()),
  conversationKind: Type.Optional(
    Type.Union([Type.Literal('dm'), Type.Literal('group'), Type.Literal('thread'), Type.Literal('meeting'), Type.Literal('mail'), Type.Literal('other')]),
  ),
  /** Channel user ids; empty or absent = anyone. */
  senders: Type.Optional(Type.Array(Type.String())),
});
export type WatchSource = Static<typeof WatchSource>;

/** Cheap deterministic filters; semantic judgement belongs to `Policy.triage`. */
export const WatchFilter = Type.Object({
  /** Case-insensitive substrings; any match passes. */
  keywords: Type.Optional(Type.Array(Type.String())),
  /** Pass only messages that mention one of these channel user ids. */
  mentions: Type.Optional(Type.Array(Type.String())),
  /** Drop this deployment's own echoes (default true). */
  excludeSelf: Type.Optional(Type.Boolean()),
});
export type WatchFilter = Static<typeof WatchFilter>;

export const WatchMode = Type.Union([
  /** Record as context; the next turn of the target session sees it. */
  Type.Literal('context'),
  /** Batch matches and start one turn per period (or when maxItems is reached). */
  Type.Literal('digest'),
  /** Start a turn for every match. */
  Type.Literal('trigger'),
]);
export type WatchMode = Static<typeof WatchMode>;

export const Watch = Type.Object({
  id: Type.String(),
  source: WatchSource,
  filter: Type.Optional(WatchFilter),
  /** The listening session. */
  target: Type.Object({ sessionKey: Type.String() }),
  mode: WatchMode,
  digest: Type.Optional(Type.Object({ everyMs: Type.Number(), maxItems: Type.Optional(Type.Number()) })),
  /** Principal that created it (owner via config/command, or the agent of a session). */
  createdBy: Type.String(),
  createdAt: Type.Number(),
  /** Unix ms; absent = until removed. */
  expiresAt: Type.Optional(Type.Number()),
  note: Type.Optional(Type.String()),
});
export type Watch = Static<typeof Watch>;
