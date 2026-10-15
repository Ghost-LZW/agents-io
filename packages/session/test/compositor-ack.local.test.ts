import { afterEach, describe, expect, it } from 'vitest';
import type { AckState, InputRecord, ReplyRoute } from '@agents-io/protocol';
import { FakeChannel, FakeHarness, defaultChannelCaps } from '@agents-io/testkit';
import { Compositor, Hub, Ingress, Lane, MemorySessionLog, Outbox, defaultPolicy } from '../src/index.js';
import { RUN, until } from './helpers.js';

/*
 * Acknowledgements (`ack`): a mark on each inbound message while it is handled; taken away once a
 * reply came, `done` when the reply took long, `failed` when it did not complete.
 */

const SESSION = 'fake:default:c1';
const R = (msg: string): ReplyRoute => ({ channel: 'fake', account: 'default', conversationId: 'c1', replyToMessageId: msg });
const ev = { level: 'primary' as const, audience: 'status' as const, durability: 'durable' as const };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

class AckChannel extends FakeChannel {
  readonly marks: string[] = [];
  async acknowledge(_r: ReplyRoute, messageId: string, state: AckState) {
    this.marks.push(`${messageId}:${state}`);
  }
}

function rig(doneAfterMs = 60_000) {
  const hub = new Hub(new MemorySessionLog());
  const channel = new AckChannel('fake', defaultChannelCaps);
  const c = new Compositor({ hub, sessionKey: SESSION, adapter: channel, outbox: new Outbox({ hub, sleep: async () => {} }), throttleMs: 1, ack: { doneAfterMs } });
  c.start();
  cleanups.push(() => c.stop());
  let now = 1000;
  const append = (body: Parameters<Hub['append']>[1]['body'], extra: { turnId?: string; ts?: number } = {}) =>
    hub.append(SESSION, { ts: extra.ts ?? now, ...ev, ...(body.t === 'text.snapshot' ? { audience: 'answer' as const } : {}), ...extra, body });
  const admit = (inputId: string, msg: string, disposition: 'new_turn' | 'queued' | 'steer' = 'new_turn') => {
    const input: InputRecord = { inputId, origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: 'fake:default:c1' }, content: [{ type: 'text', text: 'hi' }], replyRoute: R(msg), channelContext: {} };
    append({ t: 'input.admitted', inputId, disposition, input });
  };
  return { channel, append, admit, at: (ms: number) => (now = ms) };
}

describe('compositor ack', () => {
  it('working while handled; gone once the turn replied', async () => {
    const w = rig();
    w.admit('i1', 'm1');
    w.append({ t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: R('m1') }, { turnId: 't1' });
    w.append({ t: 'text.snapshot', text: 'sure', final: true }, { turnId: 't1' });
    w.append({ t: 'turn.completed', turnId: 't1', status: 'completed' }, { turnId: 't1' });
    await until(() => w.channel.marks.length === 2);
    expect(w.channel.marks).toEqual(['m1:working', 'm1:none']);
  });

  it('a long task, or a message with no reply of its own, ends done', async () => {
    const w = rig(60_000);
    w.admit('i1', 'm1');
    w.append({ t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: R('m1') }, { turnId: 't1' });
    w.admit('i2', 'm2', 'steer');
    w.append({ t: 'input.consumed', inputIds: ['i2'], turnId: 't1' }, { turnId: 't1' });
    w.append({ t: 'text.snapshot', text: 'done with both', final: true }, { turnId: 't1' });
    w.at(1000 + 90_000);
    w.append({ t: 'turn.completed', turnId: 't1', status: 'completed' }, { turnId: 't1' });
    await until(() => w.channel.marks.length === 4);
    expect(w.channel.marks.slice(2).sort()).toEqual(['m1:done', 'm2:done']);
  });

  it('a steer ends DONE even when the turn replies quickly on the same route', async () => {
    const w = rig();
    w.admit('i1', 'm1');
    w.append({ t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: R('m1') }, { turnId: 't1' });
    w.admit('i2', 'm2', 'steer');
    w.append({ t: 'input.consumed', inputIds: ['i2'], turnId: 't1' }, { turnId: 't1' });
    w.append({ t: 'text.snapshot', text: 'done with both', final: true }, { turnId: 't1' });
    w.append({ t: 'turn.completed', turnId: 't1', status: 'completed' }, { turnId: 't1' });
    await until(() => w.channel.marks.length === 4);
    expect(w.channel.marks).toEqual(['m1:working', 'm2:working', 'm1:none', 'm2:done']);
  });

  it('failed when the turn does not complete or the message is rejected', async () => {
    const w = rig();
    w.admit('i1', 'm1');
    w.append({ t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: R('m1') }, { turnId: 't1' });
    w.append({ t: 'turn.completed', turnId: 't1', status: 'failed' }, { turnId: 't1' });
    w.admit('i2', 'm2', 'queued');
    w.append({ t: 'input.rejected', inputIds: ['i2'], reason: 'lane_closed: stopping' });
    await until(() => w.channel.marks.length === 4);
    expect(w.channel.marks).toEqual(['m1:working', 'm1:failed', 'm2:working', 'm2:failed']);
  });

  it('observe-only messages and inputs without a source message get no mark', async () => {
    const w = rig();
    w.admit('i1', 'm1', 'new_turn');
    const input: InputRecord = { inputId: 'i2', origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: 'x' }, content: [], replyRoute: R('m2'), channelContext: {} };
    w.append({ t: 'input.admitted', inputId: 'i2', disposition: 'observe_only', input });
    w.append({ t: 'input.admitted', inputId: 'i3', disposition: 'new_turn', input: { ...input, inputId: 'i3', replyRoute: { channel: 'fake', account: 'default', conversationId: 'c1' } } });
    await until(() => w.channel.marks.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.channel.marks).toEqual(['m1:working']);
  });
});

describe('compositor ack through ingress and a lane', () => {
  it('a channel message gets working, then nothing once replied (the lane carries the input on input.admitted)', async () => {
    const hub = new Hub(new MemorySessionLog());
    const policy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
    const lanes = new Map<string, Lane>();
    const harness = new FakeHarness();
    const ingress = new Ingress({
      policy,
      lanes: (key) => {
        let l = lanes.get(key);
        if (!l) lanes.set(key, (l = new Lane({ sessionKey: key, harness, hub, policy })));
        return l;
      },
    });
    const channel = new AckChannel('fake', defaultChannelCaps);
    const c = new Compositor({ hub, sessionKey: SESSION, adapter: channel, outbox: new Outbox({ hub, sleep: async () => {} }), throttleMs: 1, ack: { doneAfterMs: 60_000 } });
    c.start();
    const ac = new AbortController();
    void channel.start({ account: 'default', config: {}, signal: ac.signal, emit: ingress.emitter(), log: () => {} });
    cleanups.push(async () => {
      ac.abort();
      await c.stop();
      for (const l of lanes.values()) await l.close();
    });
    await channel.inject({ id: 'm1', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi', replyRoute: R('m1') });
    await until(() => channel.marks.length === 2);
    expect(channel.marks).toEqual(['m1:working', 'm1:none']);
  });
});
