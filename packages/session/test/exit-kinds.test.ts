import { afterEach, describe, expect, it } from 'vitest';
import { FakeChannel, defaultChannelCaps } from '@agents-io/testkit';
import { Compositor, Hub, MemorySessionLog, Outbox, type Delivery } from '../src/index.js';
import { bodies, until } from './helpers.js';

/*
 * U20 (docs/HOSTS.md §4.1a): a topic title where an outbound.scoped host checks is asked of it first
 * (`kind: title`) and settles with its kind; held, the card keeps its old title.
 */

const SESSION = 'fake:default:g1';
const G1 = { channel: 'fake', account: 'default', conversationId: 'g1' };
const ev = { level: 'primary' as const, audience: 'status' as const, durability: 'durable' as const, turnId: 't1' };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function rig(verdict: 'allow' | 'hold') {
  const hub = new Hub(new MemorySessionLog());
  const asked: Delivery[] = [];
  const outbox = new Outbox({
    hub,
    sleep: async () => {},
    detailed: () => true,
    exit: (d) => (d.kind === 'title' ? (asked.push(d), Promise.resolve({ verdict, ...(verdict === 'hold' ? { reason: 'not this title' } : {}) })) : undefined),
  });
  const chat = new FakeChannel('fake', defaultChannelCaps);
  let title = 'Old title';
  const c = new Compositor({ hub, sessionKey: SESSION, adapter: chat, outbox, throttleMs: 1, tier: 'card', title: () => title, inScope: () => true });
  c.start();
  cleanups.push(() => c.stop());
  const append = (body: Parameters<Hub['append']>[1]['body'], audience: 'status' | 'answer' = 'status') => hub.append(SESSION, { ts: Date.now(), ...ev, audience, body });
  return { hub, chat, c, asked, append, setTitle: (t: string) => (title = t) };
}

describe('U20: the topic title', () => {
  for (const verdict of ['allow', 'hold'] as const) {
    it(`a title where the scoped host checks is asked first (kind title) and settles with its kind: ${verdict} #DL-7 #DL-1`, async () => {
      const w = rig(verdict);
      // Started before the route came into scope: not checked, rendered as a card.
      w.append({ t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: G1, checked: false });
      w.append({ t: 'text.snapshot', text: 'done', final: true }, 'answer');
      w.append({ t: 'turn.completed', turnId: 't1', status: 'completed' });
      await until(() => w.chat.sent.length === 1 && bodies(w.hub.log.read(SESSION, 0), 'delivery.settled').length >= 1);
      const before = w.chat.sent[0]!.edits.length;
      w.setTitle('Secret new title');
      await w.c.refreshLatestTitle();
      expect(w.asked).toHaveLength(1);
      expect(w.asked[0]).toMatchObject({ kind: 'title', turnId: 't1', route: G1 });
      expect(JSON.stringify(w.asked[0]!.content)).toContain('Secret new title');
      const settled = bodies(w.hub.log.read(SESSION, 0), 'delivery.settled').find((b) => (b as { kind?: string }).kind === 'title');
      expect(settled).toMatchObject({ kind: 'title', turnId: 't1', result: verdict === 'allow' ? 'delivered' : 'held' });
      expect(w.chat.sent[0]!.edits.length - before).toBe(verdict === 'allow' ? 1 : 0);
    });
  }

  it('a rejection notice settles with kind notice, never asked of the exit check #DL-7 #DL-1', async () => {
    const w = rig('hold');
    w.hub.append(SESSION, { ts: Date.now(), level: 'detail', audience: 'status', durability: 'durable', body: { t: 'input.rejected', inputIds: ['i9'], reason: 'lane_closed', replyRoute: G1 } });
    const notice = () => bodies(w.hub.log.read(SESSION, 0), 'delivery.settled').find((b) => (b as { kind?: string }).kind === 'notice');
    await until(() => !!notice());
    expect(notice()).toMatchObject({ result: 'delivered', route: G1 });
    expect(w.asked).toHaveLength(0);
  });
});
