import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@agents-io/protocol';
import { FrameConn, type FrameTransport } from '../src/local-server.js';

describe('FrameConn after it ended', () => {
  it('a connection replaced by a takeover acts on no more frames, even if its transport still delivers them #HQ-6', async () => {
    const handled: string[] = [];
    const host = {
      hostFrames: {
        handle: async (_peer: unknown, f: { type: string }) => {
          handled.push(f.type);
          return { ok: true, value: {} };
        },
        gone: () => undefined,
      },
    };
    const written: Record<string, unknown>[] = [];
    const transport: FrameTransport = { write: (f) => (written.push(f), true), drained: async () => undefined, gone: false, end: () => undefined };
    const c = new FrameConn(transport, host as never, () => undefined);
    c.auth = { name: 'old', origin: () => ({}) as never };
    c.receive({ v: PROTOCOL_VERSION, type: 'bindings.get', id: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    expect(handled).toEqual(['bindings.get']);
    // end() (a takeover) drops it; a half-closed socket can still hand it frames.
    c.end('replaced by host new (takeover)');
    expect(c.auth).toBeUndefined();
    c.receive({ v: PROTOCOL_VERSION, type: 'bindings.get', id: 'b' });
    await new Promise((r) => setTimeout(r, 10));
    expect(handled).toEqual(['bindings.get']);
  });
});
