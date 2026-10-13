import { afterEach, describe, expect, it } from 'vitest';
import { FakeChannel, defaultChannelCaps } from '@agents-io/testkit';
import { Compositor, Hub, MemorySessionLog, Outbox } from '../src/index.js';
import { until } from './helpers.js';

/*
 * `openDelayMs`: a turn's first message is held, so a quick reply arrives as one message
 * instead of a working card that turns into the answer.
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

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('compositor openDelayMs', () => {
  it('a turn that ends within the delay, before any answer text, gets one final message and no working card', async () => {
    const { channel, append } = rig(10_000);
    await settle();
    expect(channel.sent).toEqual([]);
    append({ t: 'item.started', item: { itemId: 'i1', type: 'command', title: 'Bash: ls', status: 'running' } });
    append({ t: 'turn.completed', turnId: 't1', status: 'completed' });
    await until(() => channel.sent.length === 1);
    await settle();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]!.msg.progress?.status).toBe('completed');
    expect(channel.sent[0]!.edits).toEqual([]);
  });

  it('tools alone do not open it; answer text does', async () => {
    const { channel, append } = rig(10_000);
    append({ t: 'item.started', item: { itemId: 'i1', type: 'command', title: 'Bash: ls', status: 'running' } });
    await settle();
    expect(channel.sent).toEqual([]);
    append({ t: 'text.delta', stream: 'answer', delta: 'Found' });
    await until(() => channel.sent.length === 1);
    expect(channel.sent[0]!.msg.progress?.status).toBe('running');
    append({ t: 'turn.completed', turnId: 't1', status: 'completed' });
    await until(() => !!channel.sent[0]!.finalized);
    expect(channel.sent).toHaveLength(1);
  });

  it('otherwise it opens when the delay runs out', async () => {
    const { channel } = rig(30);
    await until(() => channel.sent.length === 1);
    expect(channel.sent[0]!.msg.progress?.status).toBe('running');
  });
});

describe('delayed process preview', () => {
  it('waits past the deadline for actual answer text instead of sending an empty card', async () => {
    const hub = new Hub(new MemorySessionLog());
    const channel = new FakeChannel('fake', defaultChannelCaps);
    const c = new Compositor({
      hub, sessionKey: SESSION, adapter: channel, outbox: new Outbox({ hub, sleep: async () => {} }),
      previewDelayMs: 10, openDelayMs: 30, holdAnswerUntilOpen: true, requireAnswerToOpen: true,
    });
    c.start();
    cleanups.push(() => c.stop());
    const append = (body: Parameters<Hub['append']>[1]['body']) => hub.append(SESSION, { ts: Date.now(), ...ev, body });
    append({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: R });
    append({ t: 'item.started', item: { itemId: 'i1', type: 'command', title: 'Bash: ls', status: 'running' } });
    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(channel.sent).toHaveLength(0);
    append({ t: 'text.delta', stream: 'answer', delta: 'Found it.' });
    await until(() => channel.sent.length === 1);
    expect(channel.sent[0]!.msg.text).toContain('Found it.');
    expect(channel.sent[0]!.msg.actions).toBeUndefined();
  });

  it('holds answer text until the card deadline and previews process earlier', async () => {
    const hub = new Hub(new MemorySessionLog());
    const channel = new FakeChannel('fake', defaultChannelCaps);
    const previews: { final: boolean; steps: number }[] = [];
    channel.previewProgress = async (_route, progress, final) => { previews.push({ final, steps: progress.steps.length }); };
    const c = new Compositor({
      hub, sessionKey: SESSION, adapter: channel, outbox: new Outbox({ hub, sleep: async () => {} }),
      throttleMs: 1, previewDelayMs: 20, openDelayMs: 80, holdAnswerUntilOpen: true,
    });
    c.start();
    cleanups.push(() => c.stop());
    const append = (body: Parameters<Hub['append']>[1]['body']) => hub.append(SESSION, { ts: Date.now(), ...ev, body });
    append({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: R });
    append({ t: 'text.delta', stream: 'reasoning', delta: 'Checking', });
    append({ t: 'text.delta', stream: 'answer', delta: 'Partial answer' });
    await until(() => previews.length > 0);
    expect(channel.sent).toHaveLength(0);
    expect(previews[0]).toEqual({ final: false, steps: 1 });
    await until(() => channel.sent.length === 1);
    expect(channel.sent[0]!.msg.progress?.status).toBe('running');
    append({ t: 'turn.completed', turnId: 't1', status: 'completed' });
    await until(() => channel.sent[0]!.finalized === true);
  });

  it('settles an early preview and sends only the final message', async () => {
    const hub = new Hub(new MemorySessionLog());
    const channel = new FakeChannel('fake', defaultChannelCaps);
    const previews: boolean[] = [];
    channel.previewProgress = async (_route, _progress, final) => { previews.push(final); };
    const c = new Compositor({
      hub, sessionKey: SESSION, adapter: channel, outbox: new Outbox({ hub, sleep: async () => {} }),
      previewDelayMs: 10, openDelayMs: 100, holdAnswerUntilOpen: true,
    });
    c.start();
    cleanups.push(() => c.stop());
    const append = (body: Parameters<Hub['append']>[1]['body']) => hub.append(SESSION, { ts: Date.now(), ...ev, body });
    append({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: R });
    await until(() => previews.length === 1);
    append({ t: 'turn.completed', turnId: 't1', status: 'completed' });
    await until(() => channel.sent.length === 1);
    expect(previews).toEqual([false, true]);
    expect(channel.sent[0]!.msg.progress?.status).toBe('completed');
  });
});
