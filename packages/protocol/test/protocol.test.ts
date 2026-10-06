import { describe, expect, it } from 'vitest';
import {
  ChannelAdapterFrame,
  ChannelHostFrame,
  FrameDecoder,
  InboundEnvelope,
  SessionEvent,
  check,
  encodeFrame,
  errors,
  routeKey,
} from '../src/index.js';

const env = {
  v: 1,
  id: 'm1',
  channel: 'lark',
  account: 'bot1',
  conversation: { id: 'oc_1', kind: 'group' },
  sender: { channelUserId: 'u_1', evidence: 'platform_signed', declared: 'runner:a/run:1' },
  content: [{ type: 'text', text: 'hi' }],
  replyRoute: { channel: 'lark', account: 'bot1', conversationId: 'oc_1' },
};

describe('schemas', () => {
  it('accepts a valid envelope and rejects a bad one', () => {
    expect(errors(InboundEnvelope, env)).toEqual([]);
    expect(check(InboundEnvelope, { ...env, v: 2 })).toBe(false);
    expect(check(InboundEnvelope, { ...env, sender: { channelUserId: 'x' } })).toBe(false);
  });

  it('validates session events', () => {
    const e = {
      v: 1, sessionKey: 's', seq: 1, harness: 'claude-code', generation: 1, visibility: 'participants',
      ts: 1, level: 'primary', audience: 'answer', durability: 'durable',
      body: { t: 'text.snapshot', text: 'x', final: true },
    };
    expect(errors(SessionEvent, e)).toEqual([]);
    expect(check(SessionEvent, { ...e, body: { t: 'nope' } })).toBe(false);
  });

  it('validates bridge frames', () => {
    expect(check(ChannelAdapterFrame, { v: 1, type: 'inbound', id: '1', envelope: env })).toBe(true);
    expect(check(ChannelHostFrame, { v: 1, type: 'send', id: '2', route: env.replyRoute, msg: { text: 'x' }, op: { operationId: 'o' } })).toBe(true);
    expect(check(ChannelHostFrame, { v: 1, type: 'shutdown' })).toBe(true);
  });
});

describe('wire', () => {
  it('round-trips frames across arbitrary chunking and skips garbage', () => {
    const bad: string[] = [];
    const d = new FrameDecoder((l) => bad.push(l));
    const text = encodeFrame({ a: 1 }) + 'not json\n' + encodeFrame({ b: 'x\ny' });
    const out: unknown[] = [];
    for (const ch of text) out.push(...d.push(ch));
    expect(out).toEqual([{ a: 1 }, { b: 'x\ny' }]);
    expect(bad).toEqual(['not json']);
  });

  it('routeKey ignores reply target', () => {
    expect(routeKey({ channel: 'c', account: 'a', conversationId: 'x', threadId: 't', replyToMessageId: 'm' })).toBe('c:a:x:t');
  });
});
