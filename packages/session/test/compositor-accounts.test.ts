import { afterEach, describe, expect, it } from 'vitest';
import { FakeChannel, defaultChannelCaps } from '@agents-io/testkit';
import { Compositor, Hub, MemorySessionLog, Outbox } from '../src/index.js';
import { bodies, until } from './helpers.js';

/*
 * Several accounts of one channel id (two Lark bots, decision 8): each account's
 * compositor renders only routes of its account, for new turns and for a turn an
 * earlier process left open (restore).
 */

const SESSION = 'lark-bot:b:c1';
const R = { channel: 'lark-bot', account: 'b', conversationId: 'c1' };
const ev = { level: 'primary' as const, audience: 'status' as const, durability: 'durable' as const, turnId: 't1' };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function rig(log: MemorySessionLog, chans: Record<string, FakeChannel>, account: (name: string) => string | undefined = (n) => n) {
  const hub = new Hub(log);
  const outbox = new Outbox({ hub, sleep: async () => {} });
  const comps = Object.entries(chans).map(([name, adapter]) => {
    const acc = account(name);
    const c = new Compositor({ hub, sessionKey: SESSION, adapter, outbox, throttleMs: 1, ...(acc !== undefined ? { account: acc } : {}) });
    c.start();
    cleanups.push(() => c.stop());
    return c;
  });
  const append = (body: Parameters<Hub['append']>[1]['body']) => hub.append(SESSION, { ts: Date.now(), ...ev, body });
  return { hub, comps, append };
}

describe('compositor accounts', () => {
  it('a route of account b is rendered by b only', async () => {
    const a = new FakeChannel('lark-bot', defaultChannelCaps);
    const b = new FakeChannel('lark-bot', defaultChannelCaps);
    const w = rig(new MemorySessionLog(), { a, b });
    w.append({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: R });
    w.append({ t: 'turn.completed', turnId: 't1', status: 'completed' });
    await until(() => !!b.sent[0]?.finalized);
    expect(a.sent).toEqual([]);
    expect(b.sent).toHaveLength(1);
  });

  it('without account every compositor of the channel id claims the route (unchanged behaviour)', async () => {
    const a = new FakeChannel('lark-bot', defaultChannelCaps);
    const w = rig(new MemorySessionLog(), { a }, () => undefined);
    w.append({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: R });
    await until(() => a.sent.length === 1);
  });

  it('restore: only the route\'s account picks up the open turn and finalizes its card', async () => {
    const log = new MemorySessionLog();
    const b = new FakeChannel('lark-bot', defaultChannelCaps);
    const first = rig(log, { b });
    first.append({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: R });
    await until(() => bodies(log.read(SESSION, 0), 'render.anchor').length === 1);
    for (const c of first.comps) await c.stop(); // the process goes away mid-turn

    const a = new FakeChannel('lark-bot', defaultChannelCaps);
    const touched: string[] = [];
    a.edit = async () => void touched.push('edit');
    a.finalize = async () => void touched.push('finalize');
    const second = rig(log, { a, b });
    second.append({ t: 'turn.completed', turnId: 't1', status: 'ambiguous', error: { code: 'host_restarted', retryable: false } });
    await until(() => !!b.sent[0]?.finalized);
    expect(b.sent).toHaveLength(1);
    expect(a.sent).toEqual([]);
    expect(touched).toEqual([]);
  });
});
