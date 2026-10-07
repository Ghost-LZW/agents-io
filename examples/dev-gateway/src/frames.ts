import { Type, type Static } from '@sinclair/typebox';
import {
  ContentBlock,
  Decision,
  InputMode,
  Level,
  ResultFrame,
  SessionEvent,
  Tier,
  V,
  check,
  errors,
} from '@agents-io/protocol';

/*
 * Local client protocol: JSONL over a Unix socket, one frame per line (the same
 * codec as the adapter bridges: `encodeFrame` / `FrameDecoder`). It makes a
 * terminal, a web backend or a script a first-class end of a session.
 *
 * Proposed for packages/protocol/src/wire.ts. `ClientCommand` is the protocol
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

/** Client → server. Every request carries `id`; the server answers with a `result` frame of the same id. */
export const ClientFrame = Type.Union([
  Type.Object({ v: V, type: Type.Literal('command'), id: Type.String(), command: ClientCommand }),
  /** Value: `SessionInfo[]`. */
  Type.Object({ v: V, type: Type.Literal('sessions'), id: Type.String() }),
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
   * `{ head }`; sessions → `SessionInfo[]`; others → `{}`. Errors carry the lane's
   * reason as `code` (`forbidden`, `not_eligible`, `no_active_turn`, …).
   */
  ResultFrame,
  /** One event of a subscription; `event.sessionKey` says which. */
  Type.Object({ v: V, type: Type.Literal('event'), event: SessionEvent }),
  /** A subscription ended without the client asking (server shutting down). */
  Type.Object({ v: V, type: Type.Literal('closed'), sessionKey: Type.String(), reason: Type.String() }),
]);
export type ServerFrame = Static<typeof ServerFrame>;

export const CLIENT_FRAME_TYPES = ['command', 'sessions'] as const;
export const SERVER_FRAME_TYPES = ['result', 'event', 'closed'] as const;

export type ParsedClientFrame = { ok: true; frame: ClientFrame } | { ok: false; id?: string; error: string };

/** Validate one decoded line from a client. Unknown frame types are reported, not thrown. */
export function parseClientFrame(raw: unknown): ParsedClientFrame {
  if (check(ClientFrame, raw)) return { ok: true, frame: raw };
  const id = raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : undefined;
  return { ok: false, ...(id !== undefined ? { id } : {}), error: errors(ClientFrame, raw).slice(0, 3).join('; ') || 'invalid frame' };
}
