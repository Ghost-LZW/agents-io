import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { Hub, MemorySessionLog, passes } from '../src/index.js';
import { draft } from './helpers.js';

describe('Hub', () => {
  it('knows which session a turn or request belongs to', () => {
    const hub = new Hub(new MemorySessionLog());
    hub.append('a', draft({ t: 'turn.started', turnId: 't1', inputIds: [], replyRoute: null }));
    hub.append('b', draft({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'x', risk: {}, allowedDecisions: [], allowAlways: false, defaultDeny: true }));
    hub.append('c', draft({ t: 'turn.adopted', turnId: 't2', nativeTurnId: 'n', inputIds: [] }));
    expect(hub.locate({ turnId: 't1' })).toBe('a');
    expect(hub.locate({ requestId: 'r1' })).toBe('b');
    expect(hub.locate({ turnId: 't2' })).toBe('c');
    expect(hub.locate({ turnId: 'nope' })).toBeUndefined();
  });

  it('keeps internal events out unless asked for', () => {
    const e = { ...draft({ t: 'headline', text: 'x' }), v: 1, sessionKey: 's', seq: 1, harness: 'h', generation: 1, visibility: 'internal' } as SessionEvent;
    expect(passes(e, 'full')).toBe(false);
    expect(passes(e, 'full', {}, ['internal'])).toBe(true);
  });
});
