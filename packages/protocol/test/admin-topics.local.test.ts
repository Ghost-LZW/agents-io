import { describe, expect, it } from 'vitest';
import {
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
  check,
  errors,
} from '../src/index.js';

const topic = {
  id: 'tp_1', conversation: 'wechat:me:c1', sessionKey: 'assistant:wechat:me:c1#tp_1',
  title: 'trip', state: 'current', createdAt: 1, lastActiveAt: 2,
};
const explanation = { inputId: 'in_1', tableVersions: ['config'], matched: [{ bindingId: 'b', source: 'config', on: 'host' }], principal: null, evidence: 'none', at: 3 };

describe('admin API', () => {
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
