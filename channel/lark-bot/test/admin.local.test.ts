import { describe, expect, it } from 'vitest';
import { check, errors } from '@agents-io/protocol';
import { AdminLarkBotJob, AdminLarkBotRequest } from '../src/admin.js';

describe('admin API', () => {
  it('validates Lark bot provisioning bodies', () => {
    expect(errors(AdminLarkBotRequest, { name: 'my agent', domain: 'lark', presets: ['messaging'] })).toEqual([]);
    expect(check(AdminLarkBotRequest, { name: 'x', domain: 'slack' })).toBe(false);
    expect(errors(AdminLarkBotJob, { job: 'j1', state: 'waiting_scan', qr: { payload: 'https://open.feishu.cn/x', expiresAt: 9 }, createdAt: 1, updatedAt: 2 })).toEqual([]);
    expect(errors(AdminLarkBotJob, {
      job: 'j1', state: 'succeeded', createdAt: 1, updatedAt: 3,
      result: { appId: 'cli_x', domain: 'feishu', account: 'default', env: { appId: 'env:LARK_APP_ID', appSecret: 'env:LARK_APP_SECRET' }, channelAdded: true },
    })).toEqual([]);
  });
});
