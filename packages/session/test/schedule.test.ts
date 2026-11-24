import { describe, expect, it, vi } from 'vitest';
import { FakeHarness } from '@agents-io/testkit';
import { FinalFiringError, Hub, Lane, ScheduleDispatcher, ScheduleRegistry, SqliteSessionLog, nextCron, parseCron } from '../src/index.js';
import { until } from './helpers.js';

const T0 = Date.parse('2026-10-27T00:30:00Z'); // 08:30 in Shanghai, a Tuesday
const SH = 'Asia/Shanghai';

function world(now: { t: number }) {
  const log = new SqliteSessionLog();
  const hub = new Hub(log);
  const lanes = new Map<string, Lane>();
  const registry = new ScheduleRegistry({ db: log.db, now: () => now.t, timeZone: SH });
  const sent: string[] = [];
  const make = () =>
    new ScheduleDispatcher({
      registry,
      now: () => now.t,
      lanes: (k) => lanes.get(k) ?? lanes.set(k, new Lane({ sessionKey: k, harness: new FakeHarness(), hub })).get(k)!,
      send: async (s, op) => void sent.push(`${s.id}@${op}`),
    });
  // What reached the session: each admitted input once, with its record from the admission or the turn that took it.
  const inputs = (key = 'main') => {
    const evs = log.read(key, 0);
    const records = new Map<string, { inputId: string; channelContext: Record<string, unknown> }>();
    for (const e of evs) {
      const b = e.body as { t: string; input?: { inputId: string; channelContext: Record<string, unknown> }; inputs?: { inputId: string; channelContext: Record<string, unknown> }[] };
      if (b.t === 'input.admitted' && b.input) records.set(b.input.inputId, b.input);
      if (b.t === 'turn.started') for (const i of b.inputs ?? []) records.set(i.inputId, i);
    }
    const ids = evs.filter((e) => e.body.t === 'input.admitted').map((e) => (e.body as { inputId: string }).inputId);
    return ids.map((id) => records.get(id) ?? { inputId: id, channelContext: {} });
  };
  return { log, registry, make, inputs, sent };
}

describe('cron', () => {
  it('reads five fields with lists, ranges and steps; weekday 7 is Sunday #SC-1', () => {
    const c = parseCron('*/15 9-17 * * 1-5,7');
    expect([...c.minute]).toEqual([0, 15, 30, 45]);
    expect([...c.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...c.dow].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(() => parseCron('0 9 * *')).toThrow(/five fields/);
    expect(() => parseCron('61 * * * *')).toThrow(/outside 0-59/);
  });

  it('finds the next time in a time zone, across days and weekends #SC-1', () => {
    // 09:00 on weekdays, Shanghai: from Tuesday 08:30 → Tuesday 09:00 (01:00Z).
    expect(new Date(nextCron('0 9 * * 1-5', SH, T0)!).toISOString()).toBe('2026-10-27T01:00:00.000Z');
    // From Friday 09:00 → Monday 09:00.
    const fri = Date.parse('2026-10-30T01:00:00Z');
    expect(new Date(nextCron('0 9 * * 1-5', SH, fri)!).toISOString()).toBe('2026-11-02T01:00:00.000Z');
    // Day of month and weekday both set: either matches (classic cron).
    expect(new Date(nextCron('0 0 1 * 0', 'UTC', Date.parse('2026-10-27T12:00:00Z'))!).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('schedules', () => {
  it('fires a turn into the session at its time, once, then moves to the next time #SC-1', async () => {
    const now = { t: T0 };
    const w = world(now);
    const d = w.make();
    const s = w.registry.put({ id: 'morning', when: { cron: '0 9 * * *' }, target: { sessionKey: 'main' }, text: 'check the calendar', note: 'daily' }, 'config');
    expect(new Date(s.nextAt!).toISOString()).toBe('2026-10-27T01:00:00.000Z');
    d.start();
    await d.idle();
    expect(w.inputs()).toEqual([]);
    now.t = s.nextAt! + 1000;
    await d.tick();
    await d.tick(); // again at the same time: nothing more
    await until(() => w.inputs().length === 1);
    const [i] = w.inputs();
    expect(i).toMatchObject({ inputId: `schedule:morning:${s.nextAt}`, channelContext: { schedule: 'morning', scheduledAt: '2026-10-27T01:00:00.000Z' } });
    expect(w.registry.get('morning')?.nextAt).toBe(Date.parse('2026-10-28T01:00:00Z'));
    d.stop();
    w.log.close();
  });

  it('a firing cut off before it was settled is redone with the same input id, and the session keeps one #SC-1', async () => {
    const now = { t: T0 };
    const w = world(now);
    const s = w.registry.put({ id: 'r', when: { at: T0 + 60_000 }, target: { sessionKey: 'main' }, text: 'remind me' }, 'config');
    now.t = s.nextAt!;
    const first = w.make();
    first.start();
    await first.idle();
    await first.tick();
    await until(() => w.inputs().length === 1);
    // As if the process died after delivering and before settling: the marker is back.
    w.registry.put({ id: 'r', when: { at: T0 + 60_000 }, target: { sessionKey: 'main' }, text: 'remind me' }, 'config');
    w.registry.begin('r', s.nextAt!);
    first.stop();
    const again = w.make();
    again.start();
    await again.idle();
    expect(w.inputs()).toHaveLength(1);
    expect(w.registry.pending()).toEqual([]);
    expect(w.registry.get('r')).toBeUndefined(); // a one-shot is gone once fired
    again.stop();
    w.log.close();
  });

  it('missed while stopped: "once" fires the latest missed time once, "skip" moves on without firing #SC-2', async () => {
    const now = { t: T0 };
    const w = world(now);
    w.registry.put({ id: 'hourly', when: { cron: '0 * * * *' }, target: { sessionKey: 'main' }, text: 'tick' }, 'config');
    w.registry.put({ id: 'quiet', when: { cron: '0 * * * *' }, target: { sessionKey: 'other' }, text: 'tock', missed: 'skip' }, 'config');
    now.t = T0 + 5 * 3600_000; // five hours later, the daemon starts again
    const d = w.make();
    d.start();
    await d.idle();
    await until(() => w.inputs().length === 1);
    expect(w.inputs()[0]).toMatchObject({ channelContext: { missed: true, scheduledAt: '2026-10-27T05:00:00.000Z' } });
    expect(w.inputs('other')).toEqual([]);
    expect(w.registry.get('quiet')?.nextAt).toBe(Date.parse('2026-10-27T06:00:00Z'));
    d.stop();
    w.log.close();
  });

  it('a message schedule sends through the host, with the firing as its operation id #SC-1', async () => {
    const now = { t: T0 };
    const w = world(now);
    w.registry.put({ id: 'ping', when: { everyMinutes: 30 }, action: 'message', route: { channel: 'fake', account: 'default', conversationId: 'c1' }, text: 'still here' }, 'config');
    const d = w.make();
    d.start();
    await d.idle();
    now.t = T0 + 30 * 60_000;
    await d.tick();
    expect(w.sent).toEqual([`ping@schedule:ping:${T0 + 30 * 60_000}`]);
    d.stop();
    w.log.close();
  });

  // INVARIANTS SC-1 不成立 (2026-11-24): a failed firing keeps its time, and the timer re-arms at once: it is retried in a busy loop.
  it('a firing that fails is tried again later, after a delay that grows, never at once; each try is the same firing (its operation id) #SC-1', async () => {
    const now = { t: T0 };
    const w = world(now);
    const tried: string[] = [];
    const errors: string[] = [];
    let failing = 3;
    const d = new ScheduleDispatcher({
      registry: w.registry,
      now: () => now.t,
      lanes: () => {
        throw new Error('no turns here');
      },
      send: async (_s, op) => {
        tried.push(op);
        if (failing-- > 0) throw new Error('not now');
      },
      retry: { minMs: 10_000, maxMs: 30_000 },
      onError: (e) => errors.push((e as Error).message),
    });
    w.registry.put({ id: 'ping', when: { everyMinutes: 30 }, action: 'message', route: { channel: 'fake', account: 'default', conversationId: 'c1' }, text: 'still here' }, 'config');
    d.start();
    await d.idle();
    const at = T0 + 30 * 60_000;
    const after = async (ms: number) => {
      now.t = at + ms;
      await d.tick();
      return tried.length;
    };
    expect(await after(0)).toBe(1);
    expect(await after(0)).toBe(1); // not again at once
    expect(await after(9_999)).toBe(1);
    expect(await after(10_000)).toBe(2); // the first wait: 10 s
    expect(await after(29_999)).toBe(2);
    expect(await after(30_000)).toBe(3); // then 20 s
    expect(await after(59_999)).toBe(3);
    expect(await after(60_000)).toBe(4); // then 30 s (the cap), and it went out
    expect(await after(600_000)).toBe(4);
    expect(tried).toEqual(Array(4).fill(`schedule:ping:${at}`));
    expect(errors).toEqual(['not now', 'not now', 'not now']);
    // Delivered: the marker is gone, the schedule moved on from the time it was due.
    expect(w.registry.pending()).toEqual([]);
    expect(w.registry.get('ping')?.nextAt).toBe(at + 30 * 60_000);
    d.stop();
    w.log.close();
  });

  // INVARIANTS SC-1 不成立 (2026-11-24): a firing that can never succeed (held, denied, out of scope, no channel) is retried forever.
  it('a firing that fails for good (an error with final: true) is over: recorded as failed, not tried again; the schedule moves to its next time, a one-shot is gone #SC-1', async () => {
    const now = { t: T0 };
    const w = world(now);
    const tried: string[] = [];
    const failed: string[] = [];
    const errors: unknown[] = [];
    const d = new ScheduleDispatcher({
      registry: w.registry,
      now: () => now.t,
      lanes: () => {
        throw new Error('no turns here');
      },
      send: async (_s, op) => {
        tried.push(op);
        throw Object.assign(new Error('held by the host'), { final: true });
      },
      onFailed: (s, scheduledAt, e) => failed.push(`${s.id}@${scheduledAt}: ${(e as Error).message}`),
      onError: (e) => errors.push(e),
    });
    const route = { channel: 'fake', account: 'default', conversationId: 'c1' };
    w.registry.put({ id: 'hourly', when: { cron: '0 * * * *' }, action: 'message', route, text: 'tick' }, 'config');
    w.registry.put({ id: 'once', when: { at: T0 + 60_000 }, action: 'message', route, text: 'just once' }, 'config');
    d.start();
    await d.idle();
    const at = Date.parse('2026-10-27T01:00:00Z');
    now.t = at;
    await d.tick();
    await d.tick();
    now.t = at + 30 * 60_000;
    await d.tick();
    expect(tried.sort()).toEqual([`schedule:hourly:${at}`, `schedule:once:${T0 + 60_000}`]);
    expect(failed.sort()).toEqual([`hourly@${at}: held by the host`, `once@${T0 + 60_000}: held by the host`]);
    expect(errors).toEqual([]);
    expect(w.registry.pending()).toEqual([]);
    expect(w.registry.get('once')).toBeUndefined();
    // The recurring one waits for its next time; it did not fire, so it has no last firing.
    expect(w.registry.get('hourly')).toMatchObject({ nextAt: at + 3600_000 });
    expect(w.registry.get('hourly')?.lastFiredAt).toBeUndefined();
    d.stop();
    w.log.close();
  });

  it("a schedule whose firing failed for good says why (lastFailure), kept with it across a restart, until a firing is delivered; a peer's keeps the module it was set through #SC-1 #SC-3", async () => {
    const now = { t: T0 };
    const w = world(now);
    let refuse = true;
    const sent: string[] = [];
    const d = new ScheduleDispatcher({
      registry: w.registry,
      now: () => now.t,
      lanes: () => {
        throw new Error('no turns here');
      },
      send: async (_s, op) => {
        if (refuse) throw Object.assign(new Error('set by peer:x through module peers, which is off; not sent'), { final: true });
        sent.push(op);
      },
    });
    const route = { channel: 'fake', account: 'default', conversationId: 'c1' };
    expect(w.registry.put({ id: 'hourly', when: { cron: '0 * * * *' }, action: 'message', route, text: 'tick' }, 'peer:x', undefined, 'peers')).toMatchObject({ module: 'peers', createdBy: 'peer:x' });
    d.start();
    await d.idle();
    const at = Date.parse('2026-10-27T01:00:00Z');
    now.t = at + 5_000;
    await d.tick();
    // Another registry on the same database (the next start) reads the same.
    const again = new ScheduleRegistry({ db: w.log.db, now: () => now.t, timeZone: SH });
    expect(again.get('hourly')).toMatchObject({ module: 'peers', nextAt: at + 3600_000, lastFailure: { scheduledAt: at, at: at + 5_000, reason: 'set by peer:x through module peers, which is off; not sent' } });
    expect(again.list().map((s) => s.lastFailure?.scheduledAt)).toEqual([at]);
    refuse = false;
    now.t = at + 3600_000;
    await d.tick();
    expect(sent).toEqual([`schedule:hourly:${at + 3600_000}`]);
    expect(w.registry.get('hourly')).toMatchObject({ module: 'peers', lastFiredAt: at + 3600_000, nextAt: at + 2 * 3600_000 });
    expect(w.registry.get('hourly')!.lastFailure).toBeUndefined();
    d.stop();
    w.log.close();
  });

  // INVARIANTS SC-3 不成立 (2026-11-24, review of the fix; 已修): a peer's one-shot whose firing failed because its module did not act for the peer was deleted, why and all: its client back restored nothing.
  it("a firing that fails for good keeping its schedule (keep: true: who set it cannot send now, SC-3) leaves a one-shot at that time, saying why, not fired again in this process; the next start fires it once as missed, skip drops it; one replaced meanwhile fires at its new time #SC-1 #SC-2 #SC-3", async () => {
    const now = { t: T0 };
    const w = world(now);
    let away = true;
    const tried: string[] = [];
    const failed: string[] = [];
    const off = (what: string) => new FinalFiringError(`set by peer:x through module peers, which is off; ${what}`, { keep: true });
    const make = () =>
      new ScheduleDispatcher({
        registry: w.registry,
        now: () => now.t,
        lanes: () => {
          throw new Error('no turns here');
        },
        send: async (s, op) => {
          tried.push(op);
          if (away) throw off('not sent');
        },
        toHost: async (_s, input) => {
          tried.push(`${input.inputId}${input.channelContext.missed ? ' (missed)' : ''}`);
          if (away) throw off('not handed to the host');
        },
        onFailed: (s, scheduledAt, _e, kept) => failed.push(`${s.id}@${scheduledAt}${kept ? ' kept' : ''}`),
      });
    const route = { channel: 'fake', account: 'default', conversationId: 'c1' };
    const at = T0 + 60_000;
    const peer = (d: Parameters<ScheduleRegistry['put']>[0]) => w.registry.put(d, 'peer:x', undefined, 'peers');
    peer({ id: 'once', when: { at }, action: 'message', route, text: 'just once' });
    peer({ id: 'wake', when: { at }, action: 'host', route, text: 'wake up', meta: { wake: 'resume' } });
    peer({ id: 'quiet', when: { at }, action: 'message', route, text: 'not late', missed: 'skip' });
    peer({ id: 'moved', when: { at }, action: 'message', route, text: 'later' });
    const d = make();
    d.start();
    await d.idle();
    now.t = at;
    await d.tick();
    expect(tried.sort()).toEqual([`schedule:moved:${at}`, `schedule:once:${at}`, `schedule:quiet:${at}`, `schedule:wake:${at}`]);
    expect(failed.sort()).toEqual([`moved@${at} kept`, `once@${at} kept`, `quiet@${at} kept`, `wake@${at} kept`]);
    expect(w.registry.pending()).toEqual([]);
    // Kept, at the time that did not go out, saying why.
    for (const id of ['once', 'wake', 'quiet', 'moved'])
      expect(w.registry.get(id)).toMatchObject({ module: 'peers', nextAt: at, lastFailure: { scheduledAt: at, at, reason: expect.stringMatching(/^set by peer:x through module peers, which is off; not (sent|handed to the host)$/) } });
    // Not fired again in this process: not by a tick, and the timer does not spin on them.
    const due = vi.spyOn(w.registry, 'due');
    now.t = at + 10 * 60_000;
    await d.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(due).toHaveBeenCalledTimes(1);
    due.mockRestore();
    expect(tried).toHaveLength(4);
    // One replaced meanwhile is a new schedule: it fires at its new time (and fails again, kept at that one).
    peer({ id: 'moved', when: { at: at + 20 * 60_000 }, action: 'message', route, text: 'later' });
    d.changed();
    now.t = at + 20 * 60_000;
    await d.tick();
    expect(tried.slice(4)).toEqual([`schedule:moved:${at + 20 * 60_000}`]);
    expect(w.registry.get('moved')).toMatchObject({ nextAt: at + 20 * 60_000, lastFailure: { scheduledAt: at + 20 * 60_000 } });
    d.stop();
    // The next start, an hour on, with who set them back: each is a missed firing; "once" fires it once, "skip" drops it.
    away = false;
    now.t = at + 3600_000;
    const again = make();
    again.start();
    await again.idle();
    expect(tried.slice(5).sort()).toEqual([`schedule:moved:${at + 20 * 60_000}`, `schedule:once:${at}`, `schedule:wake:${at} (missed)`]);
    // Delivered one-shots are done; the skipped one is gone.
    expect(w.registry.list()).toEqual([]);
    expect(w.registry.pending()).toEqual([]);
    again.stop();
    w.log.close();
  });

  it('rejects malformed schedules #SC-1', () => {
    const r = new ScheduleRegistry({ timeZone: SH });
    expect(() => r.put({ when: { cron: '0 9 * * *' }, text: 'x' }, 'config')).toThrow(/target\.sessionKey/);
    expect(() => r.put({ when: { cron: '0 9 * * *', tz: 'Mars/Base' }, target: { sessionKey: 'm' }, text: 'x' }, 'config')).toThrow(/time zone/);
    expect(() => r.put({ when: { everyMinutes: 0.5 }, target: { sessionKey: 'm' }, text: 'x' }, 'config')).toThrow(/at least 1/);
    expect(() => r.put({ when: { at: 'tomorrow' }, target: { sessionKey: 'm' }, text: 'x' }, 'config')).toThrow(/not a time/);
    expect(() => r.put({ when: { cron: '0 9 * * *' }, action: 'message', text: 'x' }, 'config')).toThrow(/needs a route/);
    r.close();
  });
});
