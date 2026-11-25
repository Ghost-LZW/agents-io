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
  it('accepts a valid envelope and rejects a bad one #PR-1', () => {
    expect(errors(InboundEnvelope, env)).toEqual([]);
    expect(check(InboundEnvelope, { ...env, v: 2 })).toBe(false);
    expect(check(InboundEnvelope, { ...env, sender: { channelUserId: 'x' } })).toBe(false);
  });

  it('validates session events #PR-1', () => {
    const e = {
      v: 1, sessionKey: 's', seq: 1, harness: 'claude-code', generation: 1, visibility: 'participants',
      ts: 1, level: 'primary', audience: 'answer', durability: 'durable',
      body: { t: 'text.snapshot', text: 'x', final: true },
    };
    expect(errors(SessionEvent, e)).toEqual([]);
    expect(check(SessionEvent, { ...e, body: { t: 'nope' } })).toBe(false);
  });

  it('validates bridge frames #PR-1', () => {
    expect(check(ChannelAdapterFrame, { v: 1, type: 'inbound', id: '1', envelope: env })).toBe(true);
    expect(check(ChannelHostFrame, { v: 1, type: 'send', id: '2', route: env.replyRoute, msg: { text: 'x' }, op: { operationId: 'o' } })).toBe(true);
    expect(check(ChannelHostFrame, { v: 1, type: 'shutdown' })).toBe(true);
  });

  it('accepts a hello that names optional methods this side does not know #PR-1', () => {
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
  it('round-trips frames across arbitrary chunking and skips garbage #PR-2', () => {
    const bad: string[] = [];
    const d = new FrameDecoder((l) => bad.push(l));
    const text = encodeFrame({ a: 1 }) + 'not json\n' + encodeFrame({ b: 'x\ny' });
    const out: unknown[] = [];
    for (const ch of text) out.push(...d.push(ch));
    expect(out).toEqual([{ a: 1 }, { b: 'x\ny' }]);
    expect(bad).toEqual(['not json']);
  });

  it('routeKey ignores reply target #PR-1', () => {
    expect(routeKey({ channel: 'c', account: 'a', conversationId: 'x', threadId: 't', replyToMessageId: 'm' })).toBe('c:a:x:t');
  });
});

describe('FrameDecoder line limit', () => {
  it('drops an oversized line, reports it once, and resumes at the next newline #PR-2', () => {
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

  it('keeps lines at the limit and checks a complete long line too #PR-2', () => {
    const bad: string[] = [];
    const d = new FrameDecoder((l) => bad.push(l), { maxLineLength: 12 });
    expect(d.push('{"a":"1234"}\n{"a":"12345678"}\n{"b":2}\n')).toEqual([{ a: '1234' }, { b: 2 }]);
    expect(bad).toHaveLength(1);
  });
});

describe('FrameDecoder bytes', () => {
  it('keeps multi-byte characters split across chunks #PR-2', () => {
    const bytes = new TextEncoder().encode(encodeFrame({ t: '飞书' }));
    const d = new FrameDecoder();
    const out = [...d.push(bytes.slice(0, 9)), ...d.push(bytes.slice(9))];
    expect(out).toEqual([{ t: '飞书' }]);
  });
});

describe('host protocol', () => {
  it('a host rule may name the backend it is for (to); tables without it are unchanged #RT-1 #PR-1', async () => {
    const { Binding, BindingTable, HostRequestFrame } = await import('../src/index.js');
    const plain = { id: 'buttons', match: { actionPrefix: 'alpha:' }, on: 'host' };
    const routed = { ...plain, to: 'alpha' };
    expect(errors(Binding, plain)).toEqual([]);
    expect(errors(Binding, routed)).toEqual([]);
    expect(check(Binding, { ...plain, to: 1 })).toBe(false);
    expect(errors(Binding, { id: 'triage', match: { known: false }, on: 'context', agent: 'assistant', callout: { onFailure: 'host' }, to: 'beta' })).toEqual([]);
    const table = { version: '1', bindings: [plain], identities: [] };
    expect(errors(BindingTable, table)).toEqual([]);
    expect(errors(BindingTable, { ...table, bindings: [plain, { ...routed, id: 'to-alpha' }] })).toEqual([]);
    expect(check(HostRequestFrame, { v: 1, type: 'bindings.put', id: '1', table: { ...table, bindings: [routed] } })).toBe(true);
    expect(check(HostRequestFrame, { v: 1, type: 'bindings.put', id: '1', table: { ...table, bindings: [{ ...routed, to: {} }] } })).toBe(false);
    // A table without `to` carries no such key: old hosts and old daemons see the same value.
    expect('to' in plain).toBe(false);
  });

  it('a host rule may carry a tag, and an item and a matched rule of an explanation too; tables, items and explanations without it are unchanged #RT-1 #PR-1', async () => {
    const { Binding, BindingTable, HostRequestFrame, InboundItem, RouteExplanation } = await import('../src/index.js');
    const plain = { id: 'buttons', match: { channel: 'fake' }, on: 'host' };
    expect(errors(Binding, plain)).toEqual([]);
    expect(errors(Binding, { ...plain, tag: 'inbox' })).toEqual([]);
    expect(errors(Binding, { ...plain, to: 'alpha', tag: 'x'.repeat(128) })).toEqual([]);
    // The schema leaves a rule's tag open (a table may carry its own `tag` key on other rules, as before the
    // feature): the router checks it where it is a tag (router.test.ts). An item's and an explanation's is a string.
    for (const tag of ['', 'x'.repeat(129), 1, null, ['inbox'], { a: 1 }]) expect(check(Binding, { ...plain, on: 'dispatch', tag })).toBe(true);
    const table = { version: '1', bindings: [{ ...plain, tag: 'chat' }], identities: [] };
    expect(errors(BindingTable, table)).toEqual([]);
    expect(check(HostRequestFrame, { v: 1, type: 'bindings.put', id: '1', table })).toBe(true);
    expect(check(HostRequestFrame, { v: 1, type: 'bindings.put', id: '1', table: { ...table, bindings: [{ ...plain, on: 'dispatch', tag: 7 }] } })).toBe(true);
    const input = { inputId: 'in1', origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' }, content: env.content, replyRoute: env.replyRoute, channelContext: {} };
    const item = { cursor: 1, channelRef: 'channel:lark/m1', account: 'bot1', bindingId: 'buttons', input, envelope: env, receivedAt: 1 };
    expect(errors(InboundItem, item)).toEqual([]);
    expect(errors(InboundItem, { ...item, to: 'alpha', tag: 'inbox' })).toEqual([]);
    expect(check(InboundItem, { ...item, tag: 7 })).toBe(false);
    const explanation = { inputId: 'in1', tableVersions: ['1'], matched: [{ bindingId: 'buttons', source: 'config', on: 'host' }], principal: null, evidence: 'platform_signed' };
    expect(errors(RouteExplanation, explanation)).toEqual([]);
    expect(errors(RouteExplanation, { ...explanation, matched: [{ bindingId: 'buttons', source: 'config', on: 'host', to: 'alpha', tag: 'inbox' }] })).toEqual([]);
    expect(check(RouteExplanation, { ...explanation, matched: [{ bindingId: 'buttons', source: 'config', on: 'host', tag: {} }] })).toBe(false);
    // Without a tag there is no such key anywhere.
    expect('tag' in plain || 'tag' in item || 'tag' in explanation.matched[0]!).toBe(false);
  });

  it('blob.stat, blob.get and blob.put are host request frames with result schemas; a length over BLOB_FRAME_MAX_BYTES, a negative offset and an upload id over 64 characters are invalid #PR-1 #PB-6', async () => {
    const { BLOB_FRAME_MAX_BYTES, HOST_REQUEST_FRAME_TYPES, HOST_RESULT_VALUES, HostRequestFrame, HostBlobStatResult, HostBlobGetResult, HostBlobPutResult } = await import('../src/index.js');
    expect(BLOB_FRAME_MAX_BYTES).toBe(1024 * 1024);
    const ref = `sha256:${'a'.repeat(64)}`;
    const f = (type: string, rest: Record<string, unknown>) => ({ v: 1, type, id: '1', ...rest });
    for (const type of ['blob.stat', 'blob.get', 'blob.put'] as const) {
      expect(HOST_REQUEST_FRAME_TYPES).toContain(type);
      expect(HOST_RESULT_VALUES[type]).toBeDefined();
    }
    expect(errors(HostRequestFrame, f('blob.stat', { ref }))).toEqual([]);
    expect(check(HostRequestFrame, f('blob.stat', {}))).toBe(false);
    expect(errors(HostRequestFrame, f('blob.get', { ref }))).toEqual([]);
    expect(errors(HostRequestFrame, f('blob.get', { ref, offset: 0, length: BLOB_FRAME_MAX_BYTES }))).toEqual([]);
    expect(check(HostRequestFrame, f('blob.get', { ref, length: BLOB_FRAME_MAX_BYTES + 1 }))).toBe(false);
    expect(check(HostRequestFrame, f('blob.get', { ref, length: 0 }))).toBe(false);
    expect(check(HostRequestFrame, f('blob.get', { ref, offset: -1 }))).toBe(false);
    expect(check(HostRequestFrame, f('blob.get', { ref, offset: 1.5 }))).toBe(false);
    expect(errors(HostRequestFrame, f('blob.put', { base64: 'aGk=' }))).toEqual([]);
    expect(errors(HostRequestFrame, f('blob.put', { base64: 'aGk=', mime: 'text/plain', name: 'a.txt', part: { upload: 'u'.repeat(64), offset: 0, last: true } }))).toEqual([]);
    expect(check(HostRequestFrame, f('blob.put', { base64: 'aGk=', part: { upload: 'u'.repeat(65), offset: 0 } }))).toBe(false);
    expect(check(HostRequestFrame, f('blob.put', { base64: 'aGk=', part: { upload: '', offset: 0 } }))).toBe(false);
    expect(check(HostRequestFrame, f('blob.put', { base64: 'aGk=', part: { upload: 'u', offset: -1 } }))).toBe(false);
    expect(check(HostRequestFrame, f('blob.put', { part: { upload: 'u', offset: 0 } }))).toBe(false);
    // Results: a size or null; bytes with the whole size and the offset; a stored blob or the bytes received so far. No mime, no name.
    expect(errors(HostBlobStatResult, { size: 3 })).toEqual([]);
    expect(errors(HostBlobStatResult, null)).toEqual([]);
    expect(check(HostBlobStatResult, {})).toBe(false);
    expect(errors(HostBlobGetResult, { base64: 'aGk=', size: 2, offset: 0 })).toEqual([]);
    expect(check(HostBlobGetResult, { base64: 'aGk=' })).toBe(false);
    expect(errors(HostBlobPutResult, { ref, size: 2 })).toEqual([]);
    expect(errors(HostBlobPutResult, { upload: 'u', received: 2 })).toEqual([]);
    expect(check(HostBlobPutResult, { upload: 'u' })).toBe(false);
  });

  it('validates a binding table and host frames #PR-1', async () => {
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
    const start = { v: 1, type: 'run.start', id: '1', runId: 'r1', agent: 'executor', input: [{ type: 'text', text: 'go' }] };
    expect(check(HostRequestFrame, start)).toBe(true);
    expect(check(HostRequestFrame, { ...start, overrides: { model: 'opus', effort: 'high', profile: 'restricted' } })).toBe(true);
    expect(check(HostRequestFrame, { ...start, overrides: {} })).toBe(true);
    expect(check(HostRequestFrame, { ...start, overrides: { model: 1 } })).toBe(false);
    expect(check(HostRequestFrame, { v: 1, type: 'bindings.put', id: '2', table })).toBe(true);
    expect(check(HostEventFrame, { v: 1, type: 'run.ended', runId: 'r1', sessionKey: 'run:r1', status: 'completed', exitCode: 0 })).toBe(true);
    const ended = { v: 1, type: 'run.ended', runId: 'r1', sessionKey: 'run:r1', status: 'timeout', exitCode: 124, durationMs: 1200, usage: { inputTokens: 10 } };
    expect(errors(HostEventFrame, ended)).toEqual([]);
    expect(check(HostEventFrame, { ...ended, status: 'killed' })).toBe(false);
  });
});
