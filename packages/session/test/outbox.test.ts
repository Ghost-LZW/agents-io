import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { FakeChannel } from '@agents-io/testkit';
import type { RenderedMessage, ReplyRoute, SendOp } from '@agents-io/protocol';
import { DeliveryRejected, Hub, MemoryOutboxStore, MemorySessionLog, Outbox, SqliteSessionLog, defaultPolicy, type OutboxStore, type SessionLog } from '../src/index.js';
import { bodies, route, take } from './helpers.js';

class FlakyChannel extends FakeChannel {
  calls = 0;
  constructor(private failures: number, private readonly err: () => Error = () => new Error('503')) {
    super();
  }
  override async send(r: ReplyRoute, msg: RenderedMessage, op: SendOp) {
    this.calls++;
    if (this.failures-- > 0) throw this.err();
    return super.send(r, msg, op);
  }
}

/** Sends that wait until released (or forever). */
class HangingChannel extends FakeChannel {
  calls = 0;
  release: (() => void) | undefined;
  override async send(r: ReplyRoute, msg: RenderedMessage, op: SendOp) {
    this.calls++;
    await new Promise<void>((res) => (this.release = res));
    return super.send(r, msg, op);
  }
}

/** An OutboxStore on the log's own SQLite connection, like the daemon's records. */
function sqlStore(db: DatabaseSync): OutboxStore {
  db.exec('CREATE TABLE settled (id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE fly (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  const one = (sql: string, id: string) => (db.prepare(sql).get(id) as { json: string } | undefined)?.json;
  return {
    get: (id) => JSON.parse(one('SELECT json FROM settled WHERE id = ?', id) ?? 'null') ?? undefined,
    put: (rec) => {
      db.prepare('INSERT OR REPLACE INTO settled VALUES (?, ?)').run(rec.operationId, JSON.stringify(rec));
      db.prepare('DELETE FROM fly WHERE id = ?').run(rec.operationId);
    },
    begin: (rec) => void db.prepare('INSERT OR REPLACE INTO fly VALUES (?, ?)').run(rec.operationId, JSON.stringify(rec)),
    inFlight: (id) => JSON.parse(one('SELECT json FROM fly WHERE id = ? AND id NOT IN (SELECT id FROM settled)', id) ?? 'null') ?? undefined,
    allInFlight: () => (db.prepare('SELECT json FROM fly WHERE id NOT IN (SELECT id FROM settled)').all() as { json: string }[]).map((r) => JSON.parse(r.json)),
  };
}

/** From now on the log refuses `delivery.settled` (a disk error) until `heal()`. */
function refuseSettled(log: SessionLog): { heal: () => void } {
  const append = log.append.bind(log);
  let refuse = true;
  log.append = (key, d) => {
    if (refuse && d.body.t === 'delivery.settled') throw new Error('disk I/O error');
    return append(key, d);
  };
  return { heal: () => (refuse = false) };
}

const noSleep = async () => {};
const tick = () => new Promise((r) => setTimeout(r, 5));
const d = (operationId: string) => ({ operationId, sessionKey: 's', route: route(), msg: { text: 'hi' } });

describe('Outbox', () => {
  it('delivers each operationId once, even when called again or concurrently #DL-1 #DL-2', async () => {
    const hub = new Hub(new MemorySessionLog());
    const ch = new FlakyChannel(0);
    const ob = new Outbox({ hub, sleep: noSleep });
    const [a, b] = await Promise.all([ob.send(ch, d('op1')), ob.send(ch, d('op1'))]);
    const c = await ob.send(ch, d('op1'));
    expect(ch.calls).toBe(1);
    expect(a).toEqual(b);
    expect(c).toMatchObject({ status: 'delivered', providerMessageId: 'm1', attempts: 1 });
    expect(bodies(hub.log.read('s', 0))).toEqual([
      { t: 'delivery.settled', operationId: 'op1', route: route(), result: 'delivered', providerMessageId: 'm1' },
    ]);
  });

  it('retries with backoff, then settles #DL-1', async () => {
    const delays: number[] = [];
    const ch = new FlakyChannel(2);
    const ob = new Outbox({ sleep: async (ms) => void delays.push(ms), baseDelayMs: 10 });
    expect(await ob.send(ch, d('op'))).toMatchObject({ status: 'delivered', attempts: 3 });
    expect(delays).toEqual([10, 20]);
  });

  it('settles as rejected on a non-retryable error and unknown when retries run out #DL-1', async () => {
    const ob = new Outbox({ sleep: noSleep, maxAttempts: 3 });
    const rej = new FlakyChannel(1, () => new DeliveryRejected('chat not found'));
    expect(await ob.send(rej, d('r'))).toMatchObject({ status: 'rejected', attempts: 1, error: 'chat not found' });
    const down = new FlakyChannel(99);
    expect(await ob.send(down, d('u'))).toMatchObject({ status: 'unknown', attempts: 3 });
    // An unknown outcome is never replayed.
    expect(await ob.send(down, d('u'))).toMatchObject({ status: 'unknown' });
    expect(down.calls).toBe(3);
  });

  it('checks Policy.outbound for sends that come from a turn #DL-5', async () => {
    const ch = new FlakyChannel(0);
    const ob = new Outbox({ policy: defaultPolicy({ owners: [] }), sleep: noSleep });
    const from = { sessionKey: 's', turnId: 't', run: { harness: 'h', model: 'm', profile: 'p' }, inputs: [], replyRoute: route('mine') };
    expect(await ob.send(ch, { ...d('x'), from })).toMatchObject({ status: 'rejected' });
    expect(await ob.send(ch, { ...d('y'), route: route('mine'), from })).toMatchObject({ status: 'delivered' });
    expect(ch.calls).toBe(1);
  });

  it('a crash between the in-flight mark and the settlement: the next process settles it unknown and never resends #DL-2', async () => {
    const store = new MemoryOutboxStore();
    const first = new HangingChannel();
    const ob1 = new Outbox({ store, sleep: noSleep });
    void ob1.send(first, { ...d('op'), turnId: 't1' });
    await tick();
    expect(first.calls).toBe(1);
    expect(store.inFlight('op')).toMatchObject({ operationId: 'op', attempts: 1, turnId: 't1' });
    expect(ob1.get('op')).toBeUndefined();
    // The process dies here: ob1 is never heard from again. A new one over the same store:
    const hub = new Hub(new MemorySessionLog());
    const ob2 = new Outbox({ hub, store, sleep: noSleep });
    expect(ob2.recover()).toMatchObject([{ operationId: 'op', status: 'unknown', attempts: 1 }]);
    expect(store.allInFlight()).toEqual([]);
    expect(hub.log.read('s', 0).map((e) => [e.turnId, e.body])).toEqual([
      ['t1', { t: 'delivery.settled', operationId: 'op', route: route(), result: 'unknown' }],
    ]);
    const again = new FlakyChannel(0);
    expect(await ob2.send(again, d('op'))).toMatchObject({ status: 'unknown' });
    expect(again.calls).toBe(0);
  });

  it('the same operationId is not sent again while an earlier process has it in flight, even before recover #DL-2', async () => {
    const store = new MemoryOutboxStore();
    void new Outbox({ store }).send(new HangingChannel(), d('op'));
    await tick();
    const ch = new FlakyChannel(0);
    const ob2 = new Outbox({ store, sleep: noSleep });
    const [a, b] = await Promise.all([ob2.send(ch, d('op')), ob2.send(ch, d('op'))]);
    expect(a).toMatchObject({ status: 'unknown', error: expect.stringContaining('not resent') });
    expect(b).toEqual(a);
    expect(ch.calls).toBe(0);
    // Settled ones are left alone by recover.
    expect(ob2.recover()).toEqual([]);
  });

  it('marks each attempt in flight before calling the adapter, and settling clears the mark #DL-2', async () => {
    const store = new MemoryOutboxStore();
    const seen: unknown[] = [];
    const ob = new Outbox({ store, sleep: noSleep });
    const rec = await ob.deliver(d('op'), async (n) => {
      seen.push(store.inFlight('op')?.attempts);
      if (n < 2) throw new Error('503');
      return { providerMessageId: 'p' };
    });
    expect(seen).toEqual([1, 2]);
    expect(rec).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(store.inFlight('op')).toBeUndefined();
  });

  it('an attempt that times out settles unknown and is not retried (the platform may have it) #DL-1', async () => {
    const ch = new HangingChannel();
    const ob = new Outbox({ sleep: noSleep, attemptTimeoutMs: 20 });
    expect(await ob.send(ch, d('op'))).toMatchObject({ status: 'unknown', attempts: 1, error: 'attempt 1 timed out after 20 ms' });
    expect(ch.calls).toBe(1);
    // A late success changes nothing.
    ch.release!();
    await tick();
    expect(ob.get('op')).toMatchObject({ status: 'unknown' });
  });

  it('an outbound check that throws rejects (fail closed) and is settled #DL-1 #DL-5', async () => {
    const hub = new Hub(new MemorySessionLog());
    const ch = new FlakyChannel(0);
    const ob = new Outbox({ hub, policy: { outbound: async () => { throw new Error('host gone'); } }, sleep: noSleep });
    const from = { sessionKey: 's', turnId: 't', run: { harness: 'h', model: 'm', profile: 'p' }, inputs: [], replyRoute: route() };
    expect(await ob.send(ch, { ...d('x'), from })).toMatchObject({ status: 'rejected', error: 'outbound check failed: host gone' });
    expect(ch.calls).toBe(0);
    expect(bodies(hub.log.read('s', 0))).toMatchObject([{ t: 'delivery.settled', result: 'rejected' }]);
  });

  it('a settlement that throws is not a failed attempt: the adapter is not called again and the caller gets the error #DL-1 #DL-2', async () => {
    const hub = new Hub(new MemorySessionLog());
    refuseSettled(hub.log);
    const ch = new FlakyChannel(0);
    const ob = new Outbox({ hub, sleep: noSleep });
    await expect(ob.send(ch, d('op'))).rejects.toThrow('disk I/O error');
    expect(ch.calls).toBe(1);
  });

  it('atomic: the outcome, what onSettled writes and delivery.settled commit together; refused, nothing is kept but the in-flight mark, nobody saw it, and recover settles it unknown #DL-1 #DL-2', async () => {
    const log = new SqliteSessionLog();
    const store = sqlStore(log.db);
    log.db.exec('CREATE TABLE idx (id TEXT PRIMARY KEY, result TEXT NOT NULL)');
    const hub = new Hub(log);
    const sub = hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'full' });
    const onSettled = (_d: unknown, rec: { operationId: string; status: string }) => void log.db.prepare('INSERT OR REPLACE INTO idx VALUES (?, ?)').run(rec.operationId, rec.status);
    const ob = new Outbox({ hub, store, atomic: true, onSettled, sleep: noSleep });
    const ch = new FlakyChannel(0);
    expect(await ob.send(ch, d('ok'))).toMatchObject({ status: 'delivered' });
    expect(log.db.prepare('SELECT result FROM idx').all()).toEqual([{ result: 'delivered' }]);

    const disk = refuseSettled(log);
    await expect(ob.send(ch, d('op'))).rejects.toThrow('disk I/O error');
    expect(ch.calls).toBe(2);
    expect(store.get('op')).toBeUndefined();
    expect(store.inFlight('op')).toMatchObject({ operationId: 'op', attempts: 1 });
    expect(log.db.prepare("SELECT result FROM idx WHERE id = 'op'").all()).toEqual([]);
    expect(log.head('s')).toBe(1);

    // Healed (or the next process): the in-flight mark is settled unknown, logged and indexed once; never sent again.
    disk.heal();
    expect(ob.recover()).toMatchObject([{ operationId: 'op', status: 'unknown', attempts: 1 }]);
    expect(await ob.send(ch, d('op'))).toMatchObject({ status: 'unknown' });
    expect(ch.calls).toBe(2);
    expect(log.db.prepare("SELECT result FROM idx WHERE id = 'op'").all()).toEqual([{ result: 'unknown' }]);
    const seen = await take(sub, 2);
    expect(seen.map((e) => [e.seq, e.body])).toEqual([
      [1, { t: 'delivery.settled', operationId: 'ok', route: route(), result: 'delivered', providerMessageId: 'm1' }],
      [2, { t: 'delivery.settled', operationId: 'op', route: route(), result: 'unknown' }],
    ]);
    sub.close();
  });

  it('atomic: an onSettled that throws fails the settlement, even when its error ended the whole transaction; nothing commits on its own and recover settles it unknown #DL-1 #DL-2', async () => {
    const log = new SqliteSessionLog();
    const store = sqlStore(log.db);
    const hub = new Hub(log);
    const sub = hub.subscribe({ sessionKey: 's', fromSeq: 0, tier: 'full' });
    let full = true;
    // The index write fails the way SQLITE_FULL does: SQLite has already rolled the whole transaction back.
    const onSettled = () => {
      if (!full) return;
      log.db.exec('ROLLBACK');
      throw new Error('database or disk is full');
    };
    const ob = new Outbox({ hub, store, atomic: true, onSettled, sleep: noSleep });
    const ch = new FlakyChannel(0);
    await expect(ob.send(ch, d('op'))).rejects.toThrow('database or disk is full');
    expect(ch.calls).toBe(1);
    expect(store.get('op')).toBeUndefined();
    expect(store.inFlight('op')).toMatchObject({ operationId: 'op', attempts: 1 });
    // delivery.settled did not commit outside the transaction: the stored log and the memory view agree.
    expect(log.db.prepare('SELECT seq FROM events').all()).toEqual([]);
    expect(log.head('s')).toBe(0);

    full = false;
    expect(ob.recover()).toMatchObject([{ operationId: 'op', status: 'unknown', attempts: 1 }]);
    expect(ch.calls).toBe(1);
    const [e] = await take(sub, 1);
    expect([e!.seq, e!.body]).toEqual([1, { t: 'delivery.settled', operationId: 'op', route: route(), result: 'unknown' }]);
    sub.close();

    // Without atomic, onSettled is best effort: the outcome and delivery.settled are kept.
    const plain = new Hub(new MemorySessionLog());
    const best = new Outbox({ hub: plain, onSettled: () => { throw new Error('index down'); }, sleep: noSleep });
    expect(await best.send(ch, d('p'))).toMatchObject({ status: 'delivered' });
    expect(bodies(plain.log.read('s', 0))).toMatchObject([{ t: 'delivery.settled', operationId: 'p', result: 'delivered' }]);
  });

  it('a mark whose settlement failed in this process is settled unknown saying so; a mark an earlier process left says that #DL-1 #DL-2', async () => {
    const log = new SqliteSessionLog();
    const store = sqlStore(log.db);
    const hub = new Hub(log);
    const disk = refuseSettled(log);
    const ch = new FlakyChannel(0);
    const ob = new Outbox({ hub, store, atomic: true, sleep: noSleep });
    await expect(ob.send(ch, d('a'))).rejects.toThrow('disk I/O error');
    await expect(ob.send(ch, d('b'))).rejects.toThrow('disk I/O error');
    disk.heal();
    // The same operationId again in this process: not resent.
    expect(await ob.send(ch, d('a'))).toMatchObject({ status: 'unknown', attempts: 1, error: 'recording its outcome failed in this process (disk I/O error); not resent' });
    // The process stops here; the next one finds b's mark.
    const next = new Outbox({ hub, store, atomic: true, sleep: noSleep });
    expect(next.recover()).toMatchObject([{ operationId: 'b', status: 'unknown', attempts: 1, error: 'in flight when the previous process stopped; not resent' }]);
    expect(ch.calls).toBe(2);
  });

  it('drain waits for running attempts, stops retries; close leaves what still runs in flight for the next recover #DL-1', async () => {
    const store = new MemoryOutboxStore();
    const ob = new Outbox({ store, baseDelayMs: 60_000, maxDelayMs: 60_000 });
    // Running: drain waits for it.
    const slow = new HangingChannel();
    const p = ob.send(slow, d('slow'));
    // Waiting for a retry: settles unknown at once.
    const retry = ob.send(new FlakyChannel(1), d('retry'));
    await tick();
    setTimeout(() => slow.release!(), 30);
    await ob.drain(2000);
    expect(await p).toMatchObject({ status: 'delivered' });
    expect(await retry).toMatchObject({ status: 'unknown', attempts: 1, error: '503; not retried: stopping' });

    // Bounded: a send that never ends does not hold drain; after close it stays in flight.
    const stuck = new HangingChannel();
    void ob.send(stuck, d('stuck'));
    await tick();
    const t0 = Date.now();
    await ob.drain(20);
    expect(Date.now() - t0).toBeLessThan(1000);
    ob.close();
    stuck.release!();
    await tick();
    expect(store.get('stuck')).toBeUndefined();
    expect(await ob.send(new FlakyChannel(0), d('late'))).toMatchObject({ status: 'rejected', error: 'outbox closed' });
    expect(new Outbox({ store }).recover()).toMatchObject([{ operationId: 'stuck', status: 'unknown' }]);
  });
});
