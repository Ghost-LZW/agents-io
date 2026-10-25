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

const HumanResolver = Type.Object({
  kind: Type.Literal('human'),
  principals: Type.Array(Type.String()),
  routes: Type.Array(Type.String()),
  /**
   * Deny the request unanswered after this long (instead of the session's default; a request
   * whose harness set `expiresAt` keeps that). E.g. shorter for a turn nobody is present for.
   */
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  /** One line shown with the request wherever it renders (why it is asked, what "always" would keep). */
  note: Type.Optional(Type.String({ maxLength: 500 })),
  /**
   * What the request's line starts with, before its title, wherever it renders: the host knows
   * its people's language, agents-io does not (default `Approval needed: ` / `Answer needed: `;
   * e.g. `需要批准：`).
   */
  heading: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  /**
   * `allow_once`: a person's `allow_session` reaches the harness as `allow_once` (the host keeps
   * the "always" itself, revocably, rather than the harness's own permission rules); the recorded
   * decision stays `allow_session`.
   */
  allowSessionAs: Type.Optional(Type.Literal('allow_once')),
});

/**
 * Who answers a request. Chosen by the host's `Policy.resolve`. Only `human`
 * requests are ever pushed to people; the default is `auto`.
 */
export const Resolver = Type.Union([
  Type.Object({ kind: Type.Literal('auto'), decision: Decision }),
  Type.Object({
    kind: Type.Literal('model'),
    model: Type.String(),
    prompt: Type.Optional(Type.String()),
    /**
     * Who answers when the review escalates or cannot decide (no reviewer, an error, a timeout);
     * without it `Policy.escalate` decides.
     */
    escalate: Type.Optional(Type.Union([Type.Object({ kind: Type.Literal('auto'), decision: Decision }), HumanResolver])),
  }),
  HumanResolver,
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
    /** The principal the answer counts as. */
    id: Type.Optional(Type.String()),
    /** Relayed by this host connection on `id`'s behalf (`resolve { onBehalfOf }`), e.g. `host:<name>`. */
    via: Type.Optional(Type.String()),
  }),
  Type.Literal('timeout'),
  Type.Literal('runtime_cancelled'),
]);
// A harness-native reviewer (e.g. Codex auto review) is `{ kind: 'harness', id: 'auto_review' }`.

/** Structured question carried by a `question` / `elicitation` request. */
export const RequestQuestion = Type.Object({
  id: Type.String(),
  text: Type.String(),
  header: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }))),
  multiSelect: Type.Optional(Type.Boolean()),
  /** Answer must not be echoed to other ends. */
  secret: Type.Optional(Type.Boolean()),
});
export type RequestQuestion = Static<typeof RequestQuestion>;
export type ResolvedBy = Static<typeof ResolvedBy>;
