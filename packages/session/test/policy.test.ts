import { describe, expect, it } from 'vitest';
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
  it('only knows configured owners #ID-4', async () => {
    expect(await id('alice')).toEqual({ kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] } });
    expect(await id('mallory')).toEqual({ kind: 'human', principal: null });
    expect(await id('somebot', { isBot: true })).toEqual({ kind: 'agent', principal: null });
  });

  it('accepts declared identity only from trusted agent accounts #ID-4', async () => {
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

  it('never accepts a declared identity that names an owner, even from a trusted agent account #ID-4 #CT-1', async () => {
    const r = await id('peerbot', { declared: 'fake:alice' });
    expect(r.principal).toBeNull();
    expect(r.kind).toBe('agent');
    // So it can neither act as the owner's turn nor pass Policy.control as them.
    const o = { kind: r.kind, principal: r.principal, evidence: 'platform_signed' as const, via: 'fake:default:c1', adapter: 'fake' };
    expect(await p.control({ sessionKey: 's', op: 'interrupt', origin: o, turn: { owner: 'fake:alice' } as TurnContext })).toBe('deny');
  });

  it('marks this deployment’s own echoes as self #ID-5', async () => {
    expect(await id('mybot', { declared: 'runner:me/run:1' })).toMatchObject({ kind: 'agent', self: true });
    expect(await id('peerbot', { declared: 'runner:me/run:2' })).toMatchObject({ self: true });
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

  it('bypass only when every input is from an owner #ID-6', async () => {
    expect(await p.plan({ sessionKey: 's', inputs: [input('a', { principal: 'fake:alice' })] })).toEqual({ harness: 'fake', model: 'm', profile: 'bypass' });
    const mixed = [input('a', { principal: 'fake:alice' }), input('b', { principal: null })];
    expect((await p.plan({ sessionKey: 's', inputs: mixed })).profile).toBe('restricted');
  });

  it('allows outbound to the turn’s routes and preregistered ones; a bypass (owner) turn anywhere #DL-5', async () => {
    const steered = input('w', { route: route('web', 'web') });
    expect(await p.outbound({ from: ctx('restricted', { inputs: [steered] }), to: route() })).toBe('allow');
    expect(await p.outbound({ from: ctx('restricted', { inputs: [steered] }), to: route('web', 'web') })).toBe('allow');
    expect(await p.outbound({ from: ctx('restricted'), to: route('elsewhere') })).toBe('deny');
    expect(await p.outbound({ from: ctx('bypass'), to: route('elsewhere') })).toBe('allow');
    expect(await p.outbound({ from: null, to: { channel: 'mail', account: 'default', conversationId: 'me@example.com' } })).toBe('allow');
    expect(await p.outbound({ from: null, to: route() })).toBe('deny');
  });

  it('control: owners and turn owners may interrupt #CT-1', async () => {
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

  it('owners may watch anything; agents only allowlisted sources; others never #CF-7', async () => {
    expect(await p.watch!({ watch: w({ channel: 'lark-bot', conversation: 'oc_secret' }), by: origin('human', 'fake:alice', ['owner']) })).toBe('allow');
    expect(await p.watch!({ watch: w({ channel: 'mail', conversationKind: 'mail' }), by: origin('agent', 'runner:x') })).toBe('allow');
    expect(await p.watch!({ watch: w({ channel: 'lark-bot', conversation: 'oc_team' }), by: origin('agent', 'runner:x') })).toBe('allow');
    expect(await p.watch!({ watch: w({ channel: 'lark-bot', conversation: 'oc_secret' }), by: origin('agent', 'runner:x') })).toBe('deny');
    expect(await p.watch!({ watch: w({ channel: 'mail' }), by: origin('human', 'fake:eve') })).toBe('deny');
  });
});

describe('defaultPolicy owner evidence', () => {
  const p = defaultPolicy({ owners: ['mail:i@example.com'] });
  const args = (evidence: any) => ({ channel: 'mail', account: 'a', channelUserId: 'i@example.com', evidence });

  it('an owner address without evidence is a stranger (forged From) #ID-4', async () => {
    expect((await p.identify!(args('none'))).principal).toBeNull();
  });

  it('a DKIM-verified or platform-signed owner is the owner #ID-4', async () => {
    expect((await p.identify!(args('dkim_pass'))).principal).toMatchObject({ id: 'mail:i@example.com', labels: ['owner'] });
    expect((await p.identify!(args('platform_signed'))).principal).toMatchObject({ id: 'mail:i@example.com' });
  });

  it('ownerEvidence can widen the accepted evidence #ID-4', async () => {
    const q = defaultPolicy({ owners: ['mail:i@example.com'], ownerEvidence: ['dkim_pass', 'none'] });
    expect((await q.identify!(args('none'))).principal).toMatchObject({ id: 'mail:i@example.com' });
  });
});
