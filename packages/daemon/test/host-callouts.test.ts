import { describe, expect, it } from 'vitest';
import type { FakeTurnScript } from '@agents-io/testkit';
import type { ReplyRoute } from '@agents-io/protocol';
import { calloutHooks } from '../src/host.js';
import { daemon, until, type World } from './helpers.js';

/*
 * Host `policy` hooks beyond `route` (docs/design/host-callouts): `resolve` and
 * `outbound`, opted into with `host.hello { callouts: [...] }`, and answers a host
 * relays on a principal's behalf (`resolve { onBehalfOf }`).
 */

const approval: FakeTurnScript = async (t) => {
  t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'rm -rf build', risk: { writes: true }, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
  const d = await t.waitDecision('r1');
  t.emit({ t: 'text.snapshot', text: `got ${d.kind}`, final: true }, { audience: 'answer' });
};

const events = (w: World, key: string, t: string) => w.gw.hub.log.read(key, 0).filter((e) => e.body.t === t).map((e) => e.body as Record<string, unknown>);
const route: ReplyRoute = { channel: 'fake', account: 'default', conversationId: 'elsewhere' };

describe('host.hello callouts', () => {
  it('true is route only; a list names hooks, unknown ones ignored; the result lists what was granted; features advertise it', async () => {
    expect([...calloutHooks(true)]).toEqual(['route']);
    expect([...calloutHooks(false)]).toEqual([]);
    expect([...calloutHooks(['outbound', 'nope', 'resolve'])]).toEqual(['resolve', 'outbound']);
    const w = await daemon();
    const c = await w.client();
    const r = await c.hello({ token: w.gw.token, name: 'h', callouts: ['resolve', 'nope'] });
    expect(r).toMatchObject({ host: true, callouts: ['resolve'] });
    expect(r.features).toEqual(expect.arrayContaining(['callouts.resolve', 'callouts.outbound', 'resolve.onBehalfOf', 'inbound.redispatch']));
    expect(w.gw.host.answers('resolve')).toBe(true);
    expect(w.gw.host.answers('route')).toBe(false);
    // An empty list is no role at all: not the host.
    const d = await w.client();
    expect(await d.hello({ token: w.gw.token, name: 'tool', callouts: [] })).toMatchObject({ host: false, callouts: [] });
  });
});

describe('resolve callout', () => {
  it('the host picks the resolver (human) and answers on the principal\'s behalf; the log records the principal and the host', async () => {
    const w = await daemon({ script: approval });
    const h = await w.host({ callouts: ['resolve'] });
    const asked: Record<string, unknown>[] = [];
    h.onRequest('policy', (f) => {
      asked.push(f);
      return { kind: 'human', principals: ['member-7'], routes: [] };
    });
    const c = await w.client();
    await c.input('S1', 'go');
    const opened = await until(() => events(w, 'S1', 'request.opened')[0]);
    expect(opened).toMatchObject({ requestId: 'r1', resolver: { kind: 'human', principals: ['member-7'] } });
    expect(asked[0]).toMatchObject({ hook: 'resolve', args: { request: { requestId: 'r1', kind: 'tool_approval' }, ctx: { sessionKey: 'S1', run: { profile: expect.any(String) } } } });
    expect((asked[0]!.args as { request: Record<string, unknown> }).request.resolver).toBeUndefined();

    // Not eligible: another principal, or onBehalfOf from a connection that is not a host.
    await expect(h.command({ type: 'resolve', sessionKey: 'S1', requestId: 'r1', decision: { kind: 'allow_once' }, onBehalfOf: 'member-8' })).rejects.toMatchObject({ code: 'not_eligible' });
    await expect(c.command({ type: 'resolve', sessionKey: 'S1', requestId: 'r1', decision: { kind: 'allow_once' }, onBehalfOf: 'member-7' })).rejects.toMatchObject({ code: 'not_eligible' });
    // The host itself is not one of the principals.
    await expect(h.command({ type: 'resolve', sessionKey: 'S1', requestId: 'r1', decision: { kind: 'allow_once' } })).rejects.toMatchObject({ code: 'not_eligible' });

    await h.command({ type: 'resolve', sessionKey: 'S1', requestId: 'r1', decision: { kind: 'allow_once' }, onBehalfOf: 'member-7' });
    await until(() => events(w, 'S1', 'turn.completed').length === 1);
    expect(events(w, 'S1', 'request.resolved')[0]).toMatchObject({ by: { kind: 'human', id: 'member-7', via: 'host:xwo' } });
    expect(events(w, 'S1', 'text.snapshot').at(-1)).toMatchObject({ text: 'got allow_once' });
  });

  it('a host resolver answered on behalf of a principal records it with via', async () => {
    const w = await daemon({ script: approval });
    const h = await w.host({ callouts: ['resolve'] });
    h.onRequest('policy', () => ({ kind: 'host' }));
    const c = await w.client();
    await c.input('S2', 'go');
    await until(() => events(w, 'S2', 'request.opened')[0]);
    await h.command({ type: 'resolve', sessionKey: 'S2', requestId: 'r1', decision: { kind: 'deny' }, onBehalfOf: 'member-7' });
    await until(() => events(w, 'S2', 'turn.completed').length === 1);
    expect(events(w, 'S2', 'request.resolved')[0]).toMatchObject({ by: { kind: 'host', id: 'member-7', via: 'host:xwo' } });
  });

  it('timeout, error and a bad answer fall back to the local policy; a host without the hook is never asked', async () => {
    for (const answer of ['timeout', 'error', 'bad', 'not-asked'] as const) {
      const w = await daemon({ script: approval, raw: { hostCallouts: { resolve: { timeoutMs: 50 } } }, policy: { resolve: async () => ({ kind: 'auto', decision: { kind: 'deny', message: 'local' } }) } });
      const h = await w.host({ callouts: answer === 'not-asked' ? ['route'] : ['resolve'] });
      let asked = 0;
      h.onRequest('policy', async () => {
        asked++;
        if (answer === 'timeout') await new Promise((r) => setTimeout(r, 300));
        if (answer === 'error') throw new Error('boom');
        return answer === 'bad' ? { kind: 'nonsense' } : { kind: 'auto', decision: { kind: 'allow_once' } };
      });
      const c = await w.client();
      await c.input('S3', 'go');
      await until(() => events(w, 'S3', 'turn.completed').length === 1);
      expect(events(w, 'S3', 'request.opened')[0]).toMatchObject({ resolver: { kind: 'auto', decision: { kind: 'deny', message: 'local' } } });
      expect(events(w, 'S3', 'text.snapshot').at(-1)).toMatchObject({ text: 'got deny' });
      expect(asked).toBe(answer === 'not-asked' ? 0 : 1);
    }
  });
});

describe('outbound callout', () => {
  it('the host decides; timeout, error and bad answers deny; without the hook the local policy decides', async () => {
    const w = await daemon({ raw: { hostCallouts: { outbound: { timeoutMs: 50 } } } });
    // No host: the local policy (an unregistered route outside a turn is denied, a registered one allowed).
    expect(await w.gw.policy.outbound({ from: null, to: route })).toBe('deny');

    const h = await w.host({ callouts: ['outbound'] });
    let mode: 'allow' | 'deny' | 'timeout' | 'error' | 'bad' = 'allow';
    const seen: Record<string, unknown>[] = [];
    h.onRequest('policy', async (f) => {
      seen.push(f);
      if (mode === 'timeout') await new Promise((r) => setTimeout(r, 300));
      if (mode === 'error') throw new Error('boom');
      return mode === 'bad' ? { verdict: 'maybe' } : { verdict: mode };
    });
    expect(await w.gw.policy.outbound({ from: null, to: route })).toBe('allow');
    expect(seen[0]).toMatchObject({ hook: 'outbound', args: { from: null, to: route } });
    for (const m of ['deny', 'timeout', 'error', 'bad'] as const) {
      mode = m;
      expect(await w.gw.policy.outbound({ from: null, to: route })).toBe('deny');
    }
  });

  it('a host that only answers route callouts leaves outbound to the local policy', async () => {
    const w = await daemon({ raw: { policy: { owners: ['fake:alice'], routes: ['fake:default:elsewhere'] } } });
    const h = await w.host({ callouts: true });
    h.onRequest('policy', () => {
      throw new Error('must not be asked');
    });
    expect(await w.gw.policy.outbound({ from: null, to: route })).toBe('allow');
  });
});
