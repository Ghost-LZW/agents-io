import { describe, expect, it } from 'vitest';
import { fakeEnvelope } from '@agents-io/testkit';
import type { TurnContext } from '@agents-io/protocol';
import { defaultPolicy } from '../src/index.js';
import { input, origin, route } from './helpers.js';

const p = defaultPolicy({
  owners: ['fake:alice'],
  selfAccounts: ['fake:mybot'],
  agentAccounts: ['fake:peerbot'],
  isSelfDeclared: (d) => d.startsWith('runner:me/'),
  run: { harness: 'fake', model: 'm' },
  routes: ['mail:default:me@example.com'],
});
const id = (channelUserId: string, extra: { declared?: string; isBot?: boolean } = {}) =>
  p.identify({ channel: 'fake', account: 'default', channelUserId, evidence: 'platform_signed', ...extra });

describe('defaultPolicy.identify', () => {
  it('only knows configured owners', async () => {
    expect(await id('alice')).toEqual({ kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] } });
    expect(await id('mallory')).toEqual({ kind: 'human', principal: null });
    expect(await id('somebot', { isBot: true })).toEqual({ kind: 'agent', principal: null });
  });

  it('accepts declared identity only from trusted agent accounts', async () => {
    // A declaration from an untrusted account is ignored, even if it names an owner.
    expect(await id('mallory', { declared: 'fake:alice' })).toEqual({ kind: 'human', principal: null });
    expect(await id('alice', { declared: 'runner:x' })).toEqual({ kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] } });
    expect(await id('peerbot', { declared: 'runner:other/run:1' })).toEqual({
      kind: 'agent',
      principal: { id: 'runner:other/run:1', labels: ['agent'] },
      declared: 'runner:other/run:1',
    });
    expect(await id('peerbot')).toEqual({ kind: 'agent', principal: null });
  });

  it('marks this deployment’s own echoes as self', async () => {
    expect(await id('mybot', { declared: 'runner:me/run:1' })).toMatchObject({ kind: 'agent', self: true });
    expect(await id('peerbot', { declared: 'runner:me/run:2' })).toMatchObject({ self: true });
  });
});

describe('defaultPolicy.admit', () => {
  const dm = { id: 'c1', kind: 'dm' as const };
  const group = { id: 'g1', kind: 'group' as const };
  it('dispatches owner DMs, observes unknown senders in groups, drops them in DMs, drops self echoes', async () => {
    const owner = origin('fake:alice');
    const unknown = origin(null);
    expect(await p.admit(fakeEnvelope({ conversation: dm }), owner)).toEqual({ action: 'dispatch', sessionKey: 'fake:default:c1', mode: 'queue' });
    expect(await p.admit(fakeEnvelope({ conversation: group, modeHint: 'steer' }), owner)).toEqual({ action: 'dispatch', sessionKey: 'fake:default:g1', mode: 'steer' });
    expect(await p.admit(fakeEnvelope({ conversation: group }), unknown)).toEqual({ action: 'observe', sessionKey: 'fake:default:g1' });
    expect(await p.admit(fakeEnvelope({ conversation: dm }), unknown)).toEqual({ action: 'drop' });
    expect(await p.admit(fakeEnvelope({ conversation: group }), { ...owner, self: true })).toEqual({ action: 'drop' });
  });

  it('can merge owner DMs into one session', async () => {
    const q = defaultPolicy({ owners: ['fake:alice'], ownerSessionKey: 'main' });
    expect(await q.admit(fakeEnvelope({ conversation: dm }), origin('fake:alice'))).toMatchObject({ sessionKey: 'main' });
  });
});

describe('defaultPolicy.plan / resolve / outbound', () => {
  const ctx = (profile: string, extra: Partial<TurnContext> = {}): TurnContext => ({
    sessionKey: 's',
    turnId: 't',
    run: { harness: 'fake', model: 'm', profile },
    inputs: [],
    replyRoute: route(),
    ...extra,
  });

  it('bypass only when every input is from an owner', async () => {
    expect(await p.plan({ sessionKey: 's', inputs: [input('a', { principal: 'fake:alice' })] })).toEqual({ harness: 'fake', model: 'm', profile: 'bypass' });
    const mixed = [input('a', { principal: 'fake:alice' }), input('b', { principal: null })];
    expect((await p.plan({ sessionKey: 's', inputs: mixed })).profile).toBe('restricted');
  });

  it('auto allows for bypass, auto denies for restricted', async () => {
    const r = { t: 'request.opened' as const, requestId: 'r', kind: 'tool_approval' as const, title: 'x', risk: {}, allowedDecisions: [], allowAlways: false, defaultDeny: false };
    expect(await p.resolve(r, ctx('bypass'))).toEqual({ kind: 'auto', decision: { kind: 'allow_once' } });
    expect(await p.resolve(r, ctx('restricted'))).toMatchObject({ kind: 'auto', decision: { kind: 'deny' } });
  });

  it('allows outbound only to the turn’s routes and preregistered ones', async () => {
    const steered = input('w', { route: route('web', 'web') });
    expect(await p.outbound({ from: ctx('bypass', { inputs: [steered] }), to: route() })).toBe('allow');
    expect(await p.outbound({ from: ctx('bypass', { inputs: [steered] }), to: route('web', 'web') })).toBe('allow');
    expect(await p.outbound({ from: ctx('bypass'), to: route('elsewhere') })).toBe('deny');
    expect(await p.outbound({ from: null, to: { channel: 'mail', account: 'default', conversationId: 'me@example.com' } })).toBe('allow');
    expect(await p.outbound({ from: null, to: route() })).toBe('deny');
  });

  it('control: owners and turn owners may interrupt', async () => {
    expect(await p.control({ sessionKey: 's', op: 'interrupt', origin: origin('fake:alice'), turn: turnOwnedBy('x') })).toBe('allow');
    expect(await p.control({ sessionKey: 's', op: 'interrupt', origin: origin('x', ['agent']), turn: turnOwnedBy('x') })).toBe('allow');
    expect(await p.control({ sessionKey: 's', op: 'interrupt', origin: origin('y', []), turn: turnOwnedBy('x') })).toBe('deny');
    expect(await p.control({ sessionKey: 's', op: 'interrupt', origin: origin(null), })).toBe('deny');
  });
});

function turnOwnedBy(owner: string) {
  return { sessionKey: 's', turnId: 't', run: { harness: 'fake', model: 'm', profile: 'p' }, inputs: [], replyRoute: null, owner, deliveries: [] };
}

describe('defaultPolicy.watch', () => {
  const w = (source: Record<string, unknown>) => ({ id: 'w', source, target: { sessionKey: 'main' }, mode: 'digest', createdBy: 'x', createdAt: 0 }) as any;
  const origin = (kind: string, id: string | null, labels: string[] = []) =>
    ({ kind, principal: id ? { id, labels } : null, evidence: 'platform_signed', via: 'v', adapter: 'a' }) as any;
  const p = defaultPolicy({ owners: ['fake:alice'], watchAllowlist: [{ channel: 'mail' }, { channel: 'lark-bot', conversation: 'oc_team' }] });

  it('owners may watch anything; agents only allowlisted sources; others never', async () => {
    expect(await p.watch!({ watch: w({ channel: 'lark-bot', conversation: 'oc_secret' }), by: origin('human', 'fake:alice', ['owner']) })).toBe('allow');
    expect(await p.watch!({ watch: w({ channel: 'mail', conversationKind: 'mail' }), by: origin('agent', 'runner:x') })).toBe('allow');
    expect(await p.watch!({ watch: w({ channel: 'lark-bot', conversation: 'oc_team' }), by: origin('agent', 'runner:x') })).toBe('allow');
    expect(await p.watch!({ watch: w({ channel: 'lark-bot', conversation: 'oc_secret' }), by: origin('agent', 'runner:x') })).toBe('deny');
    expect(await p.watch!({ watch: w({ channel: 'mail' }), by: origin('human', 'fake:eve') })).toBe('deny');
  });

  it('triage keeps the watch mode by default', async () => {
    expect(await p.triage!({ watch: { ...w({ channel: 'mail' }), mode: 'trigger' }, input: {} as any })).toBe('trigger');
    expect(await p.triage!({ watch: w({ channel: 'mail' }), input: {} as any })).toBe('context');
  });
});
