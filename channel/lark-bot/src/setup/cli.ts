#!/usr/bin/env node
import { parseArgs } from 'node:util';
import qrcode from 'qrcode-terminal';
import { defaultLarkDeps } from '../sdk.js';
import { createLarkBot, LarkSetupError, updateLarkBot, type CreateDeps, type LarkBotCredentials } from './create.js';
import { defaultCredentialsPath, readCredentials, updateEnvFile, writeCredentials, type StoredCredentials } from './files.js';
import { resolveOwner } from './owner.js';
import type { Brand } from './requirements.js';
import { verifyLarkBot, type VerifyDeps, type VerifyReport } from './verify.js';

const USAGE = `agents-io-lark <command>

  create  [--name <tpl>] [--brand feishu|lark] [--write-env <file>] [--write-credentials <path>]
          Scan a QR code to create a bot app. Default output: ~/.config/agents-io/lark/<appId>.json (0600).
  update  --app-id <cli_xxx> [--brand ...] [--write-env <file>] [--write-credentials <path>]
          Re-authorize the scope/event diff on an existing app.
  verify  [--live] [--credentials <path> | --app-id <id>] [--brand ...] [--json]
          Check credentials, bot capability, scopes (and a WebSocket probe with --live).
          Without a file, reads LARK_APP_ID / LARK_APP_SECRET / LARK_DOMAIN.
  owner   --open-id <ou_xxx> [--credentials <path> | --app-id <id>]
          Resolve an open_id to the owner principal key through the app itself.
`;

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  deps?: CreateDeps & VerifyDeps;
  /** Render the QR code (stderr). */
  qr?: (url: string) => void;
}

const brandOf = (v: string | undefined): Brand | undefined => {
  if (v === undefined) return undefined;
  if (v !== 'feishu' && v !== 'lark') throw new Error(`--brand must be feishu or lark, got ${v}`);
  return v;
};

function loadCreds(v: { credentials?: string; 'app-id'?: string; brand?: string }, env: NodeJS.ProcessEnv): StoredCredentials {
  const path = v.credentials ?? (v['app-id'] ? defaultCredentialsPath(v['app-id']) : undefined);
  if (path) return readCredentials(path);
  const appId = env.LARK_APP_ID;
  const appSecret = env.LARK_APP_SECRET;
  if (!appId || !appSecret) throw new Error('no credentials: pass --credentials/--app-id or set LARK_APP_ID and LARK_APP_SECRET');
  return { appId, appSecret, brand: brandOf(v.brand) ?? (env.LARK_DOMAIN === 'lark' ? 'lark' : 'feishu') };
}

function printReport(r: VerifyReport, out: (s: string) => void): void {
  out(`app ${r.appId} (${r.brand}): ${r.ok ? 'OK' : 'PROBLEMS FOUND'}`);
  for (const c of r.checks) out(`  [${c.status}] ${c.id}: ${c.detail}${c.link ? `\n         ${c.link}` : ''}`);
  if (r.missingScopes.length) {
    out(`\nMissing scopes: apply them at ${r.links.scopes}`);
    out('If the console offers batch import, paste this JSON:');
    out(JSON.stringify(r.scopesJson, null, 2));
  }
}

async function persist(c: LarkBotCredentials, owner: string | undefined, values: { 'write-env'?: string; 'write-credentials'?: string }, io: CliIO): Promise<void> {
  const stored: StoredCredentials = { appId: c.appId, appSecret: c.appSecret, brand: c.brand, ...(owner ? { owner } : {}) };
  if (values['write-env']) {
    updateEnvFile(values['write-env'], {
      LARK_APP_ID: c.appId,
      LARK_APP_SECRET: c.appSecret,
      LARK_DOMAIN: c.brand,
      AGENTS_IO_OWNERS: owner,
    });
    io.out(`updated ${values['write-env']} (LARK_APP_ID, LARK_APP_SECRET, LARK_DOMAIN${owner ? ', AGENTS_IO_OWNERS' : ''})`);
  }
  if (values['write-credentials'] || !values['write-env']) {
    const path = values['write-credentials'] ?? defaultCredentialsPath(c.appId);
    writeCredentials(path, stored);
    io.out(`credentials written to ${path} (mode 0600)`);
  }
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    io.err(USAGE);
    return cmd ? 0 : 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string' },
      brand: { type: 'string' },
      'app-id': { type: 'string' },
      'write-env': { type: 'string' },
      'write-credentials': { type: 'string' },
      credentials: { type: 'string' },
      'open-id': { type: 'string' },
      live: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const brand = brandOf(values.brand);
  const qr = io.qr ?? ((url: string) => qrcode.generate(url, { small: true }, (s: string) => io.err(s)));

  try {
    if (cmd === 'create' || cmd === 'update') {
      if (cmd === 'update' && !values['app-id']) throw new Error('update needs --app-id');
      const base = {
        ...(values.name ? { name: values.name } : {}),
        ...(brand ? { brand } : {}),
        ...(io.signal ? { signal: io.signal } : {}),
        onQRCode: (info: { url: string; expireIn: number }) => {
          io.err(`Scan with the Feishu/Lark app (expires in ${info.expireIn}s):`);
          qr(info.url);
          io.err(info.url);
        },
        onStatus: (s: { status: string }) => io.err(`status: ${s.status}`),
      };
      const c =
        cmd === 'create'
          ? await createLarkBot(base, io.deps ?? {})
          : await updateLarkBot({ ...base, appId: values['app-id']! }, io.deps ?? {});

      let owner: string | undefined;
      if (c.ownerOpenId) {
        const client = (io.deps?.createClient ?? defaultLarkDeps.createClient)({ appId: c.appId, appSecret: c.appSecret, domain: c.brand });
        const r = await resolveOwner(client, c.ownerOpenId);
        if (r.ok) owner = r.key;
        else io.err(`owner not resolved (${r.reason}); AGENTS_IO_OWNERS left unset. Grant contact:user.base:readonly, then run: agents-io-lark owner --open-id ${c.ownerOpenId} --app-id ${c.appId}`);
      }
      await persist(c, owner, values, io);
      io.out(`app ${c.appId} (${c.brand})${owner ? `, owner ${owner}` : ''}`);
      io.out(`next: agents-io-lark verify --app-id ${c.appId} --live`);
      return 0;
    }

    if (cmd === 'verify') {
      const c = loadCreds(values, io.env);
      const report = await verifyLarkBot(
        { appId: c.appId, appSecret: c.appSecret, brand: brandOf(values.brand) ?? c.brand, live: !!values.live },
        io.deps ?? {},
      );
      if (values.json) io.out(JSON.stringify(report, null, 2));
      else printReport(report, io.out);
      return report.ok ? 0 : 1;
    }

    if (cmd === 'owner') {
      if (!values['open-id']) throw new Error('owner needs --open-id');
      const c = loadCreds(values, io.env);
      const client = (io.deps?.createClient ?? defaultLarkDeps.createClient)({ appId: c.appId, appSecret: c.appSecret, domain: c.brand });
      const r = await resolveOwner(client, values['open-id']);
      if (!r.ok) {
        io.err(`could not verify owner: ${r.reason}`);
        return 1;
      }
      io.out(r.key);
      return 0;
    }

    io.err(`unknown command: ${cmd}\n${USAGE}`);
    return 2;
  } catch (e) {
    io.err(e instanceof LarkSetupError ? `${e.reason}: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('agents-io-lark')) {
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  main(process.argv.slice(2), {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    env: process.env,
    signal: ac.signal,
  }).then((code) => process.exit(code));
}
