import { describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import type { Binding, BodyOf, InputCause, InputRecord, LoopGuardTrip, Origin, SessionEvent } from '@agents-io/protocol';
import {
  Hub,
  IdentityError,
  IdentityMap,
  Ingress,
  Lane,
  LoopGuard,
  Router,
  SqliteSessionLog,
  WatchDispatcher,
  WatchRegistry,
  agentInput,
  causeFrom,
  defaultPolicy,
  ownersTable,
  type ProducingTurn,
  type SessionPolicy,
} from '../src/index.js';
import { RUN, SteerableHarness, input, policy, setup, until } from './helpers.js';

/*
 * Agent messaging foundation (docs/design/agent-messaging): agent inputs stamped by the
 * daemon, cause chains, the outbound index's recovered echoes, and the loop guard at the
 * lane's single input checkpoint.
 */

const ALICE: Origin = { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' };
const A_TURN: ProducingTurn = { from: { agent: 'writer', sessionKey: 'writer:main' }, turnId: 'turn_a', provenance: { external: false, watched: false, group: false, cause: { hop: 2, chain: 'in_root', rootPrincipal: 'fake:alice' } } };

/** An agent input from the writer agent's session at `hop`. */
function agentIn(hop: number | undefined, o: { id?: string; peer?: string; basis?: InputCause['basis']; carried?: InputCause['carried'] } = {}): InputRecord {
  const base = agentInput({ inputId: o.id ?? `ag_${Math.random().toString(36).slice(2)}`, turn: A_TURN, content: [{ type: 'text', text: 'ping' }], replyRoute: { channel: 'fake', account: 'default', conversationId: 'c1' } });
  const cause: InputCause = { ...base.cause!, ...(o.peer ? { peer: o.peer } : {}), ...(o.basis ? { basis: o.basis } : {}), ...(o.carried ? { carried: o.carried } : {}) };
  if (hop === undefined) delete cause.hop;
  else cause.hop = hop;
  return { ...base, cause };
}

const admitted = (evs: SessionEvent[]) => evs.filter((e) => e.body.t === 'input.admitted').map((e) => e.body as BodyOf<'input.admitted'>);
const notices = (evs: SessionEvent[]) => evs.filter((e) => e.body.t === 'notice' && e.body.code === 'loop_guard');

describe('agent inputs are stamped by the daemon', () => {
  it('agentInput: kind agent, principal agent:<agent>, evidence daemon, via = the sending session, one hop past its turn #ID-7 #EX-5', () => {
    const i = agentInput({ inputId: 'x1', turn: A_TURN, content: [{ type: 'text', text: 'hi' }], replyRoute: null });
    expect(i.origin).toEqual({ kind: 'agent', principal: { id: 'agent:writer', labels: ['agent'] }, evidence: 'daemon', via: 'agent:writer:writer:main', adapter: 'agent' });
    expect(i.cause).toEqual({ peer: 'writer/writer:main', basis: 'internal', hop: 3, chain: 'in_root', from: { sessionKey: 'writer:main', turnId: 'turn_a' }, rootPrincipal: 'fake:alice', carried: { external: false, watched: false, group: false } });
    // A turn a human started (no chain yet): hop 1, root principal unknown to the stamp unless the provenance says it.
    expect(causeFrom({ from: { agent: 'w', sessionKey: 'w:main' }, turnId: 't' }, 'recovered')).toMatchObject({ basis: 'recovered', hop: 1, rootPrincipal: null });
  });

  it('agent principals can never carry the owner label: a config map fails, a host table is refused #ID-7', () => {
    const owner = { channel: 'agent', channelUserId: 'writer', principal: 'xwo:writer', labels: ['owner'] };
    expect(() => new IdentityMap([[owner]])).toThrow(IdentityError);
    const router = new Router({ agents: [{ name: 'default', sessionPrefix: '' }], defaultAgent: 'default', config: { version: 'c', bindings: [], identities: [] } });
    expect(() => router.putHostTable({ version: 'h1', bindings: [], identities: [owner] })).toThrow(/agent principals can never be owners/);
    expect(() => new Router({ agents: [{ name: 'default', sessionPrefix: '' }], defaultAgent: 'default', config: { version: 'c', bindings: [], identities: [owner] } })).toThrow(/owner/);
    // Without the label a host may map an agent to its own member id.
    const m = new IdentityMap([[{ ...owner, labels: ['agent', 'reviewer'] }]]);
    expect(m.agentPrincipal('writer')).toEqual({ id: 'xwo:writer', labels: ['agent', 'reviewer'] });
    expect(m.agentPrincipal('other')).toEqual({ id: 'agent:other', labels: ['agent'] });
    router.close();
  });
});

/** Ingress over a Router (owners table, plus `extra` rules) with the outbound index stubbed by `sent`. */
function world(o: { sent?: Map<string, ProducingTurn>; agentAccounts?: string[]; extra?: Binding[]; policy?: Partial<SessionPolicy> } = {}) {
  const log = new SqliteSessionLog();
  const hub = new Hub(log);
  const policy: SessionPolicy = { ...defaultPolicy({ owners: ['fake:alice'], agentAccounts: o.agentAccounts ?? [], run: RUN }), ...o.policy };
  const lanes = new Map<string, Lane>();
  const turns: InputRecord[][] = [];
  const harness = new FakeHarness(async (t) => {
    turns.push(t.inputs);
  });
  const lane = (k: string) => {
    let l = lanes.get(k);
    if (!l) lanes.set(k, (l = new Lane({ sessionKey: k, harness, hub, policy, thinkingHeadline: null, loopGuard: { maxHops: 3, pair: { maxTurns: 2 } } })));
    return l;
  };
  const registry = new WatchRegistry({ db: log.db });
  const watches = new WatchDispatcher({ registry, policy, lanes: lane });
  watches.start();
  const config = ownersTable({ owners: ['fake:alice'], agent: 'default' });
  config.bindings.push(...(o.extra ?? []));
  const router = new Router({ agents: [{ name: 'default', sessionPrefix: '' }], defaultAgent: 'default', config, watches, db: log.db, ...(o.agentAccounts ? { agentAccounts: o.agentAccounts } : {}) });
  const ingress = new Ingress({ policy: { ...policy, identify: async (a) => router.identify(a) }, lanes: lane, router, watches, hub, recover: (ch, id) => o.sent?.get(`${ch}/${id}`) });
  const close = async () => {
    watches.stop();
    await Promise.all([...lanes.values()].map((l) => l.whenIdle()));
    log.close();
  };
  return { log, lanes, turns, router, ingress, watches, close, events: (k: string) => log.read(k, 0) };
}

/** A binding that lets any bot's message in a dm start a turn (the risky configuration loops need). */
const BOTS_DISPATCH = [{ id: 'bots', match: { conversationKind: 'dm' as const }, on: 'dispatch' as const, session: 'per-conversation' as const }];

describe('our own messages back through a channel (outbound index)', () => {
  it('a hit is self, from the agent that sent it, with a recovered cause one hop on — whatever account received it #ID-8 #ID-5', async () => {
    const sent = new Map([['fake/om_1', A_TURN]]);
    const w = world({ sent, extra: BOTS_DISPATCH });
    // A sibling bot (account b, not in selfAccounts) receives the message the writer's turn sent as om_1.
    const r = await w.ingress.accept(fakeEnvelope({ id: 'om_1', account: 'b', replyRoute: { channel: 'fake', account: 'b', conversationId: 'c1' }, sender: { channelUserId: 'bot_a', isBot: true, evidence: 'platform_signed' }, text: 'hello' }));
    expect(r.origin).toMatchObject({ kind: 'agent', principal: { id: 'agent:writer', labels: ['agent'] }, self: true, evidence: 'platform_signed' });
    expect(r.explanation!.cause).toEqual({ peer: 'writer/writer:main', basis: 'recovered', hop: 3, chain: 'in_root', from: { sessionKey: 'writer:main', turnId: 'turn_a' }, rootPrincipal: 'fake:alice', carried: { external: false, watched: false, group: false } });
    // Self never starts a turn, even under a rule that dispatches bots.
    expect(r.action).not.toBe('dispatch');
    expect(w.turns).toEqual([]);
    await w.close();
  });

  it('a hit without platform evidence is not ours (a forged copy of a mail Message-ID); a miss from a bot is a broken chain #ID-8 #ID-7', async () => {
    const sent = new Map([['fake/om_1', A_TURN]]);
    const w = world({ sent });
    const forged = await w.ingress.accept(fakeEnvelope({ id: 'om_1', sender: { channelUserId: 'bot_a', isBot: true, evidence: 'none' }, conversation: { id: 'g', kind: 'group' }, text: 'x' }));
    expect(forged.origin).toMatchObject({ kind: 'agent', principal: null });
    expect(forged.origin!.self).toBeUndefined();
    expect(forged.explanation!.cause).toEqual({ peer: 'fake:bot_a', basis: 'none' });
    await w.close();
  });

  it('clients and adapters cannot set a cause: a declared hop counts only from a trusted agent account with platform evidence; channelContext.loopGuard is stripped #ID-7', async () => {
    const w = world({ agentAccounts: ['fake:peerbot'] });
    const env = (sender: string, evidence: 'platform_signed' | 'none') =>
      fakeEnvelope({ sender: { channelUserId: sender, isBot: true, evidence, cause: { hop: 5, chain: 'theirs' } }, conversation: { id: 'g', kind: 'group' }, context: { loopGuard: 'hops' }, text: 'x' });
    const trusted = await w.ingress.accept(env('peerbot', 'platform_signed'));
    expect(trusted.explanation!.cause).toEqual({ peer: 'fake:peerbot', basis: 'declared', hop: 5, chain: 'theirs' });
    expect((await w.ingress.accept(env('peerbot', 'none'))).explanation!.cause).toEqual({ peer: 'fake:peerbot', basis: 'none' });
    expect((await w.ingress.accept(env('randombot', 'platform_signed'))).explanation!.cause).toEqual({ peer: 'fake:randombot', basis: 'none' });
    const observed = admitted(w.events('fake:default:g'))[0]!.input!;
    expect(observed.channelContext.loopGuard).toBeUndefined();
    // A source that may not declare senders loses the claim before identity sees it.
    const capped = await w.ingress.accept(env('peerbot', 'platform_signed'), { channel: 'fake', account: 'default', evidence: ['platform_signed'], declaresSender: false });
    expect(capped.envelope!.sender.cause).toBeUndefined();
    expect(capped.explanation!.cause).toMatchObject({ basis: 'none' });
    // A human's input has no cause at all.
    expect((await w.ingress.accept(fakeEnvelope({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' }))).explanation!.cause).toBeUndefined();
    await w.close();
  });
});

describe('cause chains', () => {
  it("a turn's chain is its highest-hop triggering input; context does not count; relayed flags are carried (never laundered) #EX-5", async () => {
    const { lane, events } = setup({ harness: new SteerableHarness(async (t) => void (await new Promise((r) => t.signal.addEventListener('abort', r, { once: true })))) , loopGuard: false });
    await lane.observe(agentIn(7, { id: 'ctx7' }));
    await lane.command({ type: 'input', sessionKey: 's1', input: agentIn(2, { id: 'a2', carried: { external: true, watched: false, group: true } }), mode: 'queue' });
    await until(() => events().some((e) => e.body.t === 'turn.started'));
    const t1 = lane.activeTurn()!.turnId;
    expect(lane.provenance(t1)).toMatchObject({ external: true, group: true, cause: { hop: 2, chain: 'in_root', rootPrincipal: 'fake:alice' } });
    // A steer with a higher hop raises the running turn's chain.
    await lane.command({ type: 'input', sessionKey: 's1', input: agentIn(4, { id: 'a4' }), mode: 'steer' });
    expect(lane.provenance(t1)!.cause).toMatchObject({ hop: 4 });
    // The input record (with its cause) is in the log.
    expect(admitted(events()).find((a) => a.inputId === 'a2')!.input!.cause).toMatchObject({ hop: 2 });
    await lane.close();
  });

  it('a human input is the root of its own chain (hop 0, chain = its input id) #EX-5', async () => {
    const { lane, events } = setup();
    const i = input('hi', { id: 'h1' });
    await lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' });
    await until(() => events().some((e) => e.body.t === 'turn.completed'));
    const turnId = (events().find((e) => e.body.t === 'turn.started')!.body as { turnId: string }).turnId;
    expect(lane.provenance(turnId)!.cause).toEqual({ hop: 0, chain: 'h1', rootPrincipal: 'fake:alice' });
  });

  it('watch forwarding keeps the cause unchanged (no extra hop) #EX-5', async () => {
    const w = world({ agentAccounts: ['fake:peerbot'] });
    await w.watches.add(ALICE, { id: 'wg', source: { channel: 'fake', conversation: 'g9' }, target: { sessionKey: 'watcher' }, mode: 'context' });
    await w.ingress.accept(fakeEnvelope({ id: 'om_9', sender: { channelUserId: 'peerbot', isBot: true, evidence: 'platform_signed', cause: { hop: 2, chain: 'c9' } }, conversation: { id: 'g9', kind: 'group' }, text: 'x' }));
    await until(() => admitted(w.events('watcher')).length > 0);
    expect(admitted(w.events('watcher'))[0]!.input!.cause).toEqual({ peer: 'fake:peerbot', basis: 'declared', hop: 2, chain: 'c9' });
    await w.close();
  });
});

describe('loop guard at the lane', () => {
  it('hop = maxHops starts a turn; maxHops + 1 is kept as context labelled loopGuard, with a loop_guard notice, never a turn #IN-8', async () => {
    const trips: LoopGuardTrip[] = [];
    const { lane, events } = setup({ loopGuard: { maxHops: 3 }, onLoopGuard: (a) => trips.push(a.trip) });
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: agentIn(3, { id: 'h3' }), mode: 'queue' })).toMatchObject({ ok: true, disposition: 'new_turn' });
    await until(() => events().some((e) => e.body.t === 'turn.completed'));
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: agentIn(4, { id: 'h4' }), mode: 'queue' })).toEqual({ ok: true, disposition: 'observe_only' });
    const a = admitted(events()).find((x) => x.inputId === 'h4')!;
    expect(a).toMatchObject({ disposition: 'observe_only', input: { channelContext: { loopGuard: 'hops' }, cause: { hop: 4 } } });
    const [n] = notices(events());
    expect(n).toMatchObject({ visibility: 'operators' });
    expect((n!.body as { message: string }).message).toMatch(/hop 4 .* limit of 3/);
    expect(trips).toEqual([{ tripped: 'hops', hop: 4, limit: 3, sessionKey: 's1' }]);
    expect(events().filter((e) => e.body.t === 'turn.started')).toHaveLength(1);
    // Steer and interrupt go through the same checkpoint.
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: agentIn(9, { id: 'h9s' }), mode: 'steer' })).toMatchObject({ disposition: 'observe_only' });
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: agentIn(9, { id: 'h9i' }), mode: 'interrupt' })).toMatchObject({ disposition: 'observe_only' });
  });

  it('the stopped input is handed to the next turn a person starts, still labelled #IN-8 #IN-6', async () => {
    const seen: InputRecord[][] = [];
    const { lane, events } = setup({ harness: new FakeHarness(async (t) => void seen.push(t.inputs)), loopGuard: { maxHops: 1 } });
    await lane.command({ type: 'input', sessionKey: 's1', input: agentIn(2, { id: 'late' }), mode: 'queue' });
    await lane.command({ type: 'input', sessionKey: 's1', input: input('what did it say?', { id: 'human' }), mode: 'queue' });
    await until(() => events().some((e) => e.body.t === 'turn.completed'));
    expect(seen[0]!.map((i) => [i.inputId, i.channelContext.loopGuard, i.channelContext.context])).toEqual([
      ['late', 'hops', true],
      ['human', undefined, undefined],
    ]);
  });

  it('same pair: the peer is stopped after maxTurns; a person writing clears it; another peer is not affected; broken chains count too #IN-8', async () => {
    const { lane, events } = setup({ loopGuard: { pair: { maxTurns: 2 } } });
    const send = async (i: InputRecord) => (await lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' })) as { disposition?: string };
    const settle = () => lane.whenIdle();
    expect((await send(agentIn(1))).disposition).not.toBe('observe_only');
    await settle();
    expect((await send(agentIn(1))).disposition).not.toBe('observe_only');
    await settle();
    expect((await send(agentIn(1, { id: 'third' }))).disposition).toBe('observe_only');
    expect((notices(events()).at(-1)!.body as { message: string }).message).toMatch(/agent:writer already started 2 turns/);
    // Another agent (another session of another agent) is counted apart.
    expect((await send(agentIn(1, { peer: 'reviewer/reviewer:main' }))).disposition).not.toBe('observe_only');
    await settle();
    // A person writes: the count starts over.
    await send(input('carry on'));
    await settle();
    expect((await send(agentIn(1))).disposition).not.toBe('observe_only');
    await settle();
    // An outside agent with no hop (basis none) is limited by the pair count alone.
    const outside = () => agentIn(undefined, { peer: 'lark-bot:ou_bot', basis: 'none' });
    expect((await send(outside())).disposition).not.toBe('observe_only');
    await settle();
    expect((await send(outside())).disposition).not.toBe('observe_only');
    await settle();
    expect((await send(outside())).disposition).toBe('observe_only');
  });

  it('the pair window passes: the peer may start turns again #IN-8', () => {
    let now = 1_000;
    const g = new LoopGuard({ pair: { maxTurns: 1, windowMs: 60_000 } }, () => now);
    const i = agentIn(1);
    expect(g.check(i)).toBeUndefined();
    expect(g.check(i)).toMatchObject({ tripped: 'pair', count: 1, limit: 1, windowMs: 60_000 });
    now += 30_000;
    expect(g.check(i)).toMatchObject({ tripped: 'pair' });
    now += 31_000;
    expect(g.check(i)).toBeUndefined();
    // Human input clears.
    expect(g.check(i)).toMatchObject({ tripped: 'pair' });
    expect(g.check(input('hi'))).toBeUndefined();
    expect(g.check(i)).toBeUndefined();
  });

  it('every entry reaches the checkpoint: a channel dispatch and a watch trigger are stopped alike #IN-8', async () => {
    const w = world({ agentAccounts: ['fake:peerbot'], extra: BOTS_DISPATCH });
    const claim = (id: string) => fakeEnvelope({ id, sender: { channelUserId: 'peerbot', isBot: true, evidence: 'platform_signed', cause: { hop: 4 } }, text: 'again' });
    // Channel dispatch, hop 4 over maxHops 3: context, no turn.
    const r = await w.ingress.accept(claim('d1'));
    expect(r.result).toEqual({ ok: true, disposition: 'observe_only' });
    // A watch trigger carrying the same claim: stopped in the watching session too.
    await w.watches.add(ALICE, { id: 'wt', source: { channel: 'fake', conversation: 'g2' }, target: { sessionKey: 'watcher' }, mode: 'trigger' });
    await w.ingress.accept(fakeEnvelope({ id: 'd2', sender: { channelUserId: 'peerbot', isBot: true, evidence: 'platform_signed', cause: { hop: 4 } }, conversation: { id: 'g2', kind: 'group' }, text: 'x' }));
    await until(() => admitted(w.events('watcher')).length > 0);
    expect(admitted(w.events('watcher'))[0]).toMatchObject({ disposition: 'observe_only', input: { channelContext: { loopGuard: 'hops' } } });
    expect(w.turns).toEqual([]);
    await w.close();
  });
});

describe('Policy.contact', () => {
  it('denies by default; policy.agentContacts allows by agent name or *, per op #CF-9', async () => {
    const a = { from: { agent: 'writer', sessionKey: 'writer:main' }, to: { agent: 'reviewer' }, op: 'send' as const, turn: null };
    expect(await policy().contact!(a)).toBe('deny');
    const p = defaultPolicy({ owners: [], agentContacts: [{ from: 'writer', to: '*', ops: ['list', 'send'] }] });
    expect(await p.contact(a)).toBe('allow');
    expect(await p.contact({ ...a, op: 'control' })).toBe('deny');
    expect(await p.contact({ ...a, from: { agent: 'other', sessionKey: 'other:main' } })).toBe('deny');
  });
});
