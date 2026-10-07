import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminLarkBotJob, AdminLarkBotJobState, AdminLarkBotRequest } from '@agents-io/protocol';
import { envRefs, type ConfigStore } from './console-config.js';
import type { LogFn } from './gateway.js';

/*
 * Lark bot provisioning for the console (`POST /api/bots/lark`): runs
 * create-lark-bot as a child process
 *   <command> --qr-out <file> --json --write-env <daemon env file> [--env-prefix LARK_<ACCOUNT>_] --name … --brand … --preset …
 * and follows it: the QR file appears → `waiting_scan` (its content is the QR
 * payload); progress on stderr after that → `configuring`; exit → the `--json`
 * result on stdout (it never carries the app secret) → `succeeded` / `failed` /
 * `expired`. The credentials go only into the env file, under names per account
 * (`default`: LARK_APP_ID / LARK_APP_SECRET / LARK_DOMAIN; `proj-a`:
 * LARK_PROJ_A_APP_ID / …); the daemon never handles them. With `addChannel` the
 * config gets a `lark-bot` channel for the account that references those names
 * explicitly (decision 8: one daemon, several bots), with a verified owner
 * `policy.owners` gets `lark-bot:<union_id>`; both take effect at the next start.
 * The job may wait minutes for a scan, so the config is checked again, as it is
 * then, before anything is written (same account, variable names, a duplicate
 * app, the startup validation).
 */

const FINAL = new Set<AdminLarkBotJobState>(['succeeded', 'failed', 'expired']);
const QR_ART = /[█▀▄▌▐░▒▓]/;
const AVATAR = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/;
/** Channel account names (as harness instance names): they are part of route and session keys. */
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The variables a bot's credentials go to: fixed names for `default`, `LARK_<ACCOUNT>_*` otherwise. */
export function larkEnvNames(account: string): { prefix?: string; appId: string; appSecret: string; domain: string } {
  if (account === 'default') return { appId: 'LARK_APP_ID', appSecret: 'LARK_APP_SECRET', domain: 'LARK_DOMAIN' };
  const prefix = `LARK_${account.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
  return { prefix, appId: `${prefix}APP_ID`, appSecret: `${prefix}APP_SECRET`, domain: `${prefix}DOMAIN` };
}

interface LarkEntry {
  type?: unknown;
  account?: unknown;
  config?: Record<string, unknown>;
}

const larkEntries = (raw: unknown): LarkEntry[] => {
  const channels = (raw as { channels?: unknown } | undefined)?.channels;
  return Array.isArray(channels) ? (channels as LarkEntry[]).filter((c) => c && c.type === 'lark-bot') : [];
};
const accountOf = (c: LarkEntry) => (typeof c.account === 'string' ? c.account : 'default');
/** An entry without explicit appId / appSecret reads the fixed LARK_APP_* variables. */
const fallback = (c: LarkEntry) => c.config?.appId === undefined && c.config?.appSecret === undefined;
/** Variables an entry reads its credentials from. */
const entryVars = (c: LarkEntry): string[] => [...envRefs(c.config ?? {}), ...(fallback(c) ? ['LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_DOMAIN'] : [])];

/** A provisioning step refused against the config as it is now. */
class ProvisionConflict extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LarkBotJobsOptions {
  /** argv of create-lark-bot (config `console.larkBotCommand`). */
  command: string[];
  /** Private work directory for QR and avatar files (0700). */
  dir: string;
  config: ConfigStore;
  log: LogFn;
  /** Environment of the child (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Give up after this long (default 10 min). */
  timeoutMs?: number;
  /** How often the QR file is looked for (default 200 ms). */
  pollMs?: number;
  now?: () => number;
}

interface Job {
  view: AdminLarkBotJob;
  req: AdminLarkBotRequest;
  child?: ChildProcess;
  dir: string;
  timer?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
  stdout: string;
  stderrTail: string;
  qrAnnounced: boolean;
  timedOut: boolean;
}

export type StartOutcome = { ok: true; job: string } | { ok: false; status: 400 | 409; code: string; message: string };

export class LarkBotJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly now: () => number;

  constructor(private readonly o: LarkBotJobsOptions) {
    this.now = o.now ?? Date.now;
  }

  get(id: string): AdminLarkBotJob | undefined {
    const j = this.jobs.get(id);
    return j ? structuredClone(j.view) : undefined;
  }

  start(req: AdminLarkBotRequest): StartOutcome {
    const busy = [...this.jobs.values()].find((j) => !FINAL.has(j.view.state));
    if (busy) return { ok: false, status: 409, code: 'conflict', message: `provisioning job ${busy.view.job} is still ${busy.view.state}` };
    if (!req.name.trim()) return { ok: false, status: 400, code: 'invalid_request', message: 'name is empty' };
    if (req.avatar !== undefined && !AVATAR.test(req.avatar)) return { ok: false, status: 400, code: 'invalid_request', message: 'avatar must be a data:image/(png|jpeg|webp|gif);base64 URI' };
    if (req.presets?.some((p) => !/^[A-Za-z][\w-]*$/.test(p))) return { ok: false, status: 400, code: 'invalid_request', message: 'presets are names (letters, digits, - and _)' };
    const account = req.account ?? 'default';
    if (!ACCOUNT.test(account)) return { ok: false, status: 400, code: 'invalid_request', message: 'account: letters, digits, ".", "_" and "-", starting with a letter or digit (at most 64)' };
    // create-lark-bot writes the credentials into the daemon's env file whether or not the config gets a
    // channel (addChannel): variables already set, or read by another bot, would be silently replaced.
    try {
      this.checkAccount(this.o.config.read().raw, account);
    } catch (e) {
      if (!(e instanceof ProvisionConflict)) throw e;
      return { ok: false, status: 409, code: 'conflict', message: e.message };
    }
    const names = larkEnvNames(account);
    const taken = this.o.config.defined([names.appId, names.appSecret, names.domain]);
    if (taken.length)
      return { ok: false, status: 409, code: 'conflict', message: `${taken.join(', ')} ${taken.length > 1 ? 'are' : 'is'} already set (env file ${this.o.config.envFilePath()} or the environment); a new bot would replace those credentials. Remove them first` };
    const id = `lark_${randomUUID()}`;
    const dir = join(this.o.dir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const t = this.now();
    const job: Job = {
      view: { job: id, state: 'starting', message: 'starting create-lark-bot', createdAt: t, updatedAt: t },
      req: { ...req, account },
      dir,
      stdout: '',
      stderrTail: '',
      qrAnnounced: false,
      timedOut: false,
    };
    this.jobs.set(id, job);
    try {
      this.spawn(job);
    } catch (e) {
      this.finish(job, 'failed', { error: { code: 'spawn_failed', message: (e as Error).message } });
    }
    return { ok: true, job: id };
  }

  /**
   * The account against the config (at start, and again before writing): no
   * lark-bot entry with the same account, none reading the variables this one's
   * credentials go to (e.g. `proj-a` and `proj_a` share LARK_PROJ_A_*).
   */
  private checkAccount(raw: unknown, account: string): void {
    const entries = larkEntries(raw);
    if (entries.some((c) => accountOf(c) === account))
      throw new ProvisionConflict('conflict', `a lark-bot channel with account ${account} is already configured; provision another account, or remove it first`);
    const names = larkEnvNames(account);
    const mine = new Set([names.appId, names.appSecret, names.domain]);
    for (const c of entries) {
      const shared = entryVars(c).filter((v) => mine.has(v));
      if (shared.length) throw new ProvisionConflict('conflict', `the lark-bot channel with account ${accountOf(c)} reads ${[...new Set(shared)].join(', ')}, where account ${account}'s credentials would go; choose another account name`);
    }
  }

  /** The app id an entry runs (its explicit appId, `env:` resolved, or LARK_APP_ID for a fallback entry). */
  private appIdOf(c: LarkEntry): string | undefined {
    const v = fallback(c) ? 'env:LARK_APP_ID' : c.config?.appId;
    if (typeof v !== 'string') return undefined;
    return v.startsWith('env:') ? this.o.config.lookup(v.slice(4)) : v;
  }

  private args(job: Job): string[] {
    const r = job.req;
    const a = ['--qr-out', join(job.dir, 'qr.txt'), '--json', '--write-env', this.o.config.envFilePath(), '--name', r.name, '--brand', r.domain ?? 'feishu', '--preset', (r.presets ?? ['messaging', 'contact']).join(',')];
    const prefix = larkEnvNames(r.account ?? 'default').prefix;
    if (prefix) a.push('--env-prefix', prefix);
    if (r.avatar !== undefined) a.push('--avatar', this.avatarFile(job.dir, r.avatar));
    if (r.owner === false) a.push('--no-owner');
    return a;
  }

  /** A `data:` URI avatar as a file for `--avatar`. */
  private avatarFile(dir: string, uri: string): string {
    const m = AVATAR.exec(uri);
    if (!m) throw new Error('avatar must be a data:image/(png|jpeg|webp|gif);base64 URI');
    const file = join(dir, `avatar.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    writeFileSync(file, Buffer.from(m[2]!, 'base64'), { mode: 0o600 });
    return file;
  }

  private spawn(job: Job): void {
    const [cmd, ...pre] = this.o.command;
    const child = spawn(cmd!, [...pre, ...this.args(job)], { cwd: job.dir, env: this.o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    job.child = child;
    this.o.log('info', `lark bot job ${job.view.job}: started create-lark-bot (pid ${child.pid ?? '?'})`);
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (s: string) => {
      if (job.stdout.length < 1_000_000) job.stdout += s;
    });
    child.stderr!.on('data', (s: string) => this.onStderr(job, s));
    child.on('error', (e) => this.finish(job, 'failed', { error: { code: 'spawn_failed', message: e.message } }));
    child.on('close', (code) => this.onExit(job, code));
    job.timer = setInterval(() => this.pollQr(job), this.o.pollMs ?? 200);
    job.timer.unref?.();
    job.deadline = setTimeout(() => {
      job.timedOut = true;
      child.kill('SIGTERM');
    }, this.o.timeoutMs ?? 600_000);
    job.deadline.unref?.();
  }

  private pollQr(job: Job): void {
    if (FINAL.has(job.view.state)) return;
    const file = join(job.dir, 'qr.txt');
    if (!existsSync(file)) return;
    let payload: string;
    try {
      payload = readFileSync(file, 'utf8').trim();
    } catch {
      return;
    }
    if (!payload || payload === job.view.qr?.payload) return;
    // A new QR (a second scan, or a fresh one after a retry) means: waiting for a scan again.
    this.set(job, { state: 'waiting_scan', qr: { payload }, message: 'scan the QR code with the Feishu / Lark app' });
  }

  private onStderr(job: Job, s: string): void {
    job.stderrTail = (job.stderrTail + s).slice(-4000);
    for (const raw of s.split('\n')) {
      const line = raw.trim();
      if (!line || QR_ART.test(line)) continue;
      // The QR announcement and the "waiting" status keep the job waiting; anything after a scan is progress.
      if (/二维码内容已写入|请用飞书 App 扫码|等待飞书扫码/.test(line)) {
        job.qrAnnounced = true;
        this.pollQr(job);
        continue;
      }
      const progress = /已经扫码|等待手机确认|正在|创建|配置|发布|版本|权限|事件|owner|凭证/.test(line);
      if (progress && job.view.state !== 'configuring' && !FINAL.has(job.view.state)) this.set(job, { state: 'configuring', message: clean(line) });
      else if (!FINAL.has(job.view.state)) this.set(job, { message: clean(line) });
    }
  }

  private onExit(job: Job, code: number | null): void {
    if (FINAL.has(job.view.state)) return;
    this.pollQr(job);
    const result = lastJson(job.stdout) as CreateResult | undefined;
    if (!result) {
      if (job.timedOut) return this.finish(job, job.view.state === 'waiting_scan' ? 'expired' : 'failed', { error: { code: 'timeout', message: 'create-lark-bot did not finish in time' } });
      return this.finish(job, 'failed', { error: { code: 'no_result', message: `create-lark-bot exited with ${code ?? 'a signal'} without a result${tailHint(job.stderrTail)}` } });
    }
    if (!result.ok) {
      const expired = /expired|过期|timeout/i.test(`${result.error ?? ''} ${result.message ?? ''}`);
      return this.finish(job, expired ? 'expired' : 'failed', {
        error: { code: String(result.error ?? 'failed'), message: clean(`${result.stage ? `${result.stage}: ` : ''}${result.message ?? 'create-lark-bot failed'}`) },
        ...(result.appId ? { message: `app ${result.appId} was created but not finished; run create-lark-bot update --app-id ${result.appId}` } : {}),
      });
    }
    try {
      this.succeed(job, result, code);
    } catch (e) {
      this.finish(job, 'failed', { error: { code: 'config_write_failed', message: `the app ${result.appId} was created and its credentials written to the env file, but updating the config failed: ${(e as Error).message}` } });
    }
  }

  private succeed(job: Job, r: CreateResult & { ok: true }, code: number | null): void {
    const req = job.req;
    const account = req.account ?? 'default';
    const domain: 'feishu' | 'lark' = r.brand === 'lark' ? 'lark' : 'feishu';
    const unionId = r.owner?.verified?.unionId ? r.owner.unionId : undefined;
    const owner = req.owner !== false && unionId ? `lark-bot:${unionId}` : undefined;
    const addChannel = req.addChannel !== false;
    const names = larkEnvNames(account);
    const env = { appId: `env:${names.appId}`, appSecret: `env:${names.appSecret}`, domain: `env:${names.domain}` };
    if (addChannel || owner) {
      // The credentials are in the env file by now; if the config is not written they stay there, unreferenced.
      const left = `the credentials were written to ${this.o.config.envFilePath()} as ${names.appId}, ${names.appSecret}, ${names.domain}; no channel references them: remove them by hand (provisioning account ${account} again is refused while they are set)`;
      let w: ReturnType<ConfigStore['updateValidated']>;
      try {
        w = this.o.config.updateValidated((raw) => {
          if (addChannel) {
            // Checked again as the config is now: it may have changed while the job waited for a scan.
            this.checkAccount(raw, account);
            const dup = larkEntries(raw).find((c) => this.appIdOf(c) === r.appId);
            if (dup) throw new ProvisionConflict('duplicate_app', `app ${r.appId} is already the lark-bot channel with account ${accountOf(dup)}; one app runs one channel`);
            const channels = Array.isArray(raw.channels) ? (raw.channels as unknown[]) : [];
            raw.channels = [...channels, { type: 'lark-bot', ...(account !== 'default' ? { account } : {}), config: { ...env } }];
          }
          if (owner) {
            const policy = (raw.policy && typeof raw.policy === 'object' ? raw.policy : {}) as { owners?: string[] };
            if (!(policy.owners ?? []).includes(owner)) raw.policy = { ...policy, owners: [...(policy.owners ?? []), owner] };
          }
          return raw;
        });
      } catch (e) {
        if (!(e instanceof ProvisionConflict)) throw e;
        return this.finish(job, 'failed', { error: { code: e.code, message: `${e.message}; ${left}` } });
      }
      if (!w.ok) {
        const issues = w.issues.map((i) => `${i.path || '/'}: ${i.message}`).join('; ');
        return this.finish(job, 'failed', { error: { code: 'config_invalid', message: `the config with this bot would not load (${issues}); nothing was written; ${left}` } });
      }
    }
    const incomplete = code === 3 || r.configuration?.ok === false;
    const consoleUrl = `https://open.${domain === 'lark' ? 'larksuite.com' : 'feishu.cn'}/app/${r.appId}`;
    const warnings = r.warnings?.length ? ` (${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''})` : '';
    this.finish(job, 'succeeded', {
      message: incomplete ? `app created; the console configuration is not complete: finish it in the developer console${warnings}` : `app created and configured${warnings}; restart the daemon to start the channel`,
      result: {
        appId: r.appId,
        domain,
        ...(r.identity?.name ? { botName: r.identity.name } : {}),
        account,
        env,
        ...(owner ? { owner } : {}),
        channelAdded: addChannel,
        ...(incomplete ? { consoleUrl } : {}),
      },
    });
  }

  private set(job: Job, patch: Partial<AdminLarkBotJob>): void {
    job.view = { ...job.view, ...patch, updatedAt: this.now() };
  }

  private finish(job: Job, state: AdminLarkBotJobState, patch: Partial<AdminLarkBotJob>): void {
    if (FINAL.has(job.view.state)) return;
    clearInterval(job.timer);
    clearTimeout(job.deadline);
    const { qr: _qr, ...rest } = job.view;
    job.view = { ...rest, ...patch, state, updatedAt: this.now() };
    if (state !== 'succeeded' && !patch.message) delete job.view.message;
    this.o.log(state === 'succeeded' ? 'info' : 'warn', `lark bot job ${job.view.job}: ${state}${job.view.error ? ` (${job.view.error.code})` : ''}`);
    if (job.child && job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGTERM');
    rmSync(job.dir, { recursive: true, force: true });
  }

  /** Stop every running child (daemon stop). */
  close(): void {
    for (const j of this.jobs.values()) if (!FINAL.has(j.view.state)) this.finish(j, 'failed', { error: { code: 'stopped', message: 'the daemon stopped' } });
  }
}

/** The `--json` result of create-lark-bot (secret-free by construction; only the fields used here). */
type CreateResult =
  | {
      ok: true;
      appId: string;
      brand?: string;
      identity?: { name?: string };
      owner?: { unionId?: string; verified?: { unionId?: boolean } };
      configuration?: { ok?: boolean };
      warnings?: string[];
    }
  | { ok: false; stage?: string; error?: string; message?: string; appId?: string };

/** The last top-level JSON object in a stream (create-lark-bot prints one, pretty-printed). */
function lastJson(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    // something else was printed before it: take the last line that starts an object
  }
  const lines = t.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** One progress line for the UI: short, no long token-like runs. */
function clean(s: string): string {
  const t = s.replace(/[A-Za-z0-9_\-+/=]{32,}/g, '…').replace(/\s+/g, ' ').trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

function tailHint(tail: string): string {
  const last = tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !QR_ART.test(l))
    .at(-1);
  return last ? `: ${clean(last)}` : '';
}
