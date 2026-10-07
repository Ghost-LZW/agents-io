import { describe, expect, it } from 'vitest';
import { FakeHarness, assertConformingStream, fakeHarnessCaps } from '@agents-io/testkit';
import type { BodyOf, Decision } from '@agents-io/protocol';
import { Lane, type ModelReviewer } from '../src/index.js';
import { ManualHarness, SteerableHarness, bodies, gate, input, origin, policy, route, setup, until } from './helpers.js';

const turnsOf = (evs: ReturnType<ReturnType<typeof setup>['events']>) =>
  bodies(evs, 'turn.started').map((b) => (b as BodyOf<'turn.started'>).inputIds);

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
  it('runs a turn and wraps harness events into a gapless, conforming session stream', async () => {
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

  it('never merges inputs from two principals or two routes into one turn', async () => {
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

  it('re-queues admitted-but-unconsumed inputs once, then rejects them', async () => {
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

  it('marks a turn ambiguous when the harness consumed inputs it was not given', async () => {
    const h = new ManualHarness();
    const { lane, events } = setup({ harness: h });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('x', { id: 'x' }), mode: 'queue' });
    await until(() => h.session?.starts.length === 1);
    h.session!.complete(h.session!.starts[0]!.turnId, ['x', 'ghost']);
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(bodies(events(), 'turn.completed')[0]).toMatchObject({ status: 'ambiguous' });
  });

  it('closes the turn as ambiguous when the harness stream ends mid-turn', async () => {
    const h = new ManualHarness();
    const { lane, events } = setup({ harness: h });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('x', { id: 'x' }), mode: 'queue' });
    await until(() => h.session?.starts.length === 1);
    await h.session!.close();
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(bodies(events(), 'turn.completed')[0]).toMatchObject({ status: 'ambiguous', error: { code: 'harness_closed' } });
    expect(bodies(events(), 'input.rejected')[0]).toMatchObject({ inputIds: ['x'], reason: 'ambiguous' });
  });

  it('ignores a duplicate inputId', async () => {
    const { lane } = setup();
    const i = input('x');
    await lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' });
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' })).toEqual({ ok: true, disposition: 'duplicate' });
  });
});

describe('Lane: steer', () => {
  it('degrades to queue when the harness cannot steer', async () => {
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

  it('steers only the turn owner; others are queued; another route becomes an extra delivery', async () => {
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

  it('degrades a steer the harness refuses (stale / not_steerable / no_active_turn)', async () => {
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
});

describe('Lane: interrupt', () => {
  const blocking = () =>
    new FakeHarness(
      (t) =>
        new Promise((_, reject) => {
          t.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

  it('interrupts the active turn and optionally clears the queue', async () => {
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

  it('refuses interrupts from someone who is neither turn owner nor owner', async () => {
    const { lane, events } = setup({ harness: blocking() });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('a'), mode: 'queue' });
    await until(() => bodies(events(), 'turn.started').length === 1);
    expect(await lane.command({ type: 'interrupt', sessionKey: 's1', origin: origin(null) })).toEqual({ ok: false, reason: 'forbidden' });
    expect(await lane.command({ type: 'interrupt', sessionKey: 's1', origin: origin('x', ['guest']) })).toEqual({ ok: false, reason: 'forbidden' });
    expect(await lane.command({ type: 'interrupt', sessionKey: 's1', turnId: 'nope', origin: origin('fake:alice') })).toEqual({ ok: false, reason: 'stale_turn' });
    await lane.close();
  });

  it('interrupt-mode input stops the turn and runs next', async () => {
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

  it('auto: answers immediately per policy (bypass → allow)', async () => {
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

  it('auto deny for a restricted turn', async () => {
    const got: Decision[] = [];
    const { lane, events } = setup({ harness: asking(got) });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go', { principal: null }), mode: 'queue' });
    await until(() => bodies(events(), 'turn.completed').length === 1);
    expect(got[0]).toMatchObject({ kind: 'deny' });
  });

  it('human: re-checks eligibility server side; first resolve wins', async () => {
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

  it('human: times out to deny', async () => {
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

  it('host: only a system origin may resolve', async () => {
    const got: Decision[] = [];
    const { lane, events } = setup({ harness: asking(got), policy: policy({ resolve: async () => ({ kind: 'host' }) }) });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('go'), mode: 'queue' });
    await until(() => bodies(events(), 'request.opened').length === 1);
    const cmd = (o: ReturnType<typeof origin>) => lane.command({ type: 'resolve', sessionKey: 's1', requestId: 'r1', decision: { kind: 'allow_once' }, origin: o });
    expect(await cmd(origin('fake:alice'))).toEqual({ ok: false, reason: 'not_eligible' });
    expect(await cmd(origin('host', [], 'system'))).toEqual({ ok: true });
    await until(() => got.length === 1);
  });

  it('model: uses the reviewer; escalation re-opens for a human; no reviewer falls back to human', async () => {
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

  it('cancels open requests when the turn ends without answering them', async () => {
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

  it('detach leaves the running turn open in the log', async () => {
    const a = await firstHost();
    expect(bodies(a.events(), 'turn.completed')).toEqual([]);
    expect(a.hub.snapshot('s1').turn?.turnId).toBe(a.turnId);
  });

  it('a new lane adopts the turn (turn.adopted), keeps it as the active turn and queues behind it', async () => {
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

  it('settles a turn nobody adopted as ambiguous before the next turn starts', async () => {
    const a = await firstHost();
    const h2 = new ManualHarness();
    const lane2 = nextLane(a.hub, h2);
    await lane2.command({ type: 'input', sessionKey: 's1', input: input('next', { id: 'y' }), mode: 'queue' });
    await until(() => h2.session?.starts.length === 1);
    expect(bodies(a.events(), 'turn.completed')[0]).toMatchObject({ turnId: a.turnId, status: 'ambiguous', error: { code: 'host_restarted' } });
    expect(a.hub.snapshot('s1').turn?.turnId).toBe(h2.session!.starts[0]!.turnId);
  });
});

describe('Lane: named harness instances', () => {
  it('opens the adapter the turn names, attributes events to it, and switches generations when the plan changes it', async () => {
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
