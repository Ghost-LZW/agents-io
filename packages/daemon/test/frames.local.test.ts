import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { ATTACH_HELP, parseAttachLine } from '../src/attach.js';
import { EventRenderer } from '../src/render.js';

describe('attach command parsing', () => {
  it.each([
    ['', { kind: 'none' }],
    ['  hello there ', { kind: 'input', text: 'hello there' }],
    ['//etc/hosts is a path', { kind: 'input', text: '/etc/hosts is a path' }],
    ['/steer also do X', { kind: 'steer', text: 'also do X' }],
    ['/steer', { kind: 'error', message: 'usage: /steer <text>' }],
    ['/interrupt', { kind: 'interrupt', cancelQueue: false }],
    ['/interrupt --clear', { kind: 'interrupt', cancelQueue: true }],
    ['/interrupt now', { kind: 'error', message: 'usage: /interrupt [--clear]' }],
    ['/approve r1', { kind: 'approve', requestId: 'r1', always: false }],
    ['/approve r1 always', { kind: 'approve', requestId: 'r1', always: true }],
    ['/approve', { kind: 'error', message: 'usage: /approve <requestId> [always]' }],
    ['/deny r2 too risky', { kind: 'deny', requestId: 'r2', message: 'too risky' }],
    ['/deny r2', { kind: 'deny', requestId: 'r2' }],
    ['/sessions', { kind: 'sessions' }],
    ['/help', { kind: 'help' }],
    ['/quit', { kind: 'quit' }],
    ['/frobnicate', { kind: 'error', message: 'unknown command /frobnicate (try /help)' }],
  ])('%j', (line, want) => {
    expect(parseAttachLine(line)).toEqual(want);
  });

  it('help mentions every command', () => {
    for (const c of ['/steer', '/interrupt', '/approve', '/deny', '/sessions', '/quit']) expect(ATTACH_HELP).toContain(c);
  });
});

describe('EventRenderer', () => {
  const ev = (body: SessionEvent['body'], extra: Partial<SessionEvent> = {}): SessionEvent => ({
    v: 1, sessionKey: 's', seq: 1, harness: 'h', generation: 1, visibility: 'participants', ts: 0, level: 'primary', audience: 'status', durability: 'durable', body, ...extra,
  });

  it('streams deltas inline, then closes the line for structure', () => {
    const r = new EventRenderer();
    const out = [
      ev({ t: 'turn.started', turnId: 't1', inputIds: ['i'], replyRoute: null, owner: 'me', run: { harness: 'h', model: 'm', profile: 'bypass' } }),
      ev({ t: 'text.delta', delta: 'Hel', stream: 'answer' }, { turnId: 't1', durability: 'ephemeral' }),
      ev({ t: 'text.delta', delta: 'lo', stream: 'answer' }, { turnId: 't1', durability: 'ephemeral' }),
      ev({ t: 'item.started', item: { itemId: 'x', type: 'command', title: 'ls -la', status: 'running' } }, { turnId: 't1' }),
      ev({ t: 'item.completed', item: { itemId: 'x', type: 'command', title: 'ls -la', status: 'completed', result: { preview: 'a\nb', truncated: false, isError: false } } }, { turnId: 't1' }),
      ev({ t: 'text.snapshot', text: 'Hello', final: true }, { turnId: 't1', audience: 'answer' }),
      ev({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'rm -rf x', risk: {}, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true, resolver: { kind: 'human', principals: [], routes: [] } }),
      ev({ t: 'turn.completed', turnId: 't1', status: 'completed' }),
    ].map((e) => r.render(e)).join('');
    expect(out).toBe(
      [
        '── turn t1 started (1 input, me) h/m bypass',
        'Hello',
        '   ▶ command: ls -la',
        '   ✓ ls -la [completed]  → a b',
        '   ? request r1: rm -rf x  [/approve r1 | /deny r1]',
        '── turn t1 completed',
        '',
      ].join('\n'),
    );
  });

  it('prints the final snapshot when there were no deltas (card/final tiers); hides auto-resolved requests', () => {
    const r = new EventRenderer();
    expect(r.render(ev({ t: 'text.snapshot', text: 'answer', final: true }, { turnId: 't2', audience: 'answer' }))).toBe('answer\n');
    expect(r.render(ev({ t: 'request.opened', requestId: 'r', kind: 'tool_approval', title: 't', risk: {}, allowedDecisions: [], allowAlways: false, defaultDeny: false, resolver: { kind: 'auto', decision: { kind: 'allow_once' } } }))).toBe('');
  });
});
