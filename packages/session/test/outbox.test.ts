import { describe, expect, it } from 'vitest';
import { FakeChannel } from '@agents-io/testkit';
import type { RenderedMessage, ReplyRoute, SendOp } from '@agents-io/protocol';
import { DeliveryRejected, Hub, MemorySessionLog, Outbox, defaultPolicy } from '../src/index.js';
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

const noSleep = async () => {};
const d = (operationId: string) => ({ operationId, sessionKey: 's', route: route(), msg: { text: 'hi' } });

describe('Outbox', () => {
  it('delivers each operationId once, even when called again or concurrently', async () => {
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

  it('retries with backoff, then settles', async () => {
    const delays: number[] = [];
    const ch = new FlakyChannel(2);
    const ob = new Outbox({ sleep: async (ms) => void delays.push(ms), baseDelayMs: 10 });
    expect(await ob.send(ch, d('op'))).toMatchObject({ status: 'delivered', attempts: 3 });
    expect(delays).toEqual([10, 20]);
  });

  it('settles as rejected on a non-retryable error and unknown when retries run out', async () => {
    const ob = new Outbox({ sleep: noSleep, maxAttempts: 3 });
    const rej = new FlakyChannel(1, () => new DeliveryRejected('chat not found'));
    expect(await ob.send(rej, d('r'))).toMatchObject({ status: 'rejected', attempts: 1, error: 'chat not found' });
    const down = new FlakyChannel(99);
    expect(await ob.send(down, d('u'))).toMatchObject({ status: 'unknown', attempts: 3 });
    // An unknown outcome is never replayed.
    expect(await ob.send(down, d('u'))).toMatchObject({ status: 'unknown' });
    expect(down.calls).toBe(3);
  });

  it('checks Policy.outbound for sends that come from a turn', async () => {
    const ch = new FlakyChannel(0);
    const ob = new Outbox({ policy: defaultPolicy({ owners: [] }), sleep: noSleep });
    const from = { sessionKey: 's', turnId: 't', run: { harness: 'h', model: 'm', profile: 'p' }, inputs: [], replyRoute: route('mine') };
    expect(await ob.send(ch, { ...d('x'), from })).toMatchObject({ status: 'rejected' });
    expect(await ob.send(ch, { ...d('y'), route: route('mine'), from })).toMatchObject({ status: 'delivered' });
    expect(ch.calls).toBe(1);
  });
});
