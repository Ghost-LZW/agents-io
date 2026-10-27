import { Type, type Static } from '@sinclair/typebox';
import { ReplyRoute } from './common.js';

/**
 * A schedule (docs/design/schedules): at a set time the daemon puts one input into a
 * session (`turn`), sends one message (`message`) or hands one item to the host (`host`).
 */
export const ScheduleWhen = Type.Union([
  /** Five-field cron (minute hour day month weekday) in `tz` (default the daemon's). */
  Type.Object({ cron: Type.String(), tz: Type.Optional(Type.String()) }, { additionalProperties: false }),
  /** Once, at this time (ISO 8601 or Unix ms). */
  Type.Object({ at: Type.Union([Type.String(), Type.Number()]) }, { additionalProperties: false }),
  /** Every so many minutes (at least 1), counted from when it was made. */
  Type.Object({ everyMinutes: Type.Number({ minimum: 1 }) }, { additionalProperties: false }),
]);
export type ScheduleWhen = Static<typeof ScheduleWhen>;

export const ScheduleDraft = Type.Object(
  {
    id: Type.Optional(Type.String()),
    when: ScheduleWhen,
    action: Type.Optional(Type.Union([Type.Literal('turn'), Type.Literal('message'), Type.Literal('host')])),
    /** action turn: the session that gets the input. */
    target: Type.Optional(Type.Object({ sessionKey: Type.String() })),
    /** action message: where it goes; action turn: where the turn's answer goes (default the session's home route). */
    route: Type.Optional(ReplyRoute),
    text: Type.String(),
    /** Missed while the daemon was stopped: fire the latest once (default), or skip to the next time. */
    missed: Type.Optional(Type.Union([Type.Literal('once'), Type.Literal('skip')])),
    /** Unix ms: removed after it. */
    until: Type.Optional(Type.Number()),
    /** Why it exists; shown with the input. */
    note: Type.Optional(Type.String()),
    /** Opaque to the daemon: carried into each firing's `channelContext` (`schedule.<key>`), e.g. how a host wakes an agent. */
    meta: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);
export type ScheduleDraft = Static<typeof ScheduleDraft>;
