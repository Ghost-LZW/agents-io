// A stand-in for create-lark-bot (--qr-out <file> --json --write-env <file> …), for the provisioning tests.
// FAKE_MODE: ok (default) | expire | crash | incomplete. It waits for `<qr file>.scanned` before "configuring".
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const qr = arg('--qr-out');
const envFile = arg('--write-env');
const mode = process.env.FAKE_MODE ?? 'ok';
const log = (s) => process.stderr.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.FAKE_ARGS_OUT) writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify(argv));
log('   等待飞书扫码');
log('\n请用飞书 App 扫码登录飞书开放平台（创建 / 配置应用只需这一次）：\n');
log('█▀▀▀▀▀█ ▄▄ █▀▀▀▀▀█');
writeFileSync(qr, JSON.stringify({ qrlogin: { token: 'fake-qr-token' } }) + '\n', { mode: 0o600 });
log(`二维码内容已写入 ${qr}`);

if (mode === 'expire') {
  await sleep(100);
  log('   二维码已过期');
  process.stdout.write(JSON.stringify({ ok: false, stage: 'create', error: 'qr_expired', message: '二维码已过期' }, null, 2) + '\n');
  process.exit(1);
}
if (mode === 'crash') {
  await sleep(50);
  log('boom: something broke');
  process.exit(7);
}

while (!existsSync(`${qr}.scanned`)) await sleep(20);
log('   已经扫码，等待手机确认');
log('   正在创建应用「' + arg('--name') + '」…');
await sleep(50);
writeFileSync(envFile, '# kept\nOTHER=1\n', { flag: 'a', mode: 0o600 });
appendFileSync(envFile, 'LARK_APP_ID=cli_fake123\nLARK_APP_SECRET=very-secret-value\nLARK_DOMAIN=feishu\n');
const owner = argv.includes('--no-owner') ? {} : { owner: { unionId: 'on_owner1', openId: 'ou_x', verified: { unionId: true, openId: false }, status: 'verified' } };
process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      appId: 'cli_fake123',
      brand: arg('--brand') ?? 'feishu',
      source: 'console',
      identity: { name: arg('--name') },
      ...owner,
      configuration: { ok: mode !== 'incomplete' },
      warnings: [],
      envFile,
    },
    null,
    2,
  ) + '\n',
);
process.exit(mode === 'incomplete' ? 3 : 0);
