import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEnvelope } from '@agents-io/testkit';
import type { InboundItem } from '@agents-io/protocol';
import { HostQueue, channelRefOf } from '../src/index.js';
import { until } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let n = 0;
function item(id = `m${++n}`): Omit<InboundItem, 'cursor'> {
  const env = fakeEnvelope({ id, text: `text ${id}`, raw: { big: 'payload' } });
  return {
    channelRef: channelRefOf(env),
    bindingId: 'to-host',
    input: { inputId: `in_${id}`, origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' }, content: env.content, replyRoute: env.replyRoute, channelContext: {} },
    envelope: env,
    receivedAt: 1,
  };
}

describe('HostQueue', () => {
  it('appends idempotently on the channel reference: a redelivery returns the first cursor', async () => {
    const q = new HostQueue();
    const a = item('same');
    expect(q.append(a)).toEqual({ cursor: 1, duplicate: false });
    expect(q.append(item('other'))).toEqual({ cursor: 2, duplicate: false });
    expect(q.append({ ...a, bindingId: 'again' })).toEqual({ cursor: 1, duplicate: true });
    const items = await q.read('xwo');
    expect(items.map((i) => [i.cursor, i.channelRef])).toEqual([
      [1, 'channel:fake/same'],
      [2, 'channel:fake/other'],
    ]);
    // The envelope is stored without `raw`.
    expect('raw' in items[0]!.envelope).toBe(false);
    q.close();
  });

  it('keeps one cursor per consumer; ack only moves forward; read after an explicit cursor', async () => {
    const q = new HostQueue();
    for (let i = 0; i < 4; i++) q.append(item());
    expect((await q.read('a', { limit: 2 })).map((i) => i.cursor)).toEqual([1, 2]);
    expect(q.ack('a', 2)).toBe(2);
    expect((await q.read('a')).map((i) => i.cursor)).toEqual([3, 4]);
    expect(q.ack('a', 1)).toBe(2); // never back
    expect((await q.read('b')).map((i) => i.cursor)).toEqual([1, 2, 3, 4]); // another consumer, its own cursor
    expect((await q.read('a', { after: 3 })).map((i) => i.cursor)).toEqual([4]);
    expect(q.ack('a', 99)).toBe(4); // clipped to the head
    q.close();
  });

  it('long-polls: read waits for the next append, or returns empty after waitMs', async () => {
    const q = new HostQueue();
    const t0 = Date.now();
    expect(await q.read('a', { waitMs: 40 })).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    const pending = q.read('a', { waitMs: 5000 });
    setTimeout(() => q.append(item('late')), 20);
    const got = await pending;
    expect(got.map((i) => i.channelRef)).toEqual(['channel:fake/late']);
    q.close();
  });

  it('push: delivers in order and acks what the consumer accepts; retries a refusal', async () => {
    const q = new HostQueue();
    q.append(item('p1'));
    const got: string[] = [];
    let refuseOnce = true;
    const sub = q.subscribe(
      'xwo',
      async (i) => {
        got.push(i.channelRef);
        if (i.channelRef.endsWith('p2') && refuseOnce) {
          refuseOnce = false;
          return false;
        }
        return true;
      },
      { retryMs: 10 },
    );
    q.append(item('p2'));
    q.append(item('p3'));
    await until(() => q.cursor('xwo') === 3);
    expect(got).toEqual(['channel:fake/p1', 'channel:fake/p2', 'channel:fake/p2', 'channel:fake/p3']);
    sub.close();
    await sub.done;
    q.close();
  });

  it('push: unacked items are redelivered after a reconnect (at least once), also across a restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aio-hq-')), 'q.sqlite');
    dirs.push(join(path, '..'));
    const one = new HostQueue({ path });
    one.append(item('r1'));
    one.append(item('r2'));
    // The first connection takes r1, then hangs on r2 and drops.
    let release!: () => void;
    const first: string[] = [];
    const s1 = one.subscribe('xwo', async (i) => {
      first.push(i.channelRef);
      if (i.channelRef.endsWith('r2')) await new Promise<void>((r) => (release = r));
      return i.channelRef.endsWith('r1');
    });
    await until(() => first.length === 2);
    s1.close();
    release();
    await s1.done;
    expect(one.cursor('xwo')).toBe(1);
    // Reconnect in the same process: r2 again.
    const again: string[] = [];
    const s2 = one.subscribe('xwo', (i) => void again.push(i.channelRef));
    await until(() => again.length === 1);
    s2.close();
    await s2.done;
    expect(again).toEqual(['channel:fake/r2']);
    one.append(item('r3'));
    one.close();
    // A restart: the cursor (2) and r3 are on disk.
    const two = new HostQueue({ path });
    const after: string[] = [];
    const s3 = two.subscribe('xwo', (i) => void after.push(i.channelRef));
    await until(() => after.length === 1);
    expect(after).toEqual(['channel:fake/r3']);
    // Still idempotent after the restart.
    expect(two.append(item('r1')).duplicate).toBe(true);
    s3.close();
    await s3.done;
    two.close();
  });

  it('a new subscription for the same consumer replaces the old one', async () => {
    const q = new HostQueue();
    const a = q.subscribe('xwo', () => new Promise(() => {}));
    const b = q.subscribe('xwo', () => true);
    await a.done; // closed by the replacement
    q.append(item());
    await until(() => q.cursor('xwo') === 1);
    b.close();
    await b.done;
    q.close();
  });

  it('retention: deletes only what every known consumer acked, after retainAckedMs', async () => {
    let now = 1_000;
    const q = new HostQueue({ now: () => now, retainAckedMs: 100 });
    for (let i = 0; i < 3; i++) q.append(item(`k${i}`));
    q.cursor('a');
    q.cursor('b');
    q.ack('a', 3);
    now += 1_000;
    expect(q.prune()).toBe(0); // b has acked nothing
    q.ack('b', 2);
    expect((await q.read('c', { after: 0 })).map((i) => i.cursor)).toEqual([3]); // 1 and 2 pruned by b's ack
    // An acked, deleted message is still a duplicate (refs outlive items).
    expect(q.append(item('k0'))).toEqual({ cursor: 1, duplicate: true });
    q.forget('c');
    expect(q.consumers().map((c) => c.name)).toEqual(['a', 'b']);
    q.close();
  });
});
