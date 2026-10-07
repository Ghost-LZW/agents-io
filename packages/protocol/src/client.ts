import { Type, type Static } from '@sinclair/typebox';
import { ContentBlock, V } from './common.js';
import { InputMode } from './commands.js';
import { Level, SessionEvent, Tier } from './events.js';
import { Decision } from './requests.js';
import { ResultFrame } from './wire.js';
import { WatchFilter, WatchMode, WatchSource } from './watch.js';

/*
 * Local client protocol: JSONL over a Unix socket, one frame per line (the same
 * codec as the adapter bridges: `encodeFrame` / `FrameDecoder`). It makes a
 * terminal, a web backend or a script a first-class end of a session.
 *
 * `ClientCommand` is the protocol
 * `Command` with every `origin` left out: the server stamps the connection's
 * principal, and any `origin` a client sends is ignored. So a full `Command`
 * is also a valid `ClientCommand`.
 */

/** What a client may say as input; the server fills origin, replyRoute and a fresh inputId if absent. */
export const ClientInput = Type.Object({
  inputId: Type.Optional(Type.String()),
  content: Type.Array(ContentBlock),
  channelContext: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
});
export type ClientInput = Static<typeof ClientInput>;

export const ClientCommand = Type.Union([
  Type.Object({
    type: Type.Literal('input'),
    sessionKey: Type.String(),
    input: ClientInput,
    mode: InputMode,
    expectedTurnId: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal('interrupt'), sessionKey: Type.String(), turnId: Type.Optional(Type.String()), cancelQueue: Type.Optional(Type.Boolean()) }),
  Type.Object({ type: Type.Literal('resolve'), sessionKey: Type.String(), requestId: Type.String(), decision: Decision }),
  Type.Object({
    type: Type.Literal('control'),
    sessionKey: Type.String(),
    op: Type.Union([Type.Literal('set_model'), Type.Literal('set_effort'), Type.Literal('reset'), Type.Literal('resume_interrupted')]),
    arg: Type.Optional(Type.String()),
  }),
  /** Live events follow as `event` frames; `fromSeq` replays `seq > fromSeq` first, omitted starts with a snapshot. */
  Type.Object({
    type: Type.Literal('subscribe'),
    sessionKey: Type.String(),
    fromSeq: Type.Optional(Type.Number()),
    tier: Tier,
    filter: Type.Optional(Type.Object({ minLevel: Type.Optional(Level), optOut: Type.Optional(Type.Array(Type.String())) })),
  }),
  Type.Object({ type: Type.Literal('unsubscribe'), sessionKey: Type.String() }),
]);
export type ClientCommand = Static<typeof ClientCommand>;

/**
 * A watch as a client (or config file) asks for it: a `Watch` without `createdBy`
 * and `createdAt`, which the server stamps from the connection's principal. An
 * absent `id` gets a fresh one; an existing `id` replaces that watch.
 */
export const WatchDraft = Type.Object({
  id: Type.Optional(Type.String()),
  source: WatchSource,
  filter: Type.Optional(WatchFilter),
  target: Type.Object({ sessionKey: Type.String() }),
  mode: WatchMode,
  digest: Type.Optional(Type.Object({ everyMs: Type.Number(), maxItems: Type.Optional(Type.Number()) })),
  expiresAt: Type.Optional(Type.Number()),
  note: Type.Optional(Type.String()),
});
export type WatchDraft = Static<typeof WatchDraft>;

const TopicSwitchBase = {
  v: V,
  type: Type.Literal('topic.switch'),
  id: Type.String(),
  /** Route key of the conversation. */
  conversation: Type.String(),
};

/**
 * Make a topic current: an existing one (`topicId`, parked or current) or a new
 * one (`new`); a frame naming both is refused (`invalid_frame`). Checked by
 * `Policy.control` like `reset`. Host connections may send it too. Value:
 * `TopicSwitchResult`; errors `unknown_topic`, `unknown_conversation`.
 */
export const TopicSwitchFrame = Type.Union([
  Type.Object({ ...TopicSwitchBase, topicId: Type.String() }),
  Type.Object({ ...TopicSwitchBase, new: Type.Object({ title: Type.Optional(Type.String()) }) }),
]);
export type TopicSwitchFrame = Static<typeof TopicSwitchFrame>;

/** Client → server. Every request carries `id`; the server answers with a `result` frame of the same id. */
export const ClientFrame = Type.Union([
  Type.Object({ v: V, type: Type.Literal('command'), id: Type.String(), command: ClientCommand }),
  /** Value: `SessionInfo[]`. */
  Type.Object({ v: V, type: Type.Literal('sessions'), id: Type.String() }),
  /** Create (or replace) a watch; checked by `Policy.watch` against the connection's origin. Value: the stored `Watch`. */
  Type.Object({ v: V, type: Type.Literal('watch.add'), id: Type.String(), watch: WatchDraft }),
  /** Value: `{ removed: boolean }`. */
  Type.Object({ v: V, type: Type.Literal('watch.remove'), id: Type.String(), watchId: Type.String() }),
  /** Value: `Watch[]` (only those targeting `sessionKey` when given). */
  Type.Object({ v: V, type: Type.Literal('watch.list'), id: Type.String(), sessionKey: Type.Optional(Type.String()) }),
  /**
   * Topics of flat conversations (decision 6). Value: `Topic[]`, newest
   * `lastActiveAt` first; only those of `conversation` (a route key) and/or
   * `sessionKey` when given.
   */
  Type.Object({ v: V, type: Type.Literal('topic.list'), id: Type.String(), conversation: Type.Optional(Type.String()), sessionKey: Type.Optional(Type.String()) }),
  TopicSwitchFrame,
]);
export type ClientFrame = Static<typeof ClientFrame>;

export const SessionInfo = Type.Object({
  sessionKey: Type.String(),
  harness: Type.String(),
  state: Type.String(),
  /** Last durable seq. */
  head: Type.Number(),
  turnId: Type.Optional(Type.String()),
  queued: Type.Number(),
  pendingRequests: Type.Array(Type.String()),
  /** A lane (harness binding) exists in this process. */
  live: Type.Boolean(),
});
export type SessionInfo = Static<typeof SessionInfo>;

/** Server → client. */
export const ServerFrame = Type.Union([
  /**
   * Answer to a request. Values: input → `{ inputId, disposition }`; subscribe →
   * `{ head }`; sessions → `SessionInfo[]`; topic.list → `Topic[]`; topic.switch →
   * `TopicSwitchResult`; others → `{}`. Errors carry the lane's
   * reason as `code` (`forbidden`, `not_eligible`, `no_active_turn`, …).
   */
  ResultFrame,
  /** One event of a subscription; `event.sessionKey` says which. */
  Type.Object({ v: V, type: Type.Literal('event'), event: SessionEvent }),
  /** A subscription ended without the client asking (server shutting down). */
  Type.Object({ v: V, type: Type.Literal('closed'), sessionKey: Type.String(), reason: Type.String() }),
]);
export type ServerFrame = Static<typeof ServerFrame>;

export const CLIENT_FRAME_TYPES = ['command', 'sessions', 'watch.add', 'watch.remove', 'watch.list', 'topic.list', 'topic.switch'] as const;
export const SERVER_FRAME_TYPES = ['result', 'event', 'closed'] as const;
