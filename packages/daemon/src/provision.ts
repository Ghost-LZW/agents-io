import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminLarkBotJob, AdminLarkBotJobState, AdminLarkBotRequest } from '@agents-io/protocol';
import type { ConfigStore } from './console-config.js';
import type { LogFn } from './gateway.js';

/*
 * Lark bot provisioning for the console (`POST /api/bots/lark`): runs
 * create-lark-bot as a child process
 *   <command> --qr-out <file> --json --write-env <daemon env file> --name … --brand … --preset …
 * and follows it: the QR file appears → `waiting_scan` (its content is the QR
 * payload); progress on stderr after that → `configuring`; exit → the `--json`
 * result on stdout (it never carries the app secret) → `succeeded` / `failed` /
 * `expired`. The credentials go only into the env file (LARK_APP_ID /
 * LARK_APP_SECRET / LARK_DOMAIN, which the lark-bot channel reads); the job
 * shows their `env:NAME` references. With `addChannel` the config gets a
 * `lark-bot` channel, with a verified owner `policy.owners` gets
 * `lark-bot:<union_id>`; both take effect at the next start.
 */

const FINAL = new Set<AdminLarkBotJobState>(['succeeded', 'failed', 'expired']);
const QR_ART = /[█▀▄▌▐░▒▓]/;
const AVATAR = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/;

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
    // create-lark-bot always writes LARK_APP_ID / LARK_APP_SECRET into the daemon's env file, whether or not the
    // config gets a channel (addChannel): with a bot already there, that would silently replace its credentials.
    const raw = this.o.config.read().raw as { channels?: { type?: string; account?: string }[] };
    const existing = (raw.channels ?? []).find((c) => c.type === 'lark-bot');
    if (existing)
      return { ok: false, status: 409, code: 'conflict', message: `a lark-bot channel (account ${existing.account ?? 'default'}) is already configured; its credentials (LARK_APP_ID, LARK_APP_SECRET) would be replaced. Remove it first` };
    const taken = this.o.config.defined(['LARK_APP_ID', 'LARK_APP_SECRET']);
    if (taken.length)
      return { ok: false, status: 409, code: 'conflict', message: `${taken.join(' and ')} ${taken.length > 1 ? 'are' : 'is'} already set (env file ${this.o.config.envFilePath()} or the environment); a new bot would replace those credentials. Remove them first` };
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

  private args(job: Job): string[] {
    const r = job.req;
    const a = ['--qr-out', join(job.dir, 'qr.txt'), '--json', '--write-env', this.o.config.envFilePath(), '--name', r.name, '--brand', r.domain ?? 'feishu', '--preset', (r.presets ?? ['messaging', 'contact']).join(',')];
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
    if (addChannel || owner) {
      this.o.config.update((raw) => {
        if (addChannel) {
          const channels = Array.isArray(raw.channels) ? (raw.channels as { type?: string }[]) : [];
          if (!channels.some((c) => c.type === 'lark-bot')) raw.channels = [...channels, { type: 'lark-bot', ...(account !== 'default' ? { account } : {}) }];
        }
        if (owner) {
          const policy = (raw.policy && typeof raw.policy === 'object' ? raw.policy : {}) as { owners?: string[] };
          if (!(policy.owners ?? []).includes(owner)) raw.policy = { ...policy, owners: [...(policy.owners ?? []), owner] };
        }
        return raw;
      });
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
        env: { appId: 'env:LARK_APP_ID', appSecret: 'env:LARK_APP_SECRET', domain: 'env:LARK_DOMAIN' },
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
