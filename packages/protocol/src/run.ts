import { Type, type Static } from '@sinclair/typebox';

/**
 * How one turn runs. Harness (Claude Code, Codex, …) and model are independent:
 * the harness provides tools, sandbox and session; the model provides intelligence.
 * agents-io passes `model` through untouched.
 */
export const RunSpec = Type.Object({
  harness: Type.String(),
  model: Type.String(),
  effort: Type.Optional(Type.String()),
  /** Permission profile name; mapped to harness-native settings by deployment config. */
  profile: Type.String(),
});
export type RunSpec = Static<typeof RunSpec>;

export const HarnessCaps = Type.Object({
  /** native: mid-turn injection; tool_boundary: only between tool calls; none: queue only. */
  steer: Type.Union([Type.Literal('native'), Type.Literal('tool_boundary'), Type.Literal('none')]),
  interrupt: Type.Boolean(),
  approvals: Type.Boolean(),
  questions: Type.Boolean(),
  tokenDeltas: Type.Boolean(),
  cancelQueued: Type.Boolean(),
  /** Can add context without starting a turn. */
  injectWithoutTurn: Type.Boolean(),
  resume: Type.Boolean(),
  switchModelMidSession: Type.Boolean(),
  models: Type.Optional(Type.Array(Type.String())),
});
export type HarnessCaps = Static<typeof HarnessCaps>;
