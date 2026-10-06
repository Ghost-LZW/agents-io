import { describe, expect, it } from 'vitest';
import { assertConformingStream, checkEventStream, FakeChannel, FakeHarness, runChannelConformance } from '../src/index.js';
import type { HarnessEvent, InputRecord } from '@agents-io/protocol';

const input = (id: string, text: string): InputRecord => ({
  inputId: id,
  origin: { kind: 'human', principal: { id: 'owner', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:a:c1', adapter: 'fake' },
  content: [{ type: 'text', text }],
  replyRoute: null,
  channelContext: {},
});

async function collect(it: AsyncIterable<HarnessEvent>, until: (e: HarnessEvent) => boolean) {
  const out: HarnessEvent[] = [];
  for await (const e of it) {
    out.push(e);
    if (until(e)) break;
  }
  return out;
}

describe('FakeHarness', () => {
  it('produces a conforming stream', async () => {
    const h = new FakeHarness();
    const s = await h.open({ sessionKey: 's', generation: 1, cwd: '.', run: { harness: 'fake', model: 'm', profile: 'bypass' } });
    await s.startTurn('t1', [input('i1', 'hi')]);
    const evs = await collect(s.events, (e) => e.body.t === 'turn.completed');
    assertConformingStream(evs, { turnInputs: { t1: ['i1'] } });
    expect(evs.find((e) => e.body.t === 'text.snapshot')).toBeTruthy();
  });

  it('interrupt ends the turn as interrupted', async () => {
    const h = new FakeHarness(async (t) => {
      t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'rm', risk: { writes: true }, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
      await t.waitDecision('r1');
    });
    const s = await h.open({ sessionKey: 's', generation: 1, cwd: '.', run: { harness: 'fake', model: 'm', profile: 'bypass' } });
    await s.startTurn('t1', [input('i1', 'go')]);
    setTimeout(() => void s.interrupt('t1'), 10);
    const evs = await collect(s.events, (e) => e.body.t === 'turn.completed');
    expect(evs.at(-1)?.body).toMatchObject({ status: 'interrupted' });
    expect(checkEventStream(evs)).toEqual([]);
  });
});

describe('checkEventStream', () => {
  it('flags overlap, unknown inputs and unfinished items', () => {
    const base = { ts: 1, level: 'primary', audience: 'status', durability: 'durable' } as const;
    const run = { harness: 'x', model: 'm', profile: 'p' };
    const evs = [
      { ...base, turnId: 't1', body: { t: 'turn.started', turnId: 't1', inputIds: ['a'], replyRoute: null, run } },
      { ...base, turnId: 't1', body: { t: 'item.started', item: { itemId: 'x', type: 'command', title: 'ls', status: 'running' } } },
      { ...base, turnId: 't2', body: { t: 'turn.started', turnId: 't2', inputIds: [], replyRoute: null, run } },
      { ...base, turnId: 't1', body: { t: 'input.consumed', inputIds: ['zzz'], turnId: 't1' } },
      { ...base, turnId: 't1', body: { t: 'turn.completed', turnId: 't1', status: 'completed' } },
    ];
    const rules = checkEventStream(evs, { turnInputs: { t1: ['a'] } }).map((v) => v.rule);
    expect(rules).toEqual(expect.arrayContaining(['turn.overlap', 'input.consumed', 'item.complete', 'turn.complete']));
  });
});

describe('channel conformance', () => {
  it('FakeChannel passes', async () => {
    const ch = new FakeChannel();
    const report = await runChannelConformance({
      adapter: ch,
      account: 'a',
      route: { channel: 'fake', account: 'a', conversationId: 'c1' },
      triggerInbound: async () => {
        await new Promise((r) => setTimeout(r, 5));
        await ch.inject({ text: 'hi', account: 'a' });
      },
      platformMessages: async () => ch.sent.map((s) => s.providerMessageId),
    });
    expect(report.failed).toEqual([]);
  });
});
