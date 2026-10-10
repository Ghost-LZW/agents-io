import { describe, expect, it } from 'vitest';
import { Command, PROTOCOL_VERSION, check } from '@agents-io/protocol';
import { ClientCommand, ServerFrame, parseClientFrame } from '../src/frames.js';

const origin = { kind: 'human', principal: null, evidence: 'none', via: 'x', adapter: 'x' } as const;

describe('client frames', () => {
  it('accepts commands without origin #ID-3', () => {
    const f = { v: 1, type: 'command', id: '1', command: { type: 'input', sessionKey: 's', mode: 'queue', input: { content: [{ type: 'text', text: 'hi' }] } } };
    expect(parseClientFrame(f)).toEqual({ ok: true, frame: f });
    expect(parseClientFrame({ v: 1, type: 'sessions', id: '2' }).ok).toBe(true);
    expect(parseClientFrame({ v: 1, type: 'command', id: '3', command: { type: 'subscribe', sessionKey: 's', tier: 'card', fromSeq: 4 } }).ok).toBe(true);
    expect(parseClientFrame({ v: 1, type: 'command', id: '4', command: { type: 'resolve', sessionKey: 's', requestId: 'r', decision: { kind: 'allow_once' } } }).ok).toBe(true);
  });

  it('every protocol Command is also a ClientCommand (origin is ignored) #ID-3', () => {
    const cmds = [
      { type: 'interrupt', sessionKey: 's', origin },
      { type: 'resolve', sessionKey: 's', requestId: 'r', decision: { kind: 'deny' }, origin },
      { type: 'input', sessionKey: 's', mode: 'steer', input: { inputId: 'i', origin, content: [], replyRoute: null, channelContext: {} } },
      { type: 'unsubscribe', sessionKey: 's' },
    ];
    for (const c of cmds) {
      expect(check(Command, c)).toBe(true);
      expect(check(ClientCommand, c)).toBe(true);
    }
  });

  it('reports invalid frames with their id when there is one #PR-1', () => {
    const bad = parseClientFrame({ v: 1, type: 'command', id: '9', command: { type: 'input', sessionKey: 's', mode: 'shout', input: { content: [] } } });
    expect(bad).toMatchObject({ ok: false, id: '9' });
    expect(parseClientFrame({ type: 'what' })).toMatchObject({ ok: false });
    expect((parseClientFrame({ type: 'what' }) as { id?: string }).id).toBeUndefined();
    expect(parseClientFrame({ v: 2, type: 'sessions', id: '1' }).ok).toBe(false);
  });

  it('server frames validate #PR-1', () => {
    expect(check(ServerFrame, { v: PROTOCOL_VERSION, type: 'result', id: '1', ok: false, error: { code: 'forbidden', message: 'forbidden' } })).toBe(true);
    expect(check(ServerFrame, { v: PROTOCOL_VERSION, type: 'closed', sessionKey: 's', reason: 'bye' })).toBe(true);
    expect(check(ServerFrame, { v: PROTOCOL_VERSION, type: 'event', event: { nope: 1 } })).toBe(false);
  });
});
