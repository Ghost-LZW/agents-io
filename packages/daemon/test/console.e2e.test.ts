import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AdminConfigDocument, AdminLarkBotJob, check } from '@agents-io/protocol';
import { consoleDaemon } from './console-helpers.js';

const FAKE_BOT = fileURLToPath(new URL('./fixtures/fake-create-lark-bot.mjs', import.meta.url));

describe('console Lark bot provisioning', () => {
  async function provisioning(mode = 'ok', raw: Record<string, unknown> = {}, env: Record<string, string> = {}) {
    const argsOut = join(process.env.TMPDIR ?? '/tmp', `aio-fake-args-${process.pid}-${Date.now()}-${Math.random()}.json`);
    const w = await consoleDaemon({ raw: { console: { port: 0, larkBotCommand: [process.execPath, FAKE_BOT] }, ...raw }, consoleEnv: { FAKE_MODE: mode, FAKE_ARGS_OUT: argsOut, PATH: process.env.PATH!, ...env } });
    const job = async (id: string) => (await w.api(`/api/bots/lark/${id}`)).body as AdminLarkBotJob;
    /** Wait for one of `states`. */
    const until = async (id: string, states: string[]) => {
      let j: AdminLarkBotJob | undefined;
      for (let i = 0; i < 300 && !states.includes(j?.state ?? ''); i++) {
        j = await job(id);
        if (!states.includes(j.state)) await new Promise((r) => setTimeout(r, 20));
      }
      return j!;
    };
    /** Start a job and wait for its QR; `scan()` lets the fake go on. */
    const begin = async (body: Record<string, unknown>) => {
      const r = await w.api('/api/bots/lark', { method: 'POST', json: { name: 'Bot', ...body } });
      expect(r.status).toBe(202);
      const id = r.body.job as string;
      await until(id, ['waiting_scan']);
      const argv = JSON.parse(readFileSync(argsOut, 'utf8')) as string[];
      return { id, argv, scan: () => writeFileSync(`${argv[argv.indexOf('--qr-out') + 1]}.scanned`, '') };
    };
    const cfgPath = join(w.dir, 'aio.config.json');
    const readCfg = () => JSON.parse(readFileSync(cfgPath, 'utf8'));
    /** Channels in the file only (the daemon itself runs none: it would dial Feishu). */
    const seed = (channels: unknown[]) => writeFileSync(cfgPath, JSON.stringify({ ...readCfg(), channels }, null, 2) + '\n', { mode: 0o600 });
    return { w, job, argsOut, until, begin, cfgPath, readCfg, seed };
  }

  it('starting → waiting_scan (QR payload) → configuring → succeeded; credentials only in the env file; the config gets the channel and the owner #SE-1 #CF-3', async () => {
    const { w, job, argsOut } = await provisioning();
    const start = await w.api('/api/bots/lark', { method: 'POST', json: { name: 'Ops Bot', avatar: 'data:image/png;base64,iVBORw0KGgo=' } });
    expect(start.status).toBe(202);
    const id = start.body.job as string;
    let j: AdminLarkBotJob | undefined;
    for (let i = 0; i < 200 && j?.state !== 'waiting_scan'; i++) {
      j = await job(id);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(check(AdminLarkBotJob, j)).toBe(true);
    expect(j).toMatchObject({ job: id, state: 'waiting_scan', qr: { payload: '{"qrlogin":{"token":"fake-qr-token"}}' } });
    // One job at a time.
    expect(await w.api('/api/bots/lark', { method: 'POST', json: { name: 'Another' } })).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
    // The child got the pinned flags.
    const argv = JSON.parse(readFileSync(argsOut, 'utf8')) as string[];
    expect(argv).toEqual(expect.arrayContaining(['--json', '--qr-out', '--write-env', join(w.dir, '.env.live'), '--name', 'Ops Bot', '--brand', 'feishu', '--preset', 'messaging,contact', '--avatar']));
    // Scan.
    writeFileSync(`${argv[argv.indexOf('--qr-out') + 1]}.scanned`, '');
    for (let i = 0; i < 200 && j?.state !== 'succeeded' && j?.state !== 'failed'; i++) {
      j = await job(id);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(check(AdminLarkBotJob, j)).toBe(true);
    expect(j).toMatchObject({
      state: 'succeeded',
      result: { appId: 'cli_fake123', domain: 'feishu', botName: 'Ops Bot', account: 'default', env: { appId: 'env:LARK_APP_ID', appSecret: 'env:LARK_APP_SECRET', domain: 'env:LARK_DOMAIN' }, owner: 'lark-bot:on_owner1', channelAdded: true },
    });
    expect(j!.qr).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('very-secret-value');
    const env = readFileSync(join(w.dir, '.env.live'), 'utf8');
    expect(env).toContain('LARK_APP_SECRET=very-secret-value');
    const cfg = JSON.parse(readFileSync(join(w.dir, 'aio.config.json'), 'utf8'));
    // Always explicit references (decision 8): the entry never depends on the LARK_APP_* fallback.
    expect(cfg.channels).toEqual([{ type: 'lark-bot', config: { appId: 'env:LARK_APP_ID', appSecret: 'env:LARK_APP_SECRET', domain: 'env:LARK_DOMAIN' } }]);
    expect(argv).not.toContain('--env-prefix');
    expect(cfg.policy.owners).toEqual(['fake:alice', 'lark-bot:on_owner1']);
    expect(statSync(join(w.dir, 'aio.config.json')).mode & 0o777).toBe(0o600);
    // The config document now validates with the new env file, and shows the references only.
    const doc = (await w.api('/api/config')).body as AdminConfigDocument;
    expect(JSON.stringify(doc)).not.toContain('very-secret-value');
    // A second bot under the same account would replace the first one's credentials.
    expect(await w.api('/api/bots/lark', { method: 'POST', json: { name: 'Second' } })).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
    expect(await w.api('/api/bots/lark', { method: 'POST', json: { name: 'Second', account: 'default' } })).toMatchObject({ status: 409 });
    expect(await w.api('/api/bots/lark/lark_nope')).toMatchObject({ status: 404, body: { error: { code: 'unknown_job' } } });
  });

  it('an expired QR code ends the job as expired; a crash as failed; bad requests are 400 #CF-3', async () => {
    const { w, job } = await provisioning('expire');
    const id = (await w.api('/api/bots/lark', { method: 'POST', json: { name: 'X', addChannel: false } })).body.job;
    let st: AdminLarkBotJob | undefined;
    for (let i = 0; i < 200 && !['expired', 'failed', 'succeeded'].includes(st?.state ?? ''); i++) {
      st = await job(id);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(st).toMatchObject({ state: 'expired', error: { code: 'qr_expired' } });
    expect(await w.api('/api/bots/lark', { method: 'POST', json: { name: 'X', avatar: 'https://example.com/a.png' } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(await w.api('/api/bots/lark', { method: 'POST', json: { nameX: 'X' } })).toMatchObject({ status: 400 });

    const c = await provisioning('crash');
    const cid = (await c.w.api('/api/bots/lark', { method: 'POST', json: { name: 'Y', addChannel: false } })).body.job;
    let cs: AdminLarkBotJob | undefined;
    for (let i = 0; i < 200 && !['expired', 'failed', 'succeeded'].includes(cs?.state ?? ''); i++) {
      cs = await c.job(cid);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(cs).toMatchObject({ state: 'failed', error: { code: 'no_result', message: expect.stringContaining('exited with 7') } });
  });

  it('addChannel:false does not overwrite the credentials of an existing bot (env file or environment): refused, nothing spawned #SE-1 #CF-3', async () => {
    const { w, argsOut } = await provisioning();
    const envFile = join(w.dir, '.env.live');
    writeFileSync(envFile, 'LARK_APP_ID=cli_old\nLARK_APP_SECRET=old-secret\n', { mode: 0o600 });
    const r = await w.api('/api/bots/lark', { method: 'POST', json: { name: 'Later', addChannel: false } });
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'conflict', message: expect.stringContaining('LARK_APP_ID') } } });
    expect(JSON.stringify(r.body)).not.toContain('old-secret');
    expect(readFileSync(envFile, 'utf8')).toBe('LARK_APP_ID=cli_old\nLARK_APP_SECRET=old-secret\n');
    expect(existsSync(argsOut)).toBe(false);
    // The same through the process environment.
    const p = await provisioning('ok');
    const e = await consoleDaemon({ raw: { console: { port: 0, larkBotCommand: [process.execPath, FAKE_BOT] } }, consoleEnv: { FAKE_ARGS_OUT: p.argsOut, LARK_APP_SECRET: 'x', PATH: process.env.PATH } });
    expect((await e.api('/api/bots/lark', { method: 'POST', json: { name: 'Later', addChannel: false } })).status).toBe(409);
  });

  // Decision 8: several bots in one daemon, one account each.
  const LARK_A = { type: 'lark-bot', config: { appId: 'env:LARK_APP_ID', appSecret: 'env:LARK_APP_SECRET', domain: 'env:LARK_DOMAIN' } };

  it('a second bot under another account: --env-prefix LARK_PROJ_A_, an entry with explicit references, result env with those names #CF-3 #SE-1', async () => {
    const p = await provisioning('ok', {}, { LARK_APP_ID: 'cli_first', LARK_APP_SECRET: 's1', LARK_DOMAIN: 'feishu' });
    p.seed([LARK_A]);
    const { id, argv, scan } = await p.begin({ account: 'proj-a', owner: false });
    expect(argv).toEqual(expect.arrayContaining(['--env-prefix', 'LARK_PROJ_A_']));
    scan();
    const j = await p.until(id, ['succeeded', 'failed']);
    expect(j).toMatchObject({ state: 'succeeded', result: { account: 'proj-a', env: { appId: 'env:LARK_PROJ_A_APP_ID', appSecret: 'env:LARK_PROJ_A_APP_SECRET', domain: 'env:LARK_PROJ_A_DOMAIN' }, channelAdded: true } });
    expect(p.readCfg().channels).toEqual([LARK_A, { type: 'lark-bot', account: 'proj-a', config: { appId: 'env:LARK_PROJ_A_APP_ID', appSecret: 'env:LARK_PROJ_A_APP_SECRET', domain: 'env:LARK_PROJ_A_DOMAIN' } }]);
    expect(readFileSync(join(p.w.dir, '.env.live'), 'utf8')).toContain('LARK_PROJ_A_APP_SECRET=very-secret-value');
    expect(JSON.stringify(j)).not.toContain('very-secret-value');
  });

  it('start checks: same account 409, target variables set 409 (named), a name reading the same variables 409, a bad account 400; nothing spawned #CF-3', async () => {
    const p = await provisioning('ok', {}, { LARK_APP_ID: 'cli_1', LARK_APP_SECRET: 's', LARK_PROJ_A_APP_ID: 'cli_2', LARK_PROJ_A_APP_SECRET: 's', LARK_OPS_DOMAIN: 'lark' });
    p.seed([LARK_A, { type: 'lark-bot', account: 'proj-a', config: { appId: 'env:LARK_PROJ_A_APP_ID', appSecret: 'env:LARK_PROJ_A_APP_SECRET' } }]);
    const post = (json: Record<string, unknown>) => p.w.api('/api/bots/lark', { method: 'POST', json: { name: 'N', ...json } });
    expect(await post({ account: 'proj-a' })).toMatchObject({ status: 409, body: { error: { code: 'conflict', message: expect.stringContaining('account proj-a is already configured') } } });
    // proj_a maps to the same LARK_PROJ_A_* names the proj-a entry reads.
    expect(await post({ account: 'proj_a' })).toMatchObject({ status: 409, body: { error: { message: expect.stringContaining('LARK_PROJ_A_APP_ID') } } });
    expect(await post({ account: 'ops' })).toMatchObject({ status: 409, body: { error: { message: expect.stringContaining('LARK_OPS_DOMAIN') } } });
    for (const account of ['a:b', '-x', '', 'x'.repeat(65)]) expect(await post({ account })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(existsSync(p.argsOut)).toBe(false);
  });

  it('a config change while the job waits for a scan: an entry for the same account added meanwhile → failed (conflict), only that entry stays; another account → both #CF-3', async () => {
    const p = await provisioning('ok', {}, { LARK_APP_ID: 'cli_first', LARK_APP_SECRET: 's1', LARK_DOMAIN: 'feishu', THEIR_SECRET: 't' });
    p.seed([LARK_A]);
    const { id, scan } = await p.begin({ account: 'proj-a' });
    const theirs = { type: 'lark-bot', account: 'proj-a', config: { appId: 'cli_theirs', appSecret: 'env:THEIR_SECRET' } };
    const cur = await p.w.api('/api/config');
    const put = await p.w.api('/api/config', { method: 'PUT', json: { config: { ...cur.body.config, channels: [LARK_A, theirs] }, ifRevision: cur.body.revision } });
    expect(put.status).toBe(200);
    scan();
    const j = await p.until(id, ['succeeded', 'failed']);
    expect(j).toMatchObject({ state: 'failed', error: { code: 'conflict', message: expect.stringContaining('LARK_PROJ_A_APP_ID') } });
    const cfg = p.readCfg();
    expect(cfg.channels).toEqual([LARK_A, theirs]);
    // Not added, so no owner either.
    expect(cfg.policy.owners).toEqual(['fake:alice']);

    const q = await provisioning('ok', {}, { LARK_APP_ID: 'cli_first', LARK_APP_SECRET: 's1', LARK_DOMAIN: 'feishu', INTL_SECRET: 'i' });
    q.seed([LARK_A]);
    const b = await q.begin({ account: 'proj-a', owner: false });
    const other = { type: 'lark-bot', account: 'brand-intl', config: { appId: 'cli_intl', appSecret: 'env:INTL_SECRET', domain: 'lark' } };
    const c2 = await q.w.api('/api/config');
    expect((await q.w.api('/api/config', { method: 'PUT', json: { config: { ...c2.body.config, channels: [LARK_A, other] }, ifRevision: c2.body.revision } })).status).toBe(200);
    b.scan();
    expect(await q.until(b.id, ['succeeded', 'failed'])).toMatchObject({ state: 'succeeded' });
    expect(q.readCfg().channels.map((c: { account?: string }) => c.account ?? 'default')).toEqual(['default', 'brand-intl', 'proj-a']);
  });

  it('the created app is one a configured channel already runs → failed (duplicate_app), config and owners unchanged #CF-3', async () => {
    const p = await provisioning('ok', {}, { LARK_APP_ID: 'cli_same', LARK_APP_SECRET: 's1', LARK_DOMAIN: 'feishu', FAKE_APP_ID: 'cli_same' });
    p.seed([LARK_A]);
    const before = readFileSync(p.cfgPath, 'utf8');
    const { id, scan } = await p.begin({ account: 'proj-a' });
    scan();
    const j = await p.until(id, ['succeeded', 'failed']);
    expect(j).toMatchObject({ state: 'failed', error: { code: 'duplicate_app', message: expect.stringMatching(/cli_same.*account default.*LARK_PROJ_A_APP_ID/) } });
    expect(readFileSync(p.cfgPath, 'utf8')).toBe(before);
  });

  it('a config that would not load with the bot → failed (config_invalid), nothing written #CF-3', async () => {
    const p = await provisioning();
    const { id, scan } = await p.begin({ account: 'proj-a' });
    // Changed by hand meanwhile: another bot whose app id variable is not set.
    p.seed([{ type: 'lark-bot', account: 'other', config: { appId: 'env:AIO_TEST_MISSING_VAR', appSecret: 'env:AIO_TEST_MISSING_VAR' } }]);
    const before = readFileSync(p.cfgPath, 'utf8');
    scan();
    const j = await p.until(id, ['succeeded', 'failed']);
    expect(j).toMatchObject({ state: 'failed', error: { code: 'config_invalid', message: expect.stringContaining('AIO_TEST_MISSING_VAR') } });
    expect(readFileSync(p.cfgPath, 'utf8')).toBe(before);
  });
});
