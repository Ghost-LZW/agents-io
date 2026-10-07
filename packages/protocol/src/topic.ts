import { Type, type Static } from '@sinclair/typebox';

/*
 * Topics (docs/design/locus/DECISIONS.md decision 6). A flat conversation (one
 * without platform threads) can hold several topics, each its own session, and
 * has one current topic. Bindings reach it with `session: "topic"`. agents-io
 * keeps the table (old topics are parked, never deleted); when to switch is the
 * agent's call (output tools `session_rotate` / `session_list` /
 * `session_switch`) or the user's (`/new`, `/topics`, `/switch`).
 */

export const TopicState = Type.Union([
  /** The conversation's current topic: `session: "topic"` routes here. */
  Type.Literal('current'),
  /** An earlier topic; switching back resumes its harness session natively. */
  Type.Literal('parked'),
]);
export type TopicState = Static<typeof TopicState>;

export const Topic = Type.Object({
  id: Type.String(),
  /** Route key of the conversation (`routeKey` of its reply route, without thread). */
  conversation: Type.String(),
  sessionKey: Type.String(),
  title: Type.Optional(Type.String()),
  /** Carried into the next topic when it rotates. */
  summary: Type.Optional(Type.String()),
  /** The harness's own session/thread id, for native resume when switching back. */
  nativeId: Type.Optional(Type.String()),
  state: TopicState,
  /** Unix ms. */
  createdAt: Type.Number(),
  /** Unix ms. */
  lastActiveAt: Type.Number(),
});
export type Topic = Static<typeof Topic>;

/** Who switched: a user command, the agent (output tool), or the daemon itself. */
export const TopicChangeReason = Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('system')]);
export type TopicChangeReason = Static<typeof TopicChangeReason>;

/** `topic.switch` answer: the topic that is now current and the one it replaced. */
export const TopicSwitchResult = Type.Object({
  topic: Topic,
  previous: Type.Optional(Topic),
  /** A new topic was created. */
  created: Type.Boolean(),
});
export type TopicSwitchResult = Static<typeof TopicSwitchResult>;
