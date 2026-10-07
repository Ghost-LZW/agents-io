import { describe, expect, it } from 'vitest';
import {
  ADMIN_ENDPOINTS,
  ADMIN_WS_SUBPROTOCOL,
  AdminConfigDocument,
  AdminConfigPut,
  AdminConfigValidation,
  AdminError,
  AdminExplain,
  AdminLarkBotJob,
  AdminLarkBotRequest,
  AdminQueue,
  AdminSessions,
  AdminStatus,
  Binding,
  BindingsGetResult,
  CLIENT_FRAME_TYPES,
  ClientFrame,
  DeliverResult,
  HOST_REQUEST_FRAME_TYPES,
  HOST_RESULT_VALUES,
  HostEventFrame,
  HostHelloResult,
  HostRequestFrame,
  InboundReadResult,
  InputVerifyResult,
  RouteCalloutAnswer,
  RunStartResult,
  SessionEvent,
  SessionScope,
  Topic,
  TopicSwitchResult,
  check,
  errors,
} from '../src/index.js';

const topic = {
  id: 'tp_1', conversation: 'wechat:me:c1', sessionKey: 'assistant:wechat:me:c1#tp_1',
  title: 'trip', state: 'current', createdAt: 1, lastActiveAt: 2,
};
const route = { channel: 'lark-bot', account: 'default', conversationId: 'oc_1' };
const env = {
  v: 1, id: 'm1', channel: 'lark-bot', account: 'default',
  conversation: { id: 'oc_1', kind: 'dm' },
  sender: { channelUserId: 'u_1', evidence: 'platform_signed' },
  content: [{ type: 'text', text: 'hi' }],
  replyRoute: route,
};
const input = {
  inputId: 'in_1',
  origin: { kind: 'human', principal: { id: 'member:1', labels: [] }, evidence: 'platform_signed', via: 'lark-bot:default:oc_1', adapter: 'lark-bot' },
  content: [{ type: 'text', text: 'hi' }],
  replyRoute: route,
  channelContext: { channel: 'lark-bot' },
};
const explanation = { inputId: 'in_1', tableVersions: ['config'], matched: [{ bindingId: 'b', source: 'config', on: 'host' }], principal: null, evidence: 'none', at: 3 };

describe('topics', () => {
  it('scope, Topic, topic.changed', () => {
    expect(check(SessionScope, 'topic')).toBe(true);
    expect(check(Binding, { id: 'flat', match: { conversationKind: 'dm' }, on: 'dispatch', agent: 'a', session: 'topic' })).toBe(true);
    expect(errors(Topic, topic)).toEqual([]);
    expect(check(Topic, { ...topic, state: 'archived' })).toBe(false);
    const e = {
      v: 1, sessionKey: topic.sessionKey, seq: 4, harness: 'claude-code', generation: 1, visibility: 'participants',
      ts: 1, level: 'primary', audience: 'status', durability: 'durable',
      body: { t: 'topic.changed', conversation: topic.conversation, from: 'tp_0', to: 'tp_1', title: 'trip', reason: 'agent' },
    };
    expect(errors(SessionEvent, e)).toEqual([]);
    expect(check(SessionEvent, { ...e, body: { ...e.body, reason: 'model' } })).toBe(false);
    expect(check(SessionEvent, { ...e, body: { t: 'topic.changed', conversation: 'c', reason: 'user' } })).toBe(false);
  });

  it('topic.list / topic.switch client frames (host connections send client frames too)', () => {
    expect(CLIENT_FRAME_TYPES).toContain('topic.list');
    expect(CLIENT_FRAME_TYPES).toContain('topic.switch');
    expect(check(ClientFrame, { v: 1, type: 'topic.list', id: '1' })).toBe(true);
    expect(check(ClientFrame, { v: 1, type: 'topic.list', id: '1', conversation: 'wechat:me:c1', sessionKey: 's' })).toBe(true);
    expect(check(ClientFrame, { v: 1, type: 'topic.switch', id: '2', conversation: 'wechat:me:c1', topicId: 'tp_0' })).toBe(true);
    expect(check(ClientFrame, { v: 1, type: 'topic.switch', id: '3', conversation: 'wechat:me:c1', new: {} })).toBe(true);
    expect(check(ClientFrame, { v: 1, type: 'topic.switch', id: '4', conversation: 'wechat:me:c1', new: { title: 'next' } })).toBe(true);
    expect(check(ClientFrame, { v: 1, type: 'topic.switch', id: '5', conversation: 'wechat:me:c1' })).toBe(false);
    expect(check(ClientFrame, { v: 1, type: 'topic.switch', id: '6', topicId: 'tp_0' })).toBe(false);
    expect(errors(TopicSwitchResult, { topic, previous: { ...topic, id: 'tp_0', state: 'parked' }, created: false })).toEqual([]);
  });
});

describe('host protocol additions', () => {
  it('hello lease, run.start overrides, run.ended timeout/duration/usage', () => {
    expect(check(HostRequestFrame, { v: 1, type: 'host.hello', id: '1', token: 't', name: 'xwo', lease: { ttlMs: 60_000 } })).toBe(true);
    expect(check(HostRequestFrame, { v: 1, type: 'host.hello', id: '1', token: 't', name: 'xwo', lease: {} })).toBe(false);
    const start = { v: 1, type: 'run.start', id: '2', runId: 'r', agent: 'exec', input: [{ type: 'text', text: 'go' }] };
    expect(check(HostRequestFrame, { ...start, overrides: { model: 'opus', effort: 'high', profile: 'restricted' } })).toBe(true);
    expect(check(HostRequestFrame, { ...start, overrides: {} })).toBe(true);
    expect(check(HostRequestFrame, { ...start, overrides: { model: 1 } })).toBe(false);
    const ended = { v: 1, type: 'run.ended', runId: 'r', sessionKey: 'run:r', status: 'timeout', exitCode: 124, durationMs: 1200, usage: { inputTokens: 10 } };
    expect(errors(HostEventFrame, ended)).toEqual([]);
    expect(check(HostEventFrame, { ...ended, status: 'killed' })).toBe(false);
  });

  it('a result-value schema for every host request', () => {
    expect(Object.keys(HOST_RESULT_VALUES).sort()).toEqual([...HOST_REQUEST_FRAME_TYPES].sort());
    expect(errors(HostHelloResult, { name: 'xwo', protocol: 1, host: false, bindings: { version: null, active: false }, lease: { ttlMs: 1, expiresAt: 2 } })).toEqual([]);
    expect(errors(BindingsGetResult, { config: null, host: { table: { version: '1', bindings: [], identities: [] }, putAt: 1, active: false, suspended: 'host_down' }, hostConnected: false })).toEqual([]);
    expect(check(BindingsGetResult, { config: null, host: null, hostConnected: false, extra: 1 })).toBe(true);
    expect(errors(RunStartResult, { runId: 'r', sessionKey: 'run:r', state: 'ended', ended: { v: 1, type: 'run.ended', runId: 'r', sessionKey: 'run:r', status: 'completed', exitCode: 0 } })).toEqual([]);
    expect(check(RunStartResult, { runId: 'r', sessionKey: 'run:r', state: 'queued' })).toBe(false);
    expect(errors(DeliverResult, { operationId: 'o', sessionKey: 'host:x', route, status: 'delivered', attempts: 1, providerMessageId: 'om_1', duplicate: false })).toEqual([]);
    const rec = {
      channelRef: 'channel:lark-bot/om_1', channel: 'lark-bot', account: 'default', conversation: { id: 'oc_1', kind: 'dm' },
      author: { channelUserId: 'u_1', displayName: 'A' }, evidence: 'platform_signed', principal: 'member:1', labels: ['owner'], kind: 'human', receivedAt: 1,
    };
    expect(errors(InputVerifyResult, { channelRef: rec.channelRef, found: true, records: [rec] })).toEqual([]);
    expect(check(InputVerifyResult, { channelRef: rec.channelRef, found: true, records: [{ ...rec, kind: 'robot' }] })).toBe(false);
    const item = { cursor: 1, channelRef: 'channel:lark-bot/m1', account: 'default', bindingId: 'b', input, envelope: env, receivedAt: 1 };
    expect(errors(InboundReadResult, { items: [item], acked: 0, head: 1 })).toEqual([]);
    expect(errors(HOST_RESULT_VALUES.explain, explanation)).toEqual([]);
    expect(errors(RouteCalloutAnswer, { on: 'context', session: 'topic' })).toEqual([]);
  });
});

describe('admin API', () => {
  it('lists every endpoint once, with schemas', () => {
    const keys = ADMIN_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['GET /api/status', 'GET /api/config', 'PUT /api/config', 'POST /api/config/validate', 'GET /api/explain/:inputId', 'GET /api/queue', 'GET /api/sessions', 'POST /api/bots/lark', 'GET /api/bots/lark/:job']) {
      expect(keys).toContain(k);
    }
    for (const e of ADMIN_ENDPOINTS) {
      expect(e.response).toBeTypeOf('object');
      if (e.method === 'GET') expect('body' in e).toBe(false);
    }
    expect(ADMIN_WS_SUBPROTOCOL).toBe('agents-io.v1');
  });

  it('validates admin bodies', () => {
    expect(errors(AdminError, { error: { code: 'unauthorized', message: 'no token' } })).toEqual([]);
    const status = {
      version: '0.1.0', protocol: 1, pid: 42, startedAt: 1, now: 2, dataDir: '/d', socket: '/d/run/aio.sock',
      host: { connected: true, name: 'xwo', consumer: 'xwo', table: { version: 'v1', active: true } },
      channels: [{ id: 'lark-bot', account: 'default', state: 'running' }],
      agents: [{ name: 'assistant', harness: 'claude', mode: 'interactive', default: true }, { name: 'exec', harness: 'codex', mode: 'task', profile: 'bypass' }],
      sessions: { total: 3, live: 1, running: 0 }, runs: { running: [] }, queue: { head: 7 },
    };
    expect(errors(AdminStatus, status)).toEqual([]);
    expect(check(AdminStatus, { ...status, channels: [{ id: 'x', account: 'a', state: 'weird' }] })).toBe(false);

    const doc = {
      path: '/home/u/aio.config.json', revision: 'sha256:ab',
      config: { channels: [{ type: 'lark-bot', config: { appId: 'env:LARK_APP_ID', appSecret: '<redacted>' } }] },
      issues: [{ path: '/agents/exec', message: 'unknown harness', code: 'unknown_harness', severity: 'error' }],
      env: [{ name: 'LARK_APP_ID', set: true }],
    };
    expect(errors(AdminConfigDocument, doc)).toEqual([]);
    expect(errors(AdminConfigPut, { config: doc.config, ifRevision: doc.revision })).toEqual([]);
    expect(check(AdminConfigPut, { config: [] })).toBe(false);
    expect(errors(AdminConfigValidation, { valid: false, issues: doc.issues })).toEqual([]);
    expect(errors(AdminExplain, explanation)).toEqual([]);
    expect(errors(AdminQueue, { head: 9, consumers: [{ consumer: 'xwo', acked: 4, pending: 5, push: false, oldestPendingAt: 1 }] })).toEqual([]);
    const session = { sessionKey: 's', harness: 'claude', state: 'idle', head: 3, queued: 0, pendingRequests: [], live: false, agent: 'assistant', conversation: topic.conversation, topic };
    expect(errors(AdminSessions, { sessions: [session] })).toEqual([]);
    expect(check(AdminSessions, { sessions: [{ ...session, head: 'x' }] })).toBe(false);

    expect(errors(AdminLarkBotRequest, { name: 'my agent', domain: 'lark', presets: ['messaging'] })).toEqual([]);
    expect(check(AdminLarkBotRequest, { name: 'x', domain: 'slack' })).toBe(false);
    expect(errors(AdminLarkBotJob, { job: 'j1', state: 'waiting_scan', qr: { payload: 'https://open.feishu.cn/x', expiresAt: 9 }, createdAt: 1, updatedAt: 2 })).toEqual([]);
    expect(errors(AdminLarkBotJob, {
      job: 'j1', state: 'succeeded', createdAt: 1, updatedAt: 3,
      result: { appId: 'cli_x', domain: 'feishu', account: 'default', env: { appId: 'env:LARK_APP_ID', appSecret: 'env:LARK_APP_SECRET' }, channelAdded: true },
    })).toEqual([]);
  });
});
