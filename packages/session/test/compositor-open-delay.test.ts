import { afterEach, describe, expect, it } from 'vitest';
import { FakeChannel, defaultChannelCaps } from '@agents-io/testkit';
import { Compositor, Hub, MemorySessionLog, Outbox } from '../src/index.js';
import { until } from './helpers.js';

/*
 * `openDelayMs` holds a turn's first message, but never an approval (RQ-5); the rest of its
 * behaviour is in compositor-open-delay.local.test.ts.
 */

const SESSION = 'fake:default:c1';
const R = { channel: 'fake', account: 'default', conversationId: 'c1' };
const ev = { level: 'primary' as const, audience: 'answer' as const, durability: 'durable' as const, turnId: 't1' };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function rig(openDelayMs: number) {
  const hub = new Hub(new MemorySessionLog());
  const channel = new FakeChannel('fake', defaultChannelCaps);
  const c = new Compositor({ hub, sessionKey: SESSION, adapter: channel, outbox: new Outbox({ hub, sleep: async () => {} }), throttleMs: 1, openDelayMs });
  c.start();
  cleanups.push(() => c.stop());
  const append = (body: Parameters<Hub['append']>[1]['body']) => hub.append(SESSION, { ts: Date.now(), ...ev, body });
  append({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: R });
  return { channel, append, c };
}


describe('compositor openDelayMs', () => {
  it('a request someone must answer opens it at once #RQ-5', async () => {
    const { channel, append } = rig(10_000);
    append({
      t: 'request.opened',
      requestId: 'r1',
      kind: 'tool_approval',
      title: 'git push',
      risk: {},
      allowedDecisions: ['allow_once', 'deny'],
      allowAlways: false,
      defaultDeny: true,
      resolver: { kind: 'human', principals: [], routes: [] },
    });
    await until(() => channel.sent.length === 1);
    expect(channel.sent[0]!.msg.actions?.length).toBeGreaterThan(0);
  });
});
