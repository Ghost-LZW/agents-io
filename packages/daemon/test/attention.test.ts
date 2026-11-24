import { describe, expect, it } from 'vitest';
import { HostEventFrame, SessionInfo, errors, type AttentionChanged } from '@agents-io/protocol';
import type { FakeTurnScript } from '@agents-io/testkit';
import { FEATURES } from '@agents-io/kernel';
import { cli } from './cli-helpers.js';
import { daemon, until } from './helpers.js';

/*
 * The attention projection (core-slimming G7, INVARIANTS LN-11) in the daemon: on `SessionInfo`
 * (the `sessions` answer, `aio sessions`), and as `attention.changed` frames to a host that asks.
 */

const human = { kind: 'human' as const, principals: ['me'], routes: [] };
const asks: FakeTurnScript = async (t) => {
  t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'Bash: rm -rf build', risk: { writes: true }, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
  const d = await t.waitDecision('r1');
  t.emit({ t: 'text.snapshot', text: `got ${d.kind}`, final: true }, { audience: 'answer' });
};

describe('attention in the daemon', () => {
  it('sessions and aio sessions show what is pending; a host asking optIn attention is granted it and told each change once, in seq order, in frames valid as HostEventFrame; a connection that is not the host is granted nothing and told nothing #LN-11 #PR-1', async () => {
    const w = await daemon({ script: asks, policy: { resolve: async () => human } });
    expect(FEATURES).toContain('attention');
    const h = await w.client();
    const hello = await h.hello({ token: w.gw.token, name: 'lb', callouts: ['route'], optIn: ['attention'] });
    expect(hello).toMatchObject({ host: true, optIn: ['attention'] });
    expect(hello.features).toContain('attention');
    const frames: AttentionChanged[] = [];
    h.onAttentionChanged((f) => frames.push(f));
    const probe = await w.client();
    expect(await probe.hello({ token: w.gw.token, name: 'probe', optIn: ['attention'] })).toMatchObject({ host: false, optIn: [] });
    const heardByProbe: AttentionChanged[] = [];
    probe.onAttentionChanged((f) => heardByProbe.push(f));

    const c = await w.client();
    await c.input('s', 'go');
    await until(() => frames.some((f) => f.attention.state === 'needs_you'));
    const info = (await c.sessions()).find((s) => s.sessionKey === 's')!;
    expect(errors(SessionInfo, info)).toEqual([]);
    expect(info.attention).toMatchObject({ state: 'needs_you', reasons: [{ kind: 'request', requestId: 'r1', requestKind: 'tool_approval', title: 'Bash: rm -rf build' }], turnId: info.turnId });
    const line = (await cli(['sessions', '--socket', w.config.socketPath])).out.split('\n').find((l) => l.startsWith('s\t'))!;
    expect(line.split('\t').at(-1)).toBe('attention needs_you (request r1)');

    await c.command({ type: 'resolve', sessionKey: 's', requestId: 'r1', decision: { kind: 'allow_once' } });
    await until(() => frames.at(-1)?.attention.state === 'idle');
    // Admitted (waiting), started, asked, answered, done: one frame each, never one twice.
    expect(frames.map((f) => f.attention.state)).toEqual(['working', 'working', 'needs_you', 'working', 'idle']);
    for (const f of frames) expect(errors(HostEventFrame, f)).toEqual([]);
    expect(frames.every((f) => f.sessionKey === 's')).toBe(true);
    const seqs = frames.map((f) => f.attention.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    // Each is the log's value at its seq, and the last one is what sessions lists now.
    expect(frames.at(-1)!.attention).toStrictEqual(w.gw.sessions().find((s) => s.sessionKey === 's')!.attention);
    expect((await cli(['sessions', '--socket', w.config.socketPath])).out).toMatch(/^s\t.*\tattention idle$/m);
    expect(heardByProbe).toEqual([]);
  });

  it('a host whose hello does not ask for it gets no attention frames; the value is in sessions all the same #LN-11', async () => {
    const w = await daemon({ script: asks, policy: { resolve: async () => human } });
    const h = await w.client();
    expect(await h.hello({ token: w.gw.token, name: 'lb', callouts: ['route'] })).not.toHaveProperty('optIn');
    const heard: unknown[] = [];
    h.onAttentionChanged((f) => heard.push(f));
    const c = await w.client();
    await c.input('s', 'go');
    await until(() => w.gw.sessions().find((s) => s.sessionKey === 's')?.attention?.state === 'needs_you');
    await c.command({ type: 'resolve', sessionKey: 's', requestId: 'r1', decision: { kind: 'deny' } });
    await until(() => w.gw.sessions().find((s) => s.sessionKey === 's')?.attention?.state === 'idle');
    // A frame round trip after the last change: anything sent before it has arrived.
    await h.sessions();
    expect(heard).toEqual([]);
  });

  it('a failed turn leaves the session failed with its code, and a restart reads the same attention back from the log #LN-11 #RS-1', async () => {
    // The harness reports the failure with a code, then (as the fake does after every script) the turn again: a late report changes nothing.
    const fails: FakeTurnScript = async (t) => {
      t.emit({ t: 'turn.completed', turnId: t.turnId, status: 'failed', error: { code: 'harness_error', retryable: false } });
    };
    const w = await daemon({ script: fails });
    const c = await w.client();
    await c.input('s', 'go');
    const failed = await until(() => {
      const a = w.gw.sessions().find((s) => s.sessionKey === 's')?.attention;
      return a?.state === 'failed' && a;
    });
    expect(failed).toMatchObject({ reasons: [{ kind: 'failed', code: 'harness_error' }] });
    await until(() => w.gw.hub.log.read('s', 0).filter((e) => e.body.t === 'turn.completed').length === 2);
    expect(w.gw.sessions().find((s) => s.sessionKey === 's')!.attention).toStrictEqual(failed);
    await w.stop();
    const w2 = await daemon({ dir: w.dir, script: fails });
    expect(w2.gw.sessions().find((s) => s.sessionKey === 's')!.attention).toStrictEqual(failed);
  });
});
