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

// Moved from policy.test.ts: feature-path tests with no promise in docs/INVARIANTS.md (decision 14: local tier).

describe('question-policy', () => {
  const ctx = (profile: string, extra: Partial<TurnContext> = {}): TurnContext => ({
    sessionKey: 's',
    turnId: 't',
    run: { harness: 'fake', model: 'm', profile },
    inputs: [],
    replyRoute: route(),
    ...extra,
  });

  it('routes native questions to the person who owns the turn, never auto-approves them', async () => {
    const req = { t: 'request.opened' as const, requestId: 'q', kind: 'question' as const, title: 'Which DB?', risk: {}, allowedDecisions: ['answer', 'deny'], allowAlways: false, defaultDeny: false };
    expect(await p.resolve(req, ctx('bypass', { owner: 'fake:alice' }))).toEqual({ kind: 'human', principals: ['fake:alice'], routes: ['fake:default:c1'] });
    expect(await p.resolve(req, ctx('restricted', { owner: 'fake:bob' }))).toEqual({ kind: 'human', principals: ['fake:bob'], routes: ['fake:default:c1'] });
    expect(await p.resolve(req, ctx('bypass', { replyRoute: null }))).toMatchObject({ kind: 'auto', decision: { kind: 'deny' } });
  });
});
