import { Type, type Static } from '@sinclair/typebox';

/** An answer to a harness request (tool approval, question). */
export const Decision = Type.Union([
  Type.Object({ kind: Type.Literal('allow_once') }),
  Type.Object({ kind: Type.Literal('allow_session'), updatedPermissions: Type.Optional(Type.Unknown()) }),
  Type.Object({
    kind: Type.Literal('deny'),
    message: Type.Optional(Type.String()),
    interruptTurn: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    kind: Type.Literal('answer'),
    answers: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
  }),
  /** Harness-specific decision passed through verbatim. */
  Type.Object({ kind: Type.Literal('native'), payload: Type.Unknown() }),
]);
export type Decision = Static<typeof Decision>;
export type DecisionKind = Decision['kind'];

/**
 * Who answers a request. Chosen by the host's `Policy.resolve`. Only `human`
 * requests are ever pushed to people; the default is `auto`.
 */
export const Resolver = Type.Union([
  Type.Object({ kind: Type.Literal('auto'), decision: Decision }),
  Type.Object({ kind: Type.Literal('model'), model: Type.String(), prompt: Type.Optional(Type.String()) }),
  Type.Object({
    kind: Type.Literal('human'),
    principals: Type.Array(Type.String()),
    routes: Type.Array(Type.String()),
  }),
  /** The host answers asynchronously via a `resolve` command. */
  Type.Object({ kind: Type.Literal('host') }),
]);
export type Resolver = Static<typeof Resolver>;

export const ResolvedBy = Type.Union([
  Type.Object({
    kind: Type.Union([
      Type.Literal('auto'),
      Type.Literal('model'),
      Type.Literal('human'),
      Type.Literal('host'),
      Type.Literal('harness'),
    ]),
    id: Type.Optional(Type.String()),
  }),
  Type.Literal('timeout'),
  Type.Literal('runtime_cancelled'),
]);
export type ResolvedBy = Static<typeof ResolvedBy>;
