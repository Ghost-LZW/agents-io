import { describe, expect, it } from 'vitest';
import {
  ChannelAdapterFrame,
  ChannelHello,
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

  it('accepts a hello that names optional methods this side does not know', () => {
    const caps = {
      text: { maxChars: 4000, markdown: 'basic' },
      edit: true,
      buttons: true,
      media: { in: [], out: [] },
      voiceOut: 'none',
      threads: true,
      approvals: 'buttons',
      defaultTier: 'card',
      evidence: ['platform_signed'],
      declaresSender: true,
    };
    expect(check(ChannelHello, { adapterId: 'x', caps, methods: ['edit', 'react'] })).toBe(true);
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

describe('FrameDecoder line limit', () => {
  it('drops an oversized line, reports it once, and resumes at the next newline', () => {
    const bad: [string, unknown][] = [];
    const d = new FrameDecoder((l, e) => bad.push([l, e]), { maxLineLength: 20 });
    const out: unknown[] = [];
    for (let i = 0; i < 10; i++) out.push(...d.push('x'.repeat(15)));
    out.push(...d.push('yyy\n' + encodeFrame({ a: 1 })));
    expect(out).toEqual([{ a: 1 }]);
    expect(bad).toHaveLength(1);
    expect(String(bad[0]![1])).toMatch(/exceeds 20/);
    expect(bad[0]![0].length).toBeLessThanOrEqual(200);
  });

  it('keeps lines at the limit and checks a complete long line too', () => {
    const bad: string[] = [];
    const d = new FrameDecoder((l) => bad.push(l), { maxLineLength: 12 });
    expect(d.push('{"a":"1234"}\n{"a":"12345678"}\n{"b":2}\n')).toEqual([{ a: '1234' }, { b: 2 }]);
    expect(bad).toHaveLength(1);
  });
});

describe('FrameDecoder bytes', () => {
  it('keeps multi-byte characters split across chunks', () => {
    const bytes = new TextEncoder().encode(encodeFrame({ t: '飞书' }));
    const d = new FrameDecoder();
    const out = [...d.push(bytes.slice(0, 9)), ...d.push(bytes.slice(9))];
    expect(out).toEqual([{ t: '飞书' }]);
  });
});

describe('host protocol', () => {
  it('validates a binding table and host frames', async () => {
    const { BindingTable, HostRequestFrame, HostEventFrame } = await import('../src/index.js');
    const table = {
      version: '1', onHostDown: 'suspend',
      bindings: [
        { id: 'owner-dm', match: { channel: 'lark-bot', conversationKind: 'dm', labels: ['owner'] }, on: 'dispatch', agent: 'assistant', session: 'main' },
        { id: 'xwo-buttons', match: { actionPrefix: 'xwo:' }, on: 'host' },
        { id: 'triage', match: { channel: 'mail', known: false }, on: 'context', agent: 'assistant', callout: { timeoutMs: 1500, onFailure: 'host' } },
      ],
      identities: [{ channel: 'lark-bot', channelUserId: 'on_x', principal: 'member:lzw', labels: ['owner'] }],
    };
    expect(errors(BindingTable, table)).toEqual([]);
    expect(check(BindingTable, { ...table, bindings: [{ id: 'x', match: {}, on: 'wake' }] })).toBe(false);
    expect(check(HostRequestFrame, { v: 1, type: 'run.start', id: '1', runId: 'r1', agent: 'executor', input: [{ type: 'text', text: 'go' }] })).toBe(true);
    expect(check(HostRequestFrame, { v: 1, type: 'bindings.put', id: '2', table })).toBe(true);
    expect(check(HostEventFrame, { v: 1, type: 'run.ended', runId: 'r1', sessionKey: 'run:r1', status: 'completed', exitCode: 0 })).toBe(true);
  });
});
