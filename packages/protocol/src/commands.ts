import { Type, type Static } from '@sinclair/typebox';
import { Origin, InputRecord } from './inbound.js';
import { Decision } from './requests.js';
import { Level, Tier } from './events.js';

/** `observe` records the input as context without starting a turn. */
export const InputMode = Type.Union([
  Type.Literal('queue'),
  Type.Literal('steer'),
  Type.Literal('interrupt'),
  Type.Literal('observe'),
]);
export type InputMode = Static<typeof InputMode>;

/**
 * Commands from any end (channel, web, TUI, host) to a session. `origin` is always
 * overwritten by the gateway from the connection's identity.
 */
export const Command = Type.Union([
  Type.Object({
    type: Type.Literal('input'),
    sessionKey: Type.String(),
    input: InputRecord,
    mode: InputMode,
    expectedTurnId: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('interrupt'),
    sessionKey: Type.String(),
    turnId: Type.Optional(Type.String()),
    cancelQueue: Type.Optional(Type.Boolean()),
    origin: Origin,
  }),
  Type.Object({
    type: Type.Literal('resolve'),
    sessionKey: Type.String(),
    requestId: Type.String(),
    decision: Decision,
    /** The origin's host relays the answer of this principal (system origins only). */
    onBehalfOf: Type.Optional(Type.String()),
    origin: Origin,
  }),
  Type.Object({
    type: Type.Literal('control'),
    sessionKey: Type.String(),
    op: Type.Union([
      Type.Literal('set_model'),
      Type.Literal('set_effort'),
      Type.Literal('reset'),
      Type.Literal('resume_interrupted'),
    ]),
    arg: Type.Optional(Type.String()),
    origin: Origin,
  }),
  Type.Object({
    type: Type.Literal('subscribe'),
    sessionKey: Type.String(),
    fromSeq: Type.Optional(Type.Number()),
    tier: Tier,
    filter: Type.Optional(
      Type.Object({ minLevel: Type.Optional(Level), optOut: Type.Optional(Type.Array(Type.String())) }),
    ),
  }),
  Type.Object({ type: Type.Literal('unsubscribe'), sessionKey: Type.String() }),
]);
export type Command = Static<typeof Command>;
