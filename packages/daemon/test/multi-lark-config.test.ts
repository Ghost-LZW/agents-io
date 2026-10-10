import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/console-config.js';
import { tmp } from './helpers.js';

/*
 * The console reports the lark-bot channel rules of decision 8 before writing
 * (`validate` / `PUT` run the startup checks): 422 with the issue, file unchanged.
 */

const ENV = { LARK_APP_ID: 'cli_d', LARK_APP_SECRET: 'secret-d', A_ID: 'cli_a', A_SECRET: 'secret-a' };

function store() {
  const dir = tmp('aio-mlc-');
  const path = join(dir, 'aio.config.json');
  const initial = { dataDir: dir, channels: [{ type: 'lark-bot' }] };
  writeFileSync(path, JSON.stringify(initial, null, 2) + '\n', { mode: 0o600 });
  return { path, s: new ConfigStore({ path, env: ENV }), initial: readFileSync(path, 'utf8') };
}

const bot = (account: string | undefined, config?: Record<string, unknown>) => ({ type: 'lark-bot', ...(account !== undefined ? { account } : {}), ...(config ? { config } : {}) });

describe('console config: several lark-bot channels', () => {
  const cases: [string, unknown[], RegExp][] = [
    ['two entries reading LARK_APP_*', [bot(undefined), bot('b')], /both read LARK_APP_ID/],
    ['the same app twice', [bot(undefined), bot('a', { appId: 'cli_d', appSecret: 'env:A_SECRET' })], /are the same app cli_d/],
    ['the same account twice', [bot('a', { appId: 'env:A_ID', appSecret: 'env:A_SECRET' }), bot('a', { appId: 'cli_z', appSecret: 'env:A_SECRET' })], /same account/],
    ['a bad account name with several bots', [bot(undefined), bot('a:b', { appId: 'env:A_ID', appSecret: 'env:A_SECRET' })], /accounts are letters/],
    ['appId without appSecret', [bot('a', { appId: 'env:A_ID' })], /give both appId and appSecret/],
    ['a missing variable', [bot('a', { appId: 'env:NOPE', appSecret: 'env:A_SECRET' })], /environment variable NOPE is not set/],
  ];
  for (const [what, channels, message] of cases) {
    it(`${what}: validate and PUT answer 422, the file is unchanged #CF-3 #SE-1`, () => {
      const { path, s, initial } = store();
      const next = { ...(JSON.parse(initial) as Record<string, unknown>), channels };
      const v = s.validate(next);
      expect(v.valid).toBe(false);
      expect(v.issues).toContainEqual(expect.objectContaining({ code: 'invalid', severity: 'error', message: expect.stringMatching(message) }));
      for (const i of v.issues) for (const secret of ['secret-d', 'secret-a']) expect(i.message).not.toContain(secret);
      expect(s.put(next)).toMatchObject({ status: 422 });
      expect(readFileSync(path, 'utf8')).toBe(initial);
    });
  }

  it('two bots with their own references are accepted #CF-3', () => {
    const { s, initial } = store();
    const next = { ...(JSON.parse(initial) as Record<string, unknown>), channels: [bot(undefined), bot('proj-a', { appId: 'env:A_ID', appSecret: 'env:A_SECRET' })] };
    expect(s.put(next)).toMatchObject({ status: 200 });
  });
});
