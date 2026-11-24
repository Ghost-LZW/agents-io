import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { InputRecord, Origin, ReplyRoute, ScheduleDraft, ScheduleWhen } from '@agents-io/protocol';
import type { CommandResult, Lane } from './lane.js';

/*
 * Schedules (docs/design/schedules): at a set time the daemon puts one input into a
 * session (a turn), sends one message, or hands one item to the host.
 *
 * `ScheduleRegistry` keeps the definitions and when each fires next (SQLite, next to
 * the log), plus a pending marker per firing so a firing cut off by a crash is redone
 * with the same input id (SC-1). `ScheduleDispatcher` runs one timer for the nearest
 * `nextAt`, fires what is due, and on start handles what was missed while stopped
 * (`missed`: once or skip, SC-2).
 */

export type { ScheduleDraft, ScheduleWhen };
export type ScheduleAction = NonNullable<ScheduleDraft['action']>;

export interface Schedule extends Required<Pick<ScheduleDraft, 'when' | 'text'>> {
  id: string;
  action: ScheduleAction;
  target?: { sessionKey: string };
  route?: ReplyRoute;
  missed: 'once' | 'skip';
  until?: number;
  note?: string;
  meta?: Record<string, string>;
  /** `creatorOf(origin)`: a principal id, `session:<key>` for an agent, `host:<name>`, `config`. */
  createdBy: string;
  createdAt: number;
  /** Next time it fires (Unix ms); null: it will not fire again. */
  nextAt: number | null;
  lastFiredAt?: number;
}

export class ScheduleError extends Error {
  override name = 'ScheduleError';
  constructor(
    readonly code: 'invalid' | 'forbidden' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

// ---- cron -------------------------------------------------------------------------------------

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Both day fields restricted: a day matches either (classic cron). */
  domStar: boolean;
  dowStar: boolean;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** Five-field cron (`m h dom mon dow`): `*`, lists, ranges, steps; dow 0 and 7 are Sunday. */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduleError('invalid', `cron needs five fields (minute hour day month weekday), got ${JSON.stringify(expr)}`);
  const sets = parts.map((p, i) => {
    const [lo, hi] = RANGES[i]!;
    const out = new Set<number>();
    for (const item of p.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new ScheduleError('invalid', `cron field ${i + 1} ${JSON.stringify(p)} is not *, a number, a range or a step`);
      const step = m[2] ? Number(m[2]) : 1;
      if (step < 1) throw new ScheduleError('invalid', `cron step must be at least 1 in ${JSON.stringify(p)}`);
      let a = lo;
      let b = hi;
      if (m[1] !== '*') {
        const [x, y] = m[1]!.split('-').map(Number) as [number, number | undefined];
        a = x;
        b = y ?? (m[2] ? hi : x);
      }
      if (a < lo || b > hi || a > b) throw new ScheduleError('invalid', `cron field ${i + 1} ${JSON.stringify(p)} is outside ${lo}-${hi}`);
      for (let v = a; v <= b; v += step) out.add(i === 4 && v === 7 ? 0 : v);
    }
    return out;
  });
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dom: sets[2]!,
    month: sets[3]!,
    dow: sets[4]!,
    domStar: parts[2] === '*',
    dowStar: parts[4] === '*',
  };
}

/** Wall-clock fields of `ms` in `tz`. */
function wall(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? '';
  const dows: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: Number(get('year')), mo: Number(get('month')), d: Number(get('day')), h: Number(get('hour')), mi: Number(get('minute')), dow: dows[get('weekday')] ?? 0 };
}

export function checkTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ScheduleError('invalid', `time zone ${JSON.stringify(tz)} is not known`);
  }
}

/**
 * The first minute after `after` (Unix ms) that matches, in `tz`. Walks minute by minute with
 * skips (an hour or a day at a time when those fields do not match); null if none within ~5 years.
 */
export function nextCron(expr: string, tz: string, after: number): number | null {
  const c = parseCron(expr);
  checkTimeZone(tz);
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  const end = after + 5 * 366 * 24 * 3600_000;
  while (t <= end) {
    const w = wall(t, tz);
    const dayOk = c.domStar && c.dowStar ? true : c.domStar ? c.dow.has(w.dow) : c.dowStar ? c.dom.has(w.d) : c.dom.has(w.d) || c.dow.has(w.dow);
    if (!c.month.has(w.mo) || !dayOk) {
      t += ((23 - w.h) * 60 + (60 - w.mi)) * 60_000; // to the next local midnight
      continue;
    }
    if (!c.hour.has(w.h)) {
      t += (60 - w.mi) * 60_000; // to the next hour
      continue;
    }
    if (c.minute.has(w.mi)) return t;
    t += 60_000;
  }
  return null;
}

/** When a schedule fires next after `after`; null when it never will. */
export function nextFire(when: ScheduleWhen, after: number, defaultTz: string, createdAt: number): number | null {
  if ('cron' in when) return nextCron(when.cron, when.tz ?? defaultTz, after);
  if ('everyMinutes' in when) {
    const period = Math.round(when.everyMinutes * 60_000);
    const n = Math.floor((after - createdAt) / period) + 1;
    return createdAt + n * period;
  }
  const at = typeof when.at === 'number' ? when.at : Date.parse(when.at);
  return at > after ? at : null;
}

/** Checks a draft's shape (not who may create it); throws ScheduleError. */
export function checkDraft(d: ScheduleDraft, defaultTz: string): void {
  if (!d || typeof d !== 'object') throw new ScheduleError('invalid', 'a schedule is an object');
  if (d.id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(d.id)) throw new ScheduleError('invalid', `id ${JSON.stringify(d.id)}: letters, digits, . _ : - (at most 64)`);
  if (typeof d.text !== 'string' || !d.text.trim()) throw new ScheduleError('invalid', 'text is required');
  const action = d.action ?? 'turn';
  if (!['turn', 'message', 'host'].includes(action)) throw new ScheduleError('invalid', 'action is turn, message or host');
  if (action === 'turn' && !d.target?.sessionKey) throw new ScheduleError('invalid', 'action turn needs target.sessionKey');
  if (action === 'message' && !d.route) throw new ScheduleError('invalid', 'action message needs a route');
  if (d.missed !== undefined && d.missed !== 'once' && d.missed !== 'skip') throw new ScheduleError('invalid', 'missed is once or skip');
  const w = d.when as Record<string, unknown> | undefined;
  if (!w || typeof w !== 'object') throw new ScheduleError('invalid', 'when is { cron, tz? }, { at } or { everyMinutes }');
  const keys = ['cron', 'at', 'everyMinutes'].filter((k) => w[k] !== undefined);
  if (keys.length !== 1) throw new ScheduleError('invalid', 'when has exactly one of cron, at, everyMinutes');
  if (typeof w.cron === 'string') {
    parseCron(w.cron);
    checkTimeZone(typeof w.tz === 'string' ? w.tz : defaultTz);
  } else if (w.cron !== undefined) throw new ScheduleError('invalid', 'when.cron is a string');
  if (w.at !== undefined && !Number.isFinite(typeof w.at === 'number' ? w.at : Date.parse(String(w.at))))
    throw new ScheduleError('invalid', `when.at ${JSON.stringify(w.at)} is not a time (ISO 8601 or Unix ms)`);
  if (w.everyMinutes !== undefined && !(typeof w.everyMinutes === 'number' && w.everyMinutes >= 1))
    throw new ScheduleError('invalid', 'when.everyMinutes is a number of at least 1');
}

/** The shortest period between two firings, in minutes (a cron: its tightest gap over the next day). */
export function shortestMinutes(when: ScheduleWhen, defaultTz: string, now: number): number {
  if ('everyMinutes' in when) return when.everyMinutes;
  if ('at' in when) return Infinity;
  let prev = nextCron(when.cron, when.tz ?? defaultTz, now);
  let min = Infinity;
  for (let i = 0; prev !== null && i < 64; i++) {
    const n = nextCron(when.cron, when.tz ?? defaultTz, prev);
    if (n === null || n - now > 2 * 24 * 3600_000) break;
    min = Math.min(min, (n - prev) / 60_000);
    prev = n;
  }
  return min;
}

// ---- registry ---------------------------------------------------------------------------------

export interface ScheduleRegistryOptions {
  path?: string;
  db?: DatabaseSync;
  now?: () => number;
  /** For cron schedules without `tz` (default: the process's). */
  timeZone?: string;
}

export class ScheduleRegistry {
  readonly db: DatabaseSync;
  readonly timeZone: string;
  private readonly owned: boolean;
  private readonly now: () => number;

  constructor(o: ScheduleRegistryOptions = {}) {
    this.owned = !o.db;
    this.db = o.db ?? new DatabaseSync(o.path ?? ':memory:');
    this.now = o.now ?? Date.now;
    this.timeZone = o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, def TEXT NOT NULL, next_at INTEGER, last_fired_at INTEGER);
      CREATE INDEX IF NOT EXISTS schedules_next ON schedules(next_at);
      CREATE TABLE IF NOT EXISTS schedule_firing (id TEXT NOT NULL, scheduled_at INTEGER NOT NULL, PRIMARY KEY (id, scheduled_at));
    `);
  }

  close(): void {
    if (this.owned) this.db.close();
  }

  private row(r: Record<string, unknown> | undefined): Schedule | undefined {
    if (!r) return undefined;
    const s = JSON.parse(String(r.def)) as Schedule;
    s.nextAt = r.next_at === null ? null : Number(r.next_at);
    if (r.last_fired_at !== null && r.last_fired_at !== undefined) s.lastFiredAt = Number(r.last_fired_at);
    return s;
  }

  get(id: string): Schedule | undefined {
    return this.row(this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Record<string, unknown> | undefined);
  }

  list(): Schedule[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY id').all() as Record<string, unknown>[]).map((r) => this.row(r)!);
  }

  /** Adds or replaces a schedule; returns it with its first `nextAt`. */
  put(d: ScheduleDraft, createdBy: string, id?: string): Schedule {
    checkDraft(d, this.timeZone);
    const now = this.now();
    const s: Schedule = {
      id: d.id ?? id ?? `sc_${randomUUID().slice(0, 8)}`,
      when: d.when,
      action: d.action ?? 'turn',
      ...(d.target ? { target: d.target } : {}),
      ...(d.route ? { route: d.route } : {}),
      text: d.text,
      missed: d.missed ?? 'once',
      ...(d.until !== undefined ? { until: d.until } : {}),
      ...(d.note ? { note: d.note } : {}),
      ...(d.meta ? { meta: d.meta } : {}),
      createdBy,
      createdAt: now,
      nextAt: null,
    };
    s.nextAt = this.upcoming(s, now);
    const { nextAt: _n, lastFiredAt: _l, ...def } = s;
    this.db.prepare('INSERT OR REPLACE INTO schedules (id, def, next_at, last_fired_at) VALUES (?, ?, ?, NULL)').run(s.id, JSON.stringify(def), s.nextAt);
    return s;
  }

  remove(id: string): boolean {
    this.db.prepare('DELETE FROM schedule_firing WHERE id = ?').run(id);
    return Number(this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes) > 0;
  }

  /** The next firing after `after`, or null (past `until`, a fired one-shot). */
  upcoming(s: Schedule, after: number): number | null {
    const n = nextFire(s.when, after, this.timeZone, s.createdAt);
    return n === null || (s.until !== undefined && n > s.until) ? null : n;
  }

  /** The nearest `nextAt` of all, or undefined. */
  nearest(): number | undefined {
    const r = this.db.prepare('SELECT MIN(next_at) AS t FROM schedules WHERE next_at IS NOT NULL').get() as { t: number | null };
    return r.t === null ? undefined : Number(r.t);
  }

  due(now: number): Schedule[] {
    return (this.db.prepare('SELECT * FROM schedules WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at').all(now) as Record<string, unknown>[]).map((r) => this.row(r)!);
  }

  /** Marks a firing begun (before it is delivered): a crash leaves it here to be redone. */
  begin(id: string, scheduledAt: number): void {
    this.db.prepare('INSERT OR IGNORE INTO schedule_firing (id, scheduled_at) VALUES (?, ?)').run(id, scheduledAt);
  }

  pending(): { id: string; scheduledAt: number }[] {
    return (this.db.prepare('SELECT id, scheduled_at FROM schedule_firing ORDER BY scheduled_at').all() as { id: string; scheduled_at: number }[]).map((r) => ({ id: r.id, scheduledAt: Number(r.scheduled_at) }));
  }

  /** The firing is delivered: its marker goes and the schedule moves to its next time (or is removed). */
  end(id: string, scheduledAt: number, firedAt: number): void {
    this.db.exec('SAVEPOINT sc_end');
    try {
      this.db.prepare('DELETE FROM schedule_firing WHERE id = ? AND scheduled_at = ?').run(id, scheduledAt);
      const s = this.get(id);
      if (s) {
        const next = this.upcoming(s, Math.max(scheduledAt, firedAt));
        if (next === null) this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
        else this.db.prepare('UPDATE schedules SET next_at = ?, last_fired_at = ? WHERE id = ?').run(next, firedAt, id);
      }
      this.db.exec('RELEASE sc_end');
    } catch (e) {
      this.db.exec('ROLLBACK TO sc_end');
      this.db.exec('RELEASE sc_end');
      throw e;
    }
  }

  /** A missed firing that is skipped: the schedule moves on without firing. */
  skip(id: string, now: number): void {
    const s = this.get(id);
    if (!s) return;
    const next = this.upcoming(s, now);
    if (next === null) this.remove(id);
    else this.db.prepare('UPDATE schedules SET next_at = ? WHERE id = ?').run(next, id);
  }
}

// ---- dispatcher -------------------------------------------------------------------------------

export interface ScheduleDispatcherOptions {
  registry: ScheduleRegistry;
  lanes: (sessionKey: string) => Lane | Promise<Lane>;
  /** Where a turn's answer goes when the schedule names no route (the session's home route). */
  replyRoute?: (sessionKey: string) => ReplyRoute | null | Promise<ReplyRoute | null>;
  /** action message: send it (through the outbox, operationId given). */
  send?: (s: Schedule, operationId: string) => Promise<void>;
  /** action host: hand it to the host (its inbound queue). */
  toHost?: (s: Schedule, input: InputRecord) => Promise<void>;
  now?: () => number;
  onError?: (err: unknown, id: string) => void;
}

/** A firing older than this at start counts as missed (a timer a little late is not). */
const LATE_MS = 60_000;

export class ScheduleDispatcher {
  readonly registry: ScheduleRegistry;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(private readonly o: ScheduleDispatcherOptions) {
    this.registry = o.registry;
    this.now = o.now ?? Date.now;
  }

  /** Redoes firings a crash cut off, handles what was missed while stopped, arms the timer. */
  start(): void {
    this.stopped = false;
    this.running = (async () => {
      for (const p of this.registry.pending()) await this.fireOnce(p.id, p.scheduledAt, false);
      const now = this.now();
      for (const s of this.registry.due(now - LATE_MS)) {
        if (s.missed === 'skip') this.registry.skip(s.id, now);
        else await this.fireOnce(s.id, this.latestMissed(s, now), true);
      }
    })()
      .catch((e) => this.o.onError?.(e, '*'))
      .finally(() => {
        this.running = undefined;
        this.arm();
      });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Resolves when nothing is firing (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** The registry changed (a schedule added or removed): re-arm for the nearest time. */
  changed(): void {
    if (!this.running) this.arm();
  }

  /** Fires everything due now (the timer's job; tests call it with a moved clock). */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      const now = this.now();
      for (const s of this.registry.due(now)) await this.fireOnce(s.id, s.nextAt!, now - s.nextAt! > LATE_MS);
    })()
      .catch((e) => this.o.onError?.(e, '*'))
      .finally(() => {
        this.running = undefined;
        this.arm();
      });
    return this.running;
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.registry.nearest();
    if (next === undefined) return;
    const delay = Math.max(0, Math.min(next - this.now(), 2 ** 31 - 1));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  /** The most recent time it should have fired at or before `now` (missed once: only that one). */
  private latestMissed(s: Schedule, now: number): number {
    let at = s.nextAt!;
    for (let i = 0; i < 100_000; i++) {
      const n = this.registry.upcoming(s, at);
      if (n === null || n > now) break;
      at = n;
    }
    return at;
  }

  private async fireOnce(id: string, scheduledAt: number, missed: boolean): Promise<void> {
    const s = this.registry.get(id);
    if (!s) {
      this.registry.end(id, scheduledAt, this.now());
      return;
    }
    this.registry.begin(id, scheduledAt);
    try {
      await this.deliver(s, scheduledAt, missed);
    } catch (e) {
      // Not delivered: the marker stays, the next start redoes it with the same id (SC-1).
      this.o.onError?.(e, id);
      return;
    }
    this.registry.end(id, scheduledAt, this.now());
  }

  private async deliver(s: Schedule, scheduledAt: number, missed: boolean): Promise<void> {
    const inputId = `schedule:${s.id}:${scheduledAt}`;
    const origin: Origin = { kind: 'system', principal: null, evidence: 'none', via: `schedule:${s.id}`, adapter: 'schedule' };
    const text = `[schedule ${s.id}] ${s.text}${s.note ? `\nnote: ${s.note}` : ''}`;
    const channelContext = {
      schedule: s.id,
      scheduledAt: new Date(scheduledAt).toISOString(),
      firedAt: new Date(this.now()).toISOString(),
      ...(missed ? { missed: true } : {}),
      createdBy: s.createdBy,
      ...Object.fromEntries(Object.entries(s.meta ?? {}).map(([k, v]) => [`schedule.${k}`, v])),
    };
    if (s.action === 'message') {
      if (!this.o.send) throw new Error('this host cannot send scheduled messages');
      await this.o.send(s, inputId);
      return;
    }
    const replyRoute = s.route ?? (s.target ? ((await this.o.replyRoute?.(s.target.sessionKey)) ?? null) : null);
    const input: InputRecord = { inputId, origin, content: [{ type: 'text', text }], replyRoute, channelContext };
    if (s.action === 'host') {
      if (!this.o.toHost) throw new Error('no host takes scheduled items');
      await this.o.toHost(s, input);
      return;
    }
    const key = s.target!.sessionKey;
    const lane = await this.o.lanes(key);
    await lane.notice(`schedule ${s.id}: ${missed ? 'missed firing, ' : ''}due ${new Date(scheduledAt).toISOString()}`, 'primary');
    const r: CommandResult = await lane.command({ type: 'input', sessionKey: key, input, mode: 'queue' });
    // A redo the session already has (the earlier process admitted it, then died) answers
    // disposition "duplicate": it was delivered once, which is all that is wanted (SC-1).
    if (!r.ok) throw new Error(`schedule ${s.id} not queued: ${r.reason}`);
  }
}
