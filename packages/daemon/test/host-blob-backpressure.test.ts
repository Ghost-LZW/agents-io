import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@agents-io/protocol';
import { FrameConn, HostService, type FrameTransport, type HostServiceDeps } from '@agents-io/kernel';

/** A transport whose peer may stop reading: `write` then reports the buffer full until `drain()`. */
function transport() {
  const written: Record<string, unknown>[] = [];
  let congested = false;
  let waiters: (() => void)[] = [];
  const t: FrameTransport = {
    write: (f) => {
      written.push(f);
      return !congested;
    },
    drained: () => (congested ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
    gone: false,
    end: () => undefined,
  };
  return {
    t,
    written,
    stall: () => void (congested = true),
    drain: () => {
      congested = false;
      for (const w of waiters.splice(0)) w();
      waiters = [];
    },
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('blob.get over a connection whose peer is slow', () => {
  it('blob.get answers leave one at a time per connection: while the transport is congested the next range is not read, and it is once the transport drained #PR-2 #PB-6', async () => {
    const reads: string[] = [];
    const deps = {
      token: 'host-token',
      runs: { peerGone: () => undefined },
      router: { setHostConnected: () => undefined },
      log: () => undefined,
      blobs: {
        stat: async () => ({ ok: true as const, value: null }),
        get: async (f: { ref: string; offset?: number }) => {
          reads.push(`${f.ref}@${f.offset ?? 0}`);
          return { ok: true as const, value: { base64: 'AAAA', size: 9, offset: f.offset ?? 0 } };
        },
        put: async () => ({ ok: true as const, value: { ref: 'x', size: 0 } }),
      },
    } as unknown as HostServiceDeps;
    const service = new HostService(deps);
    const conn = (tr: ReturnType<typeof transport>) => {
      const c = new FrameConn(tr.t, { hostFrames: service } as never, () => undefined);
      c.auth = { name: 'reader', origin: () => ({}) as never };
      return c;
    };
    const [slow, other] = [transport(), transport()];
    const [c, d] = [conn(slow), conn(other)];
    const ask = (to: FrameConn, id: string, ref: string, offset: number) => to.receive({ v: PROTOCOL_VERSION, type: 'blob.get', id, ref, offset, length: 3 });

    // The peer stops reading, then asks for three ranges without waiting for any answer.
    slow.stall();
    ask(c, 'a', 'r1', 0);
    ask(c, 'b', 'r1', 3);
    ask(c, 'c', 'r1', 6);
    await tick();
    // One range was read and its answer handed to the transport; the others were not read at all.
    expect(reads).toEqual(['r1@0']);
    expect(slow.written.map((f) => f.id)).toEqual(['a']);
    // Another connection is not held up by it, and a request that is not blob.get on the slow one is not either.
    ask(d, 'x', 'r2', 0);
    ask(d, 'y', 'r2', 3);
    c.receive({ v: PROTOCOL_VERSION, type: 'blob.stat', id: 's', ref: 'r1' });
    await tick();
    expect(reads).toEqual(['r1@0', 'r2@0', 'r2@3']);
    expect(other.written.map((f) => f.id)).toEqual(['x', 'y']);
    expect(slow.written.map((f) => f.id)).toEqual(['a', 's']);

    // The transport drained: the rest follow, in the order asked.
    slow.drain();
    await tick();
    expect(reads).toEqual(['r1@0', 'r2@0', 'r2@3', 'r1@3', 'r1@6']);
    expect(slow.written.map((f) => [f.id, (f.value as { offset?: number } | null)?.offset])).toEqual([['a', 0], ['s', undefined], ['b', 3], ['c', 6]]);

    // A connection that went away with ranges queued reads nothing more.
    slow.stall();
    ask(c, 'e', 'r1', 0);
    ask(c, 'f', 'r1', 3);
    await tick();
    expect(reads.filter((r) => r.startsWith('r1')).length).toBe(4);
    c.drop();
    slow.drain();
    await tick();
    expect(reads.filter((r) => r.startsWith('r1')).length).toBe(4);
  });
});
