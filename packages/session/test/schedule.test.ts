import { describe, expect, it } from 'vitest';
import { FakeHarness } from '@agents-io/testkit';
import { Hub, Lane, ScheduleDispatcher, ScheduleRegistry, SqliteSessionLog, nextCron, parseCron } from '../src/index.js';
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
