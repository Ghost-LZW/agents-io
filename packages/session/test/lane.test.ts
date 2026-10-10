import { describe, expect, it } from 'vitest';
import { FakeHarness, assertConformingStream, fakeHarnessCaps } from '@agents-io/testkit';
import type { BodyOf, Decision } from '@agents-io/protocol';
import { Lane, settleLeftoverInputs, type ModelReviewer } from '../src/index.js';
import { ManualHarness, RUN, SteerableHarness, bodies, gate, input, origin, policy, route, setup, until } from './helpers.js';

const turnsOf = (evs: ReturnType<ReturnType<typeof setup>['events']>) =>
  bodies(evs, 'turn.started').map((b) => (b as BodyOf<'turn.started'>).inputIds);

/** The terminal events (consumed / rejected / cancelled) that name an input. */
const terminalOf = (evs: ReturnType<ReturnType<typeof setup>['events']>, inputId: string) =>
  bodies(evs).filter((b) => (b.t === 'input.consumed' || b.t === 'input.rejected' || b.t === 'input.cancelled') && (b as { inputIds: string[] }).inputIds.includes(inputId));

const req = (id: string, extra: Partial<BodyOf<'request.opened'>> = {}): BodyOf<'request.opened'> => ({
  t: 'request.opened',
  requestId: id,
  kind: 'tool_approval',
  title: 'rm -rf build',
  risk: { writes: true },
  allowedDecisions: ['allow_once', 'deny'],
  allowAlways: false,
  defaultDeny: true,
  ...extra,
});

describe('Lane: turns and queue', () => {
  it('runs a turn and wraps harness events into a gapless, conforming session stream #LN-1', async () => {
    const { lane, raw, events } = setup();
    const i = input('hello');
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' })).toEqual({ ok: true, disposition: 'new_turn' });
    await until(() => bodies(events(), 'turn.completed').length === 1);
    await lane.whenIdle();

    assertConformingStream(raw, { turnInputs: (t) => (t ? [i.inputId] : undefined) });
    const evs = events();
    assertConformingStream(evs);
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, k) => k + 1));
    expect(evs.every((e) => e.v === 1 && e.sessionKey === 's1' && e.harness === 'fake')).toBe(true);
    // Admission happens before the harness is bound: generation 0 means "no binding yet".
    expect(evs.map((e) => e.generation)).toEqual([0, 1, 1, 1, 1, 1, 1]);
    expect(bodies(evs).map((b) => b.t)).toEqual([
      'input.admitted',
      'turn.started',
      'session.state',
      'text.snapshot',
      'input.consumed',
      'turn.completed',
      'session.state',
    ]);
    const started = evs[1]!.body as BodyOf<'turn.started'>;
    expect(started).toMatchObject({ owner: 'fake:alice', run: { harness: 'fake', profile: 'bypass' } });
  });

  it('never merges inputs from two principals or two routes into one turn #IN-3 #LN-2', async () => {
    const g = gate();
    let first = true;
    const { lane, events } = setup({
      harness: new FakeHarness(async () => {
        if (first) {
          first = false;
          await g.promise;
        }
      }),
    });
    const send = (i: ReturnType<typeof input>) => lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' });
    await send(input('busy', { id: 'a0' }));
    expect((await send(input('b1', { id: 'b1', principal: 'fake:bob' }))).ok).toBe(true);
    await send(input('a1', { id: 'a1' }));
    await send(input('a2', { id: 'a2' }));
    await send(input('a3', { id: 'a3', route: route('other') }));
    await send(input('u1', { id: 'u1', principal: null }));
    await send(input('u2', { id: 'u2', principal: null }));
    expect(lane.queued()).toEqual(['b1', 'a1', 'a2', 'a3', 'u1', 'u2']);
    g.open();
    await until(() => bodies(events(), 'turn.completed').length === 6);
    expect(turnsOf(events())).toEqual([['a0'], ['b1'], ['a1', 'a2'], ['a3'], ['u1'], ['u2']]);
    const profiles = bodies(events(), 'turn.started').map((b) => (b as BodyOf<'turn.started'>).run.profile);
    expect(profiles).toEqual(['bypass', 'bypass', 'bypass', 'bypass', 'restricted', 'restricted']);
    assertConformingStream(events());
  });

  it('re-queues admitted-but-unconsumed inputs once, then rejects them #IN-1 #IN-2', async () => {
    const h = new ManualHarness();
    const { lane, events } = setup({ harness: h });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('x', { id: 'x' }), mode: 'queue' });
    await until(() => h.session?.starts.length === 1);
    h.session!.complete(h.session!.starts[0]!.turnId, []);
    await until(() => h.session!.starts.length === 2);
    expect(h.session!.starts[1]!.inputs.map((i) => i.inputId)).toEqual(['x']);
    h.session!.complete(h.session!.starts[1]!.turnId, []);
    await until(() => bodies(events(), 'input.rejected').length === 1);
    expect(bodies(events(), 'input.rejected')[0]).toEqual({ t: 'input.rejected', inputIds: ['x'], reason: 'not_consumed' });
    expect(bodies(events(), 'input.admitted').map((b) => (b as BodyOf<'input.admitted'>).disposition)).toEqual(['new_turn', 'queued']);
    await lane.whenIdle();
  });

  it('marks a turn ambiguous when the harness consumed inputs it was not given #IN-4', async () => {
    const h = new ManualHarness();
    const { lane, events } = setup({ harness: h });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('x', { id: 'x' }), mode: 'queue' });
    await until(() => h.session?.starts.length === 1);
    h.session!.complete(h.session!.starts[0]!.turnId, ['x', 'ghost']);
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(bodies(events(), 'turn.completed')[0]).toMatchObject({ status: 'ambiguous' });
  });

  it('closes the turn as ambiguous when the harness stream ends mid-turn #IN-1', async () => {
    const h = new ManualHarness();
    const { lane, events } = setup({ harness: h });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('x', { id: 'x' }), mode: 'queue' });
    await until(() => h.session?.starts.length === 1);
    await h.session!.close();
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(bodies(events(), 'turn.completed')[0]).toMatchObject({ status: 'ambiguous', error: { code: 'harness_closed' } });
    expect(bodies(events(), 'input.rejected')[0]).toMatchObject({ inputIds: ['x'], reason: 'ambiguous' });
  });

  it('ignores a duplicate inputId #IN-5', async () => {
    const { lane } = setup();
    const i = input('x');
    await lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' });
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' })).toEqual({ ok: true, disposition: 'duplicate' });
  });
});

describe('Lane: steer', () => {
  it('degrades to queue when the harness cannot steer #IN-1', async () => {
    const g = gate();
    const { lane, events } = setup({ harness: new FakeHarness(() => g.promise) });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('a', { id: 'a' }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: input('b', { id: 'b' }), mode: 'steer' })).toEqual({ ok: true, disposition: 'queued' });
    expect(bodies(events(), 'notice').at(-1)).toMatchObject({ message: expect.stringContaining('unsupported') });
    g.open();
    await until(() => bodies(events(), 'turn.completed').length === 2);
    expect(turnsOf(events())).toEqual([['a'], ['b']]);
  });

  it('steers only the turn owner; others are queued; another route becomes an extra delivery #DL-3 #IN-3', async () => {
    const g = gate();
    const h = new SteerableHarness(async (t) => {
      await g.promise;
      t.emit({ t: 'text.snapshot', text: 'done', final: true }, { audience: 'answer' });
    });
    const { lane, events, raw } = setup({ harness: h });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('a', { id: 'a' }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    const turnId = lane.activeTurn()!.turnId;

    expect(await lane.command({ type: 'input', sessionKey: 's1', input: input('same', { id: 's' }), mode: 'steer', expectedTurnId: turnId })).toEqual({ ok: true, disposition: 'steer' });
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: input('bob', { id: 'b', principal: 'fake:bob' }), mode: 'steer' })).toEqual({ ok: true, disposition: 'queued' });
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: input('stale', { id: 'st' }), mode: 'steer', expectedTurnId: 'old' })).toEqual({ ok: true, disposition: 'queued' });
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: input('web', { id: 'w', route: route('web', 'web') }), mode: 'steer' })).toEqual({ ok: true, disposition: 'steer' });
    expect(bodies(events(), 'turn.delivery_added')).toEqual([{ t: 'turn.delivery_added', turnId, route: route('web', 'web'), reason: 'steer' }]);

    g.open();
    await until(() => bodies(events(), 'turn.completed').length === 3);
    expect(bodies(events(), 'input.consumed')[0]).toMatchObject({ inputIds: ['a', 's', 'w'] });
    expect(turnsOf(events())).toEqual([['a'], ['b'], ['st']]);
    assertConformingStream(raw);
  });

  it('degrades a steer the harness refuses (stale / not_steerable / no_active_turn) #IN-1', async () => {
    const g = gate();
    const h = new SteerableHarness(() => g.promise);
    const { lane, events } = setup({ harness: h });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('a', { id: 'a' }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    (h.sessions[0] as unknown as { steerResult: string }).steerResult = 'not_steerable';
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: input('b', { id: 'b' }), mode: 'steer' })).toEqual({ ok: true, disposition: 'queued' });
    expect(bodies(events(), 'notice').at(-1)).toMatchObject({ message: expect.stringContaining('not_steerable') });
    g.open();
    await lane.whenIdle();
  });
  it('a steer that would change the turn\'s profile is queued instead (the profile comes from the turn\'s own inputs) #ID-6', async () => {
    const g = gate();
    const { lane, events } = setup({ harness: new SteerableHarness(() => g.promise) });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('a', { id: 'a' }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    // Same principal as the turn owner, but not identified as an owner this time: restricted on its own.
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: input('n', { id: 'n', labels: [] }), mode: 'steer' })).toEqual({ ok: true, disposition: 'queued' });
    expect(bodies(events(), 'notice').at(-1)).toMatchObject({ message: expect.stringContaining('profile_change') });
    g.open();
    await until(() => bodies(events(), 'turn.completed').length === 2);
    expect(turnsOf(events())).toEqual([['a'], ['n']]);
    expect(bodies(events(), 'turn.started').map((b) => (b as BodyOf<'turn.started'>).run.profile)).toEqual(['bypass', 'restricted']);
  });
});

describe('Lane: interrupt', () => {
  const blocking = () =>
    new FakeHarness(
      (t) =>
        new Promise((_, reject) => {
          t.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

  it('interrupts the active turn and optionally clears the queue #IN-1 #CT-1', async () => {
    const { lane, events, raw } = setup({ harness: blocking() });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('a', { id: 'a' }), mode: 'queue' });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('b', { id: 'b' }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    expect(await lane.command({ type: 'interrupt', sessionKey: 's1', origin: origin('fake:alice'), cancelQueue: true })).toEqual({ ok: true });
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(bodies(events(), 'turn.completed')[0]).toMatchObject({ status: 'interrupted' });
    expect(bodies(events(), 'input.cancelled')).toEqual([{ t: 'input.cancelled', inputIds: ['b'], reason: 'interrupt' }]);
    await lane.whenIdle();
    expect(bodies(events(), 'turn.started')).toHaveLength(1);
    assertConformingStream(raw);
  });

  it('refuses interrupts from someone who is neither turn owner nor owner #CT-1', async () => {
    const { lane, events } = setup({ harness: blocking() });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('a'), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    expect(await lane.command({ type: 'interrupt', sessionKey: 's1', origin: origin(null) })).toEqual({ ok: false, reason: 'forbidden' });
    expect(await lane.command({ type: 'interrupt', sessionKey: 's1', origin: origin('x', ['guest']) })).toEqual({ ok: false, reason: 'forbidden' });
    expect(await lane.command({ type: 'interrupt', sessionKey: 's1', turnId: 'nope', origin: origin('fake:alice') })).toEqual({ ok: false, reason: 'stale_turn' });
    await lane.close();
  });

  it('interrupt-mode input stops the turn and runs next #IN-1', async () => {
    const { lane, events } = setup({ harness: blocking() });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('a', { id: 'a' }), mode: 'queue' });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('q', { id: 'q' }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    await lane.command({ type: 'input', sessionKey: 's1', input: input('stop', { id: 'i' }), mode: 'interrupt' });
    await until(() => bodies(events(), 'turn.started').length === 2);
    expect(turnsOf(events())).toEqual([['a'], ['i', 'q']]);
    await lane.close();
  });
});

describe('Lane: requests', () => {
  const asking = (decisions: Decision[]) =>
    new FakeHarness(async (t) => {
      t.emit(req('r1'));
      decisions.push(await t.waitDecision('r1'));
      t.emit({ t: 'request.resolved', requestId: 'r1', decision: decisions[0]!, by: { kind: 'harness' } });
    });

  it('auto: answers immediately per policy (bypass → allow) #ID-6 #RQ-1', async () => {
    const got: Decision[] = [];
    const { lane, events, raw } = setup({ harness: asking(got) });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go'), mode: 'queue' });
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(got).toEqual([{ kind: 'allow_once' }]);
    const opened = bodies(events(), 'request.opened')[0] as BodyOf<'request.opened'>;
    expect(opened.resolver).toEqual({ kind: 'auto', decision: { kind: 'allow_once' } });
    // The harness echo of the resolution is dropped: one resolution per request.
    expect(bodies(events(), 'request.resolved')).toEqual([{ t: 'request.resolved', requestId: 'r1', decision: { kind: 'allow_once' }, by: { kind: 'auto' } }]);
    assertConformingStream(raw);
    assertConformingStream(events());
  });

  it('auto deny for a restricted turn #ID-6', async () => {
    const got: Decision[] = [];
    const { lane, events } = setup({ harness: asking(got) });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go', { principal: null }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(got[0]).toMatchObject({ kind: 'deny' });
  });

  it('human: re-checks eligibility server side; first resolve wins #RQ-1', async () => {
    const got: Decision[] = [];
    const { lane, events } = setup({
      harness: asking(got),
      policy: policy({ resolve: async () => ({ kind: 'human', principals: ['fake:alice'], routes: [] }) }),
    });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go'), mode: 'queue' });
    await until(() => bodies(events(), 'request.opened').length === 1);
    const opened = events().find((e) => e.body.t === 'request.opened')!;
    expect(opened.audience).toBe('approval');
    await until(() => bodies(events(), 'session.state').some((b) => (b as BodyOf<'session.state'>).state === 'requires_action'));

    const resolve = (who: string | null, d: Decision) => lane.command({ type: 'resolve', sessionKey: 's1', requestId: 'r1', decision: d, origin: origin(who) });
    expect(await resolve('fake:bob', { kind: 'allow_once' })).toEqual({ ok: false, reason: 'not_eligible' });
    expect(await resolve('fake:alice', { kind: 'allow_session' })).toEqual({ ok: false, reason: 'decision_not_allowed' });
    const [a, b] = await Promise.all([resolve('fake:alice', { kind: 'deny', message: 'no' }), resolve('fake:alice', { kind: 'allow_once' })]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: false, reason: 'already_resolved' });
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(got).toEqual([{ kind: 'deny', message: 'no' }]);
    expect(bodies(events(), 'request.resolved')).toEqual([{ t: 'request.resolved', requestId: 'r1', decision: { kind: 'deny', message: 'no' }, by: { kind: 'human', id: 'fake:alice' } }]);
    expect(events().find((e) => e.body.t === 'request.resolved')!.audience).toBe('approval');
  });

  it('human: times out to deny #RQ-2', async () => {
    const got: Decision[] = [];
    const { lane, events } = setup({
      harness: asking(got),
      requestTimeoutMs: 20,
      policy: policy({ resolve: async () => ({ kind: 'human', principals: ['fake:alice'], routes: [] }) }),
    });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go'), mode: 'queue' });
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(got[0]).toMatchObject({ kind: 'deny' });
    expect(bodies(events(), 'request.resolved')[0]).toMatchObject({ by: 'timeout' });
  });

  it('host: only a system origin may resolve #RQ-1', async () => {
    const got: Decision[] = [];
    const { lane, events } = setup({ harness: asking(got), policy: policy({ resolve: async () => ({ kind: 'host' }) }) });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go'), mode: 'queue' });
    await until(() => bodies(events(), 'request.opened').length === 1);
    const cmd = (o: ReturnType<typeof origin>) => lane.command({ type: 'resolve', sessionKey: 's1', requestId: 'r1', decision: { kind: 'allow_once' }, origin: o });
    expect(await cmd(origin('fake:alice'))).toEqual({ ok: false, reason: 'not_eligible' });
    expect(await cmd(origin('host', [], 'system'))).toEqual({ ok: true });
    await until(() => got.length === 1);
  });

  it('onBehalfOf: only a host connection (system origin through the host adapter) may relay #RQ-3', async () => {
    const got: Decision[] = [];
    const { lane, events } = setup({ harness: asking(got), policy: policy({ resolve: async () => ({ kind: 'human', principals: ['fake:alice'], routes: [] }) }) });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go'), mode: 'queue' });
    await until(() => bodies(events(), 'request.opened').length === 1);
    const cmd = (o: ReturnType<typeof origin>) => lane.command({ type: 'resolve', sessionKey: 's1', requestId: 'r1', decision: { kind: 'allow_once' }, origin: o, onBehalfOf: 'fake:alice' });
    // Another internal system origin (a watch, a run…) may not answer on a principal's behalf.
    expect(await cmd(origin('watch', [], 'system'))).toEqual({ ok: false, reason: 'not_eligible' });
    expect(await cmd({ ...origin('host:xwo', [], 'system'), adapter: 'host', via: 'host:xwo' })).toEqual({ ok: true });
    await until(() => got.length === 1);
    expect(bodies(events(), 'request.resolved')[0]).toMatchObject({ by: { kind: 'human', id: 'fake:alice', via: 'host:xwo' } });
  });

  it('model: uses the reviewer; escalation re-opens for a human; no reviewer falls back to human #RQ-1', async () => {
    const run = async (reviewer: ModelReviewer | undefined) => {
      const got: Decision[] = [];
      const ctx = setup({
        harness: asking(got),
        policy: policy({ resolve: async () => ({ kind: 'model', model: 'judge' }) }),
        ...(reviewer ? { modelReviewer: reviewer } : {}),
      });
      await ctx.lane.command({ type: 'input', sessionKey: 's1', input: input('go'), mode: 'queue' });
      return { ...ctx, got };
    };

    const a = await run(async ({ model, request }) => {
      expect(model).toBe('judge');
      expect(request.requestId).toBe('r1');
      return { kind: 'allow_once' };
    });
    await until(() => a.got.length === 1);
    expect(bodies(a.events(), 'request.resolved')[0]).toMatchObject({ by: { kind: 'model', id: 'judge' } });

    const b = await run(async () => ({ escalate: true }));
    await until(() => bodies(b.events(), 'request.opened').length === 2);
    const reopened = bodies(b.events(), 'request.opened')[1] as BodyOf<'request.opened'>;
    expect(reopened.resolver).toEqual({ kind: 'human', principals: ['fake:alice'], routes: ['fake:default:c1'] });
    expect(await b.lane.command({ type: 'resolve', sessionKey: 's1', requestId: 'r1', decision: { kind: 'allow_once' }, origin: origin('fake:alice') })).toEqual({ ok: true });
    await until(() => b.got.length === 1);

    const c = await run(undefined);
    await until(() => bodies(c.events(), 'request.opened').length === 1);
    expect((bodies(c.events(), 'request.opened')[0] as BodyOf<'request.opened'>).resolver).toMatchObject({ kind: 'human' });
    await c.lane.close();
  });

  it('cancels open requests when the turn ends without answering them #RQ-2', async () => {
    const h = new ManualHarness({ ...fakeHarnessCaps });
    const { lane, events } = setup({ harness: h, policy: policy({ resolve: async () => ({ kind: 'human', principals: ['fake:alice'], routes: [] }) }) });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('x', { id: 'x' }), mode: 'queue' });
    await until(() => h.session?.starts.length === 1);
    const turnId = h.session!.starts[0]!.turnId;
    h.session!.push(req('r9'), { turnId });
    await until(() => bodies(events(), 'request.opened').length === 1);
    h.session!.complete(turnId, ['x'], 'interrupted');
    await until(() => bodies(events(), 'turn.completed').length === 1);
    const kinds = bodies(events()).map((b) => b.t);
    expect(kinds.indexOf('request.resolved')).toBeLessThan(kinds.indexOf('turn.completed'));
    expect(bodies(events(), 'request.resolved')[0]).toMatchObject({ by: 'runtime_cancelled', decision: null });
    assertConformingStream(events());
  });
});

describe('Lane: host restart', () => {
  /** First host: start a turn, then detach mid-turn. Returns the shared hub and the open turn. */
  async function firstHost() {
    const h1 = new ManualHarness();
    const a = setup({ harness: h1 });
    await a.lane.command({ type: 'input', sessionKey: 's1', input: input('long job', { id: 'x' }), mode: 'queue' });
    await until(() => h1.session?.starts.length === 1);
    const turnId = h1.session!.starts[0]!.turnId;
    await until(() => bodies(a.events(), 'turn.started').length === 1);
    a.lane.detach();
    await h1.session!.close(); // the adapter's own detach ends the stream
    await new Promise((r) => setTimeout(r, 10));
    return { ...a, turnId };
  }

  const nextLane = (hub: ReturnType<typeof setup>['hub'], harness: ManualHarness) =>
    new Lane({ sessionKey: 's1', harness, hub, policy: policy(), thinkingHeadline: null });

  it('detach leaves the running turn open in the log #RS-2', async () => {
    const a = await firstHost();
    expect(bodies(a.events(), 'turn.completed')).toEqual([]);
    expect(a.hub.snapshot('s1').turn?.turnId).toBe(a.turnId);
  });

  it('a new lane adopts the turn (turn.adopted), keeps it as the active turn and queues behind it #RS-2', async () => {
    const a = await firstHost();
    const h2 = new ManualHarness();
    const lane2 = nextLane(a.hub, h2);
    await lane2.open();
    expect(h2.session!.args.generation).toBe(2);
    h2.session!.push({ t: 'turn.adopted', turnId: a.turnId, nativeTurnId: 'n1', inputIds: ['x'] }, { turnId: a.turnId });
    await until(() => lane2.activeTurn()?.turnId === a.turnId);
    expect(lane2.activeTurn()).toMatchObject({ owner: 'fake:alice' });

    expect(await lane2.command({ type: 'input', sessionKey: 's1', input: input('next', { id: 'y' }), mode: 'queue' })).toEqual({ ok: true, disposition: 'queued' });
    expect(h2.session!.starts).toHaveLength(0);
    h2.session!.complete(a.turnId, ['x']);
    await until(() => h2.session!.starts.length === 1);
    expect(bodies(a.events(), 'turn.completed')).toEqual([{ t: 'turn.completed', turnId: a.turnId, status: 'completed' }]);
    expect(bodies(a.events(), 'input.rejected')).toEqual([]);
    assertConformingStream(a.events(), { allowTrailing: true });
  });

  it('settles a turn nobody adopted as ambiguous before the next turn starts, rejecting its unconsumed inputs #IN-1 #RS-5', async () => {
    const a = await firstHost();
    const h2 = new ManualHarness();
    const lane2 = nextLane(a.hub, h2);
    await lane2.command({ type: 'input', sessionKey: 's1', input: input('next', { id: 'y' }), mode: 'queue' });
    await until(() => h2.session?.starts.length === 1);
    expect(bodies(a.events(), 'turn.completed')[0]).toMatchObject({ turnId: a.turnId, status: 'ambiguous', error: { code: 'host_restarted' } });
    // No reply route: the turn's card, finalized as ambiguous, already tells the sender.
    expect(bodies(a.events(), 'input.rejected')).toEqual([{ t: 'input.rejected', inputIds: ['x'], reason: 'host_restarted' }]);
    expect(a.hub.snapshot('s1').turn?.turnId).toBe(h2.session!.starts[0]!.turnId);
  });

  it('detach rejects the inputs queued behind the running turn (lane_closed, with their route), never the turn\'s own; the next lane still adopts it #IN-1 #RS-6', async () => {
    const h1 = new ManualHarness();
    const a = setup({ harness: h1 });
    const send = (i: ReturnType<typeof input>) => a.lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' });
    await send(input('long job', { id: 'x' }));
    await until(() => bodies(a.events(), 'turn.started').length === 1);
    const turnId = h1.session!.starts[0]!.turnId;
    await send(input('next', { id: 'y' }));
    await send(input('other chat', { id: 'z', route: route('c2') }));
    a.lane.detach('gateway stopping');
    await h1.session!.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(bodies(a.events(), 'input.rejected')).toEqual([
      { t: 'input.rejected', inputIds: ['y'], reason: 'lane_closed: gateway stopping', replyRoute: route() },
      { t: 'input.rejected', inputIds: ['z'], reason: 'lane_closed: gateway stopping', replyRoute: route('c2') },
    ]);
    expect(a.hub.snapshot('s1')).toMatchObject({ queued: [], turn: { turnId, inputIds: ['x'] } });
    expect(settleLeftoverInputs(a.hub, 's1')).toEqual([]);

    const h2 = new ManualHarness();
    const lane2 = nextLane(a.hub, h2);
    await lane2.open();
    h2.session!.push({ t: 'turn.adopted', turnId, nativeTurnId: 'n1', inputIds: ['x'] }, { turnId });
    await until(() => lane2.activeTurn()?.turnId === turnId);
    h2.session!.complete(turnId, ['x']);
    await until(() => bodies(a.events(), 'turn.completed').length === 1);
    expect(bodies(a.events(), 'turn.completed')).toEqual([{ t: 'turn.completed', turnId, status: 'completed' }]);
    expect(bodies(a.events(), 'input.rejected').flatMap((b) => (b as BodyOf<'input.rejected'>).inputIds)).toEqual(['y', 'z']);
  });

  it('crash leftovers: inputs a previous process admitted and never settled are rejected (host_restarted) at startup; the open turn is left to adoption #IN-1 #RS-6', async () => {
    const h1 = new ManualHarness();
    const a = setup({ harness: h1 });
    await a.lane.command({ type: 'input', sessionKey: 's1', input: input('long job', { id: 'x' }), mode: 'queue' });
    await until(() => bodies(a.events(), 'turn.started').length === 1);
    await a.lane.command({ type: 'input', sessionKey: 's1', input: input('next', { id: 'y' }), mode: 'queue' });
    // The process dies here: no close, no detach.
    expect(a.hub.snapshot('s1').queued).toEqual(['y']);

    expect(settleLeftoverInputs(a.hub, 's1')).toEqual(['y']);
    expect(bodies(a.events(), 'input.rejected')).toEqual([{ t: 'input.rejected', inputIds: ['y'], reason: 'host_restarted' }]);
    expect(a.hub.snapshot('s1').queued).toEqual([]);
    expect(a.hub.snapshot('s1').turn?.inputIds).toEqual(['x']);
    expect(settleLeftoverInputs(a.hub, 's1')).toEqual([]); // idempotent
  });
  // INVARIANTS IN-1 不成立 3: an adopted turn starts with `inputs: []`, so its inputs the harness never reports consumed get no terminal state when it ends; turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('an adopted turn that ends without reporting its inputs consumed settles them #IN-1 #RS-2', async () => {
    const a = await firstHost();
    const h2 = new ManualHarness();
    const lane2 = nextLane(a.hub, h2);
    await lane2.open();
    h2.session!.push({ t: 'turn.adopted', turnId: a.turnId, nativeTurnId: 'n1', inputIds: ['x'] }, { turnId: a.turnId });
    await until(() => lane2.activeTurn()?.turnId === a.turnId);
    h2.session!.complete(a.turnId, []);
    await until(() => bodies(a.events(), 'turn.completed').length === 1);
    await lane2.whenIdle();
    expect(terminalOf(a.events(), 'x')).not.toEqual([]);
  });

  it('a leftover turn nobody adopts is settled ambiguous once the lane opens, without waiting for a new input #RS-5', async () => {
    const a = await firstHost();
    const lane2 = nextLane(a.hub, new ManualHarness());
    await lane2.open();
    await new Promise((r) => setTimeout(r, 50));
    await lane2.whenIdle();
    expect(bodies(a.events(), 'turn.completed')).toMatchObject([{ turnId: a.turnId, status: 'ambiguous', error: { code: 'host_restarted' } }]);
    expect(a.hub.snapshot('s1').turn).toBeNull();
  });
});

describe('Lane: close', () => {
  it('close rejects queued inputs (lane_closed) and the interrupted turn\'s; nothing stays queued #IN-1 #RS-6', async () => {
    const h = new ManualHarness();
    const { lane, events, hub } = setup({ harness: h });
    const send = (i: ReturnType<typeof input>) => lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' });
    await send(input('long job', { id: 'x' }));
    await until(() => bodies(events(), 'turn.started').length === 1);
    const turnId = h.session!.starts[0]!.turnId;
    await send(input('q1', { id: 'q1' }));
    await send(input('q2', { id: 'q2' }));
    h.session!.complete(turnId, [], 'interrupted'); // what the harness reports as it closes (handled after close begins)
    await lane.close('gateway stopping');
    await lane.whenIdle();
    expect(bodies(events(), 'input.rejected')).toEqual([
      { t: 'input.rejected', inputIds: ['q1', 'q2'], reason: 'lane_closed: gateway stopping', replyRoute: route() },
      { t: 'input.rejected', inputIds: ['x'], reason: 'interrupted' },
    ]);
    expect(hub.snapshot('s1').queued).toEqual([]);
    expect(await send(input('late', { id: 'late' }))).toEqual({ ok: false, reason: 'closed' });
  });

  it('an input requeued as the turn ends during close is rejected, not stranded #IN-1', async () => {
    const h = new ManualHarness();
    const { lane, events, hub } = setup({ harness: h });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('x', { id: 'x' }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    const turnId = h.session!.starts[0]!.turnId;
    h.session!.complete(turnId, []); // completed without consuming x (normally re-queued once), handled after close begins
    await lane.close('gateway stopping');
    await lane.whenIdle();
    expect(bodies(events(), 'input.rejected')).toEqual([{ t: 'input.rejected', inputIds: ['x'], reason: 'lane_closed: gateway stopping', replyRoute: route() }]);
    expect(hub.snapshot('s1').queued).toEqual([]);
    expect(h.session!.starts).toHaveLength(1);
  });

  it('an input whose admission was awaiting a policy hook when the lane closed is rejected #IN-1', async () => {
    const h = new ManualHarness();
    const g = gate();
    const { lane, events, hub } = setup({
      harness: h,
      policy: policy({
        control: async () => {
          await g.promise;
          return 'deny';
        },
      }),
    });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('x', { id: 'x' }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    const pending = lane.command({ type: 'input', sessionKey: 's1', input: input('stop!', { id: 'i' }), mode: 'interrupt' });
    await new Promise((r) => setTimeout(r, 5));
    lane.detach('gateway stopping');
    g.open();
    expect(await pending).toEqual({ ok: true, disposition: 'queued' });
    expect(bodies(events(), 'input.rejected')).toEqual([{ t: 'input.rejected', inputIds: ['i'], reason: 'lane_closed: gateway stopping', replyRoute: route() }]);
    expect(hub.snapshot('s1').queued).toEqual([]);
  });
});

describe('Lane: named harness instances', () => {
  it('opens the adapter the turn names, attributes events to it, and switches generations when the plan changes it #FC-2', async () => {
    const a = new FakeHarness(undefined, 'inst-a');
    const b = new FakeHarness(undefined, 'inst-b');
    let use = 'inst-a';
    const resumed: string[] = [];
    const pick = (name: string) => {
      if (name === 'inst-a') return a;
      if (name === 'inst-b') return b;
      throw new Error(`no harness ${name}`);
    };
    const { lane, events } = setup({
      harness: a,
      harnessFor: pick,
      resumeFor: (id) => (resumed.push(id), id === 'inst-b' ? 'native-b-old' : undefined),
      policy: policy({ plan: async () => ({ harness: use, model: 'm', profile: 'bypass' }) }),
    });
    const send = async (text: string) => {
      await lane.command({ type: 'input', sessionKey: 's1', input: input(text), mode: 'queue' });
      await lane.whenIdle();
    };
    await send('one');
    await send('two');
    expect(a.sessions).toHaveLength(1);
    use = 'inst-b';
    await send('three');
    expect(b.sessions).toHaveLength(1);
    expect(b.sessions[0]!.args).toMatchObject({ run: { harness: 'inst-b' }, resume: 'native-b-old', generation: 2 });
    expect(resumed).toEqual(['inst-a', 'inst-b']);
    const evs = events();
    const turns = evs.filter((e) => e.body.t === 'turn.completed');
    expect(turns.map((e) => [e.harness, e.generation])).toEqual([
      ['inst-a', 1],
      ['inst-a', 1],
      ['inst-b', 2],
    ]);
    expect(bodies(evs, 'notice')).toContainEqual(expect.objectContaining({ code: 'runtime_restart', message: 'switching harness inst-a → inst-b' }));
    // Nothing from the closed inst-a binding is recorded after the switch.
    const switchAt = evs.findIndex((e) => e.body.t === 'notice');
    expect(evs.slice(switchAt + 1).filter((e) => e.harness === 'inst-a')).toEqual([]);

    // An unknown instance rejects the turn's inputs instead of wedging the lane.
    use = 'nope';
    await send('four');
    expect(bodies(events(), 'input.rejected').at(-1)).toMatchObject({ reason: 'start_failed: no harness nope' });
  });
});

describe('Lane: robustness', () => {
  const blocking = () =>
    new FakeHarness(
      (t) =>
        new Promise((_, reject) => {
          t.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
  const guest = (text: string, id: string, who: string) => input(text, { id, principal: who, labels: ['guest'] });

  it('an input that arrives before the harness reports its adoption waits for it instead of settling the turn as ambiguous #RS-2', async () => {
    const h1 = new ManualHarness();
    const a = setup({ harness: h1 });
    await a.lane.command({ type: 'input', sessionKey: 's1', input: input('long job', { id: 'x' }), mode: 'queue' });
    await until(() => bodies(a.events(), 'turn.started').length === 1);
    const turnId = h1.session!.starts[0]!.turnId;
    a.lane.detach();
    await h1.session!.close();

    // Like Codex over a socket: the session reports the still-running turn as soon as it opens.
    class Adopting extends ManualHarness {
      override async open(args: Parameters<ManualHarness['open']>[0]) {
        const s = await super.open(args);
        s.push({ t: 'turn.adopted', turnId, nativeTurnId: 'n1', inputIds: ['x'] }, { turnId });
        return s;
      }
    }
    const h2 = new Adopting();
    const lane2 = new Lane({ sessionKey: 's1', harness: h2, hub: a.hub, policy: policy(), thinkingHeadline: null });
    expect(await lane2.command({ type: 'input', sessionKey: 's1', input: input('next', { id: 'y' }), mode: 'queue' })).toMatchObject({ ok: true });
    await until(() => lane2.activeTurn()?.turnId === turnId);
    expect(lane2.activeTurn()).toMatchObject({ owner: 'fake:alice' });
    expect(bodies(a.events(), 'turn.completed')).toEqual([]);
    expect(h2.session!.starts).toHaveLength(0);
    expect(lane2.queued()).toEqual(['y']);
    h2.session!.complete(turnId, ['x']);
    await until(() => h2.session!.starts.length === 1);
    expect(bodies(a.events(), 'turn.completed')).toEqual([{ t: 'turn.completed', turnId, status: 'completed' }]);
    expect(bodies(a.events(), 'input.rejected')).toEqual([]);
  });

  it('a throwing policy.escalate after a model escalation denies the request with a notice #RQ-2', async () => {
    const got: Decision[] = [];
    const { lane, events } = setup({
      harness: new FakeHarness(async (t) => {
        t.emit(req('r1'));
        got.push(await t.waitDecision('r1'));
      }),
      policy: policy({
        resolve: async () => ({ kind: 'model', model: 'judge' }),
        escalate: async () => {
          throw new Error('escalate boom');
        },
      }),
      modelReviewer: async () => ({ escalate: true }),
    });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go'), mode: 'queue' });
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(got[0]).toMatchObject({ kind: 'deny' });
    expect(bodies(events(), 'request.resolved')[0]).toMatchObject({ requestId: 'r1', decision: { kind: 'deny' } });
    expect(bodies(events(), 'notice')).toContainEqual(expect.objectContaining({ message: expect.stringContaining('escalate boom') }));
  });

  it('a throwing policy.escalate without a reviewer denies the request and keeps the harness session #RQ-2', async () => {
    const got: Decision[] = [];
    const h = new FakeHarness(async (t) => {
      t.emit(req('r1'));
      got.push(await t.waitDecision('r1'));
    });
    const { lane, events } = setup({
      harness: h,
      policy: policy({
        resolve: async () => ({ kind: 'model', model: 'judge' }),
        escalate: async () => {
          throw new Error('escalate boom');
        },
      }),
    });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go'), mode: 'queue' });
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(got[0]).toMatchObject({ kind: 'deny' });
    expect(bodies(events(), 'turn.completed')[0]).toMatchObject({ status: 'completed' });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('again'), mode: 'queue' });
    await until(() => bodies(events(), 'turn.completed').length === 2);
    expect(h.sessions).toHaveLength(1);
  });

  it('an exception while handling one harness event is logged and consumption continues #IN-1', async () => {
    const h = new FakeHarness(async (t) => {
      t.emit({ t: 'plan.updated', steps: [{ text: 'a', status: 'pending' }] });
      t.emit({ t: 'text.snapshot', text: 'done', final: true }, { audience: 'answer' });
    });
    const { lane, hub, events } = setup({ harness: h });
    const append = hub.append.bind(hub);
    let thrown = false;
    hub.append = (k, d) => {
      if (d.body.t === 'plan.updated' && !thrown) {
        thrown = true;
        throw new Error('disk full');
      }
      return append(k, d);
    };
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go'), mode: 'queue' });
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(bodies(events(), 'turn.completed')[0]).toMatchObject({ status: 'completed' });
    expect(bodies(events(), 'text.snapshot')).toHaveLength(1);
    expect(bodies(events(), 'notice')).toContainEqual(expect.objectContaining({ message: expect.stringContaining('disk full') }));
    await lane.command({ type: 'input', sessionKey: 's1', input: input('again'), mode: 'queue' });
    await until(() => bodies(events(), 'turn.completed').length === 2);
    expect(h.sessions).toHaveLength(1);
  });

  it('a request opened while idle is not cancelled by the next turn ending #RQ-2', async () => {
    const h = new ManualHarness();
    const { lane, events } = setup({ harness: h, policy: policy({ resolve: async () => ({ kind: 'human', principals: ['fake:alice'], routes: [] }) }) });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('one', { id: 'a' }), mode: 'queue' });
    await until(() => h.session?.starts.length === 1);
    h.session!.complete(h.session!.starts[0]!.turnId, ['a']);
    await until(() => bodies(events(), 'turn.completed').length === 1);
    h.session!.push(req('idle1', { kind: 'elicitation' }));
    await until(() => bodies(events(), 'request.opened').length === 1);
    await lane.command({ type: 'input', sessionKey: 's1', input: input('two', { id: 'b' }), mode: 'queue' });
    await until(() => h.session!.starts.length === 2);
    h.session!.complete(h.session!.starts[1]!.turnId, ['b']);
    await until(() => bodies(events(), 'turn.completed').length === 2);
    expect(bodies(events(), 'request.resolved')).toEqual([]);
    expect(await lane.command({ type: 'resolve', sessionKey: 's1', requestId: 'idle1', decision: { kind: 'allow_once' }, origin: origin('fake:alice') })).toEqual({ ok: true });
    expect(h.session!.responses).toEqual([{ requestId: 'idle1', decision: { kind: 'allow_once' } }]);
  });

  it('interrupt with cancelQueue is authorised as cancel_queue: a turn owner who is not an owner cancels only their own queued inputs #CT-1', async () => {
    const ops: string[] = [];
    const base = policy();
    const { lane, events } = setup({
      harness: blocking(),
      policy: { ...base, control: async (a) => (ops.push(a.op), base.control!(a)) },
    });
    await lane.command({ type: 'input', sessionKey: 's1', input: guest('busy', 'c1', 'fake:carol'), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    await lane.command({ type: 'input', sessionKey: 's1', input: guest('dave', 'd1', 'fake:dave'), mode: 'queue' });
    await lane.command({ type: 'input', sessionKey: 's1', input: guest('mine', 'c2', 'fake:carol'), mode: 'queue' });
    expect(await lane.command({ type: 'interrupt', sessionKey: 's1', origin: origin('fake:carol', ['guest']), cancelQueue: true })).toEqual({ ok: true });
    expect(ops).toEqual(['interrupt', 'cancel_queue']);
    expect(bodies(events(), 'input.cancelled')).toEqual([{ t: 'input.cancelled', inputIds: ['c2'], reason: 'interrupt' }]);
    await until(() => bodies(events(), 'turn.started').length === 2);
    expect(turnsOf(events()).at(-1)).toEqual(['d1']);
    await lane.close();
  });
  // INVARIANTS IN-1 不成立 1: `known.add` runs before an unguarded `await policy.control` (interrupt mode); a throw records nothing and burns the id (a retry answers duplicate); turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('a throwing policy.control on an interrupt-mode input still settles it (input.rejected); a retry with the same id is not a duplicate #IN-1', async () => {
    const { lane, events } = setup({
      harness: blocking(),
      policy: policy({
        control: async () => {
          throw new Error('control boom');
        },
      }),
    });
    try {
      await lane.command({ type: 'input', sessionKey: 's1', input: input('a', { id: 'a' }), mode: 'queue' });
      await until(() => bodies(events(), 'turn.started').length === 1);
      const stop = input('stop', { id: 'i' });
      await lane.command({ type: 'input', sessionKey: 's1', input: stop, mode: 'interrupt' }).catch(() => undefined);
      expect(terminalOf(events(), 'i').map((b) => b.t)).toEqual(['input.rejected']);
      expect(await lane.command({ type: 'input', sessionKey: 's1', input: stop, mode: 'queue' }).catch(() => undefined)).not.toEqual({ ok: true, disposition: 'duplicate' });
    } finally {
      await lane.close();
    }
  });

  // INVARIANTS IN-1 不成立 1: `known.add` runs before an unguarded `await policy.plan` (the steer's re-plan); a throw records nothing and burns the id (a retry answers duplicate); turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('a throwing policy.plan on a steer still settles the input (input.rejected); a retry with the same id is not a duplicate #IN-1', async () => {
    const g = gate();
    let plans = 0;
    const { lane, events } = setup({
      harness: new SteerableHarness(() => g.promise),
      policy: policy({
        plan: async () => {
          if (++plans > 1) throw new Error('plan boom');
          return { ...RUN, profile: 'bypass' };
        },
      }),
    });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('a', { id: 'a' }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    const more = input('more', { id: 's' });
    await lane.command({ type: 'input', sessionKey: 's1', input: more, mode: 'steer' }).catch(() => undefined);
    g.open();
    await until(() => bodies(events(), 'turn.completed').length === 1);
    await lane.whenIdle();
    expect(terminalOf(events(), 's').map((b) => b.t)).toEqual(['input.rejected']);
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: more, mode: 'queue' }).catch(() => undefined)).not.toEqual({ ok: true, disposition: 'duplicate' });
  });
});
