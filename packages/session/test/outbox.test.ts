import { describe, expect, it } from 'vitest';
import { FakeChannel } from '@agents-io/testkit';
import type { RenderedMessage, ReplyRoute, SendOp } from '@agents-io/protocol';
import { DeliveryRejected, Hub, MemoryOutboxStore, MemorySessionLog, Outbox, defaultPolicy } from '../src/index.js';
import { bodies, route } from './helpers.js';

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
