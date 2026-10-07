import { describe, expect, it } from 'vitest';
import { assertConformingStream, checkEventStream, FakeChannel, FakeHarness, loadEnvFile, parseEnv, runChannelConformance, runHarnessEnvConformance } from '../src/index.js';
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

  it('accepts turn.adopted for the open turn (a log spanning a host restart), not for another one', () => {
    const base = { ts: 1, level: 'primary', audience: 'status', durability: 'durable' } as const;
    const started = { ...base, turnId: 't1', body: { t: 'turn.started', turnId: 't1', inputIds: ['a'], replyRoute: null } };
    const adopted = (turnId: string) => ({ ...base, turnId, body: { t: 'turn.adopted', turnId, inputIds: ['a'] } });
    const done = { ...base, turnId: 't1', body: { t: 'turn.completed', turnId: 't1', status: 'completed' } };
    expect(checkEventStream([started, adopted('t1'), done])).toEqual([]);
    expect(checkEventStream([adopted('t1'), done])).toEqual([]);
    expect(checkEventStream([started, adopted('t2')]).map((v) => v.rule)).toContain('turn.overlap');
  });
});

describe('parseEnv', () => {
  it('parses .env.live style files', () => {
    expect(
      parseEnv('# c\n\nexport A=1\nB = "two words"\nC=\'x#y\'\nD=val # note\nnot a line\nE=a=b'),
    ).toEqual({ A: '1', B: 'two words', C: 'x#y', D: 'val', E: 'a=b' });
  });

  it('loadEnvFile returns {} for a missing file', () => {
    expect(loadEnvFile('/nonexistent/agents-io/.env.live')).toEqual({});
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

describe('runHarnessEnvConformance', () => {
  const adapterOf = (leakToArgv: boolean) => {
    let spawn = { env: {} as Record<string, string | undefined>, argv: [] as string[] };
    const adapter = {
      id: 'leaky',
      probe: async () => ({ version: '0', caps: {} as never }),
      open: async (args: { env?: Record<string, string> }) => {
        spawn = { env: { ...args.env }, argv: leakToArgv ? Object.values(args.env ?? {}) : [] };
        return { events: (async function* () {})(), close: async () => {} } as never;
      },
    };
    return { adapter, lastSpawn: () => spawn };
  };
  const open = { sessionKey: 's', generation: 1, cwd: '/tmp', run: { harness: 'x', model: 'm', profile: 'p' } };

  it('passes an adapter that keeps env to the child environment', async () => {
    const { adapter, lastSpawn } = adapterOf(false);
    const r = await runHarnessEnvConformance({ adapter, open, lastSpawn });
    expect(r.failed).toEqual([]);
  });

  it('fails an adapter that puts the value on argv', async () => {
    const { adapter, lastSpawn } = adapterOf(true);
    const r = await runHarnessEnvConformance({ adapter, open, lastSpawn });
    expect(r.failed.map((f) => f.check)).toEqual(['env.not_in_argv']);
  });
});
