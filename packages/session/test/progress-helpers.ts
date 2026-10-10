import { FakeChannel, FakeHarness, defaultChannelCaps, type FakeTurnScript } from '@agents-io/testkit';
import type { Body, HarnessEvent, RenderedMessage, SessionEvent } from '@agents-io/protocol';
import { Compositor, Hub, Ingress, Lane, MemorySessionLog, Outbox, defaultPolicy } from '../src/index.js';
import { RUN } from './helpers.js';

let seq = 0;
/** A durable session event of turn t1, as the compositor folds it. */
export function ev(body: Body, extra: Partial<HarnessEvent> = {}): SessionEvent {
  return {
    v: 1,
    sessionKey: 's',
    seq: ++seq,
    harness: 'fake',
    generation: 1,
    visibility: 'participants',
    ts: 1000 + seq,
    turnId: 't1',
    level: 'primary',
    audience: 'status',
    durability: 'durable',
    ...extra,
    body,
  } as SessionEvent;
}

export const tool = (itemId: string, title: string, status: 'running' | 'completed' | 'failed' = 'running', more: object = {}) => ({
  itemId,
  type: 'command' as const,
  title,
  status,
  ...more,
});

export const SESSION = 'fake:default:c1';
export const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

/** Ingress → lane → compositor → FakeChannel for one session; register the returned cleanup in afterEach. */
export function world(script: FakeTurnScript, cleanups: (() => Promise<void> | void)[], interruptButton = false) {
  const hub = new Hub(new MemorySessionLog());
  const policy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
  const lanes = new Map<string, Lane>();
  const harness = new FakeHarness(script);
  const ingress = new Ingress({
    policy,
    lanes: (sessionKey) => {
      let l = lanes.get(sessionKey);
      if (!l) lanes.set(sessionKey, (l = new Lane({ sessionKey, harness, hub, policy })));
      return l;
    },
  });
  const channel = new FakeChannel('fake', defaultChannelCaps);
  const outbox = new Outbox({ hub, sleep: async () => {} });
  const compositor = new Compositor({ hub, sessionKey: SESSION, adapter: channel, outbox, throttleMs: 5, interruptButton });
  compositor.start();
  const ac = new AbortController();
  void channel.start({ account: 'default', config: {}, signal: ac.signal, emit: ingress.emitter(), log: () => {} });
  cleanups.push(async () => {
    ac.abort();
    await compositor.stop();
    for (const l of lanes.values()) await l.close();
  });
  return { hub, channel, ingress, events: () => hub.log.read(SESSION, 0) };
}

export const last = (rec: { msg: RenderedMessage; edits: RenderedMessage[] }) => rec.edits.at(-1) ?? rec.msg;
