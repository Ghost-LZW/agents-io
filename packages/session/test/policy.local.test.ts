import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../src/index.js';

describe('defaultPolicy.watch', () => {
  const w = (source: Record<string, unknown>) => ({ id: 'w', source, target: { sessionKey: 'main' }, mode: 'digest', createdBy: 'x', createdAt: 0 }) as any;
  const p = defaultPolicy({ owners: ['fake:alice'], watchAllowlist: [{ channel: 'mail' }, { channel: 'lark-bot', conversation: 'oc_team' }] });

  it('triage keeps the watch mode by default', async () => {
    expect(await p.triage!({ watch: { ...w({ channel: 'mail' }), mode: 'trigger' }, input: {} as any })).toBe('trigger');
    expect(await p.triage!({ watch: w({ channel: 'mail' }), input: {} as any })).toBe('context');
  });
});
