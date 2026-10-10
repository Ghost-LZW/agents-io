import { describe, expect, it } from 'vitest';
import { fakeEnvelope } from '@agents-io/testkit';
import type { Binding, BindingTable, InboundEnvelope, InputRecord, Origin } from '@agents-io/protocol';
import { Router, ownersTable, type AgentSpec, type RouterOptions } from '../src/index.js';

const AGENTS: AgentSpec[] = [{ name: 'assistant' }, { name: 'ops', sessionPrefix: 'ops/', mainSession: 'ops-home' }, { name: 'executor', mode: 'task' }];
const OWNER: Origin = { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' };
const UNKNOWN: Origin = { ...OWNER, principal: null };
const group = { id: 'g1', kind: 'group' as const };

const table = (bindings: Binding[], extra: Partial<BindingTable> = {}): BindingTable => ({ version: 'v1', bindings, identities: [], ...extra });
const router = (o: Partial<RouterOptions> = {}) => new Router({ agents: AGENTS, defaultAgent: 'assistant', ...o });
const inputOf = (env: InboundEnvelope, origin: Origin, id = 'in1'): InputRecord => ({ inputId: id, origin, content: env.content, replyRoute: env.replyRoute, channelContext: {} });
const route = (r: Router, env: InboundEnvelope, origin: Origin = OWNER, id?: string) => r.route(env, origin, inputOf(env, origin, id));

describe('session launch in callout answers (decision 7)', () => {
  it('skipWhenPinned is only for rules whose own on targets a session', () => {
    expect(() => router({ config: table([{ id: 'x', match: {}, on: 'host', callout: { skipWhenPinned: true } }]) })).toThrow(/skipWhenPinned/);
  });
});

describe('the default table (formerly defaultPolicy.admit)', () => {
  const agents: AgentSpec[] = [{ name: 'default', sessionPrefix: '' }];
  const dm = { id: 'c1', kind: 'dm' as const };
  const owner: Origin = { ...OWNER };

  it('can merge owner DMs into one session (ownerSessionKey)', async () => {
    const q = new Router({ agents, defaultAgent: 'default', config: ownersTable({ owners: ['fake:alice'], agent: 'default', ownerSessionKey: 'main' }) });
    expect(await route(q, fakeEnvelope({ conversation: dm }), owner).then((d) => d.deliveries.map((x) => x.sessionKey))).toEqual(['main']);
    // Only DMs: the owner in a group stays in the group's session.
    expect(await route(q, fakeEnvelope({ conversation: group }), owner).then((d) => d.deliveries.map((x) => x.sessionKey))).toEqual(['fake:default:g1']);
  });

  it('legacy Policy.admit is honoured only while no table is configured', async () => {
    const legacyAdmit = async () => ({ action: 'dispatch' as const, sessionKey: 'legacy-session', mode: 'steer' as const });
    const legacy = new Router({ agents, legacyAdmit });
    const d = await route(legacy, fakeEnvelope({ conversation: dm }), UNKNOWN);
    expect(d.deliveries).toEqual([expect.objectContaining({ bindingId: 'legacy:admit', on: 'dispatch', sessionKey: 'legacy-session', mode: 'steer' })]);
    const withTable = new Router({ agents, defaultAgent: 'default', legacyAdmit, config: ownersTable({ owners: [], agent: 'default' }) });
    expect((await route(withTable, fakeEnvelope({ conversation: dm }), UNKNOWN)).deliveries).toEqual([]);
  });
});
