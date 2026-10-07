import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { HarnessAdapter, HarnessCaps, HarnessOpenArgs, HarnessSession } from '@agents-io/protocol';
import type { ClientInfo } from './generated/ClientInfo.js';
import type { InitializeParams } from './generated/InitializeParams.js';
import type { InitializeResponse } from './generated/InitializeResponse.js';
import type { RequestId } from './generated/RequestId.js';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams.js';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse.js';
import type { ThreadResumeParams } from './generated/v2/ThreadResumeParams.js';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse.js';
import type { JsonValue } from './generated/serde_json/JsonValue.js';
import { CODEX_CAPS, DEFAULT_OPT_OUT } from './caps.js';
import { resolveProfile, sandboxModeOf, type CodexProfile, type MediaResolver } from './map.js';
import { RpcClient, spawnTransport, type Transport } from './rpc.js';
import { CodexSession, type CodexOpenOptions, type SessionHost, type TurnSnapshot } from './session.js';
import {
  assertPrivateSocket,
  connectUnix,
  defaultCodexSocket,
  defaultStateDir,
  ensureOwnServer,
  ensurePrivateDir,
  readJson,
  removeFile,
  startDaemon,
  stopOwnServer,
  writeJson,
} from './unix.js';
import { assertSupportedVersion, versionFromUserAgent } from './version.js';

export { CODEX_CAPS, DEFAULT_OPT_OUT };

/**
 * How to reach `codex app-server`.
 * - `stdio`: a child process tied to this host (dies with it).
 * - `unix`: WebSocket over a Unix socket to a server that outlives the host.
 *   `spawn: 'own'` starts (or reattaches to, via `stateDir/server.json`) a detached
 *   `codex app-server --listen unix://PATH`; `'daemon'` uses `codex app-server daemon
 *   start` (shared by every Codex client, needs the standalone install, never
 *   stopped by us); `'none'` only connects (default path:
 *   `$CODEX_HOME/app-server-control/app-server-control.sock`, the daemon's socket).
 */
export type CodexTransportOption =
  | { kind: 'stdio' }
  | {
      kind: 'unix';
      spawn: 'own' | 'daemon' | 'none';
      path?: string;
      /** Socket (own), server record and running-turn snapshots. Default `~/.agents-io/codex`, created 0700. */
      stateDir?: string;
      /** How long to keep trying to reconnect after the connection drops (default 60s). */
      reconnectWindowMs?: number;
      /** Skip the owner/0600/0700 check on the socket. Any client on the socket can answer approvals. */
      allowInsecureSocket?: boolean;
    };

export interface CodexHarnessOptions {
  /** codex binary (default `codex`). */
  bin?: string;
  /** Arguments after the binary for stdio (default `['app-server']`); launch flags are appended. */
  args?: string[];
  /** Environment for the app-server, over `process.env` (an `undefined` value removes the variable). */
  env?: NodeJS.ProcessEnv;
  /**
   * `CODEX_HOME` (default `~/.codex`): config.toml, auth, sessions, skills.
   * Wins over `env.CODEX_HOME`. Each distinct home needs its own app-server.
   */
  codexHome?: string;
  /**
   * Config overrides for the app-server process: dotted key → value, passed as
   * `-c key=<TOML value>` (strings quoted, arrays/objects as inline TOML).
   * Only for servers this adapter starts (stdio, unix `own`). These are on the
   * command line, so secret-looking settings are refused: give secrets through
   * `env` and Codex's env-var indirection (`env_key`, `bearer_token_env_var`,
   * `env_http_headers`, `env_vars`).
   */
  config?: Record<string, unknown>;
  /** Features to turn on/off (`--enable NAME` / `--disable NAME`). Same restriction as `config`. */
  enable?: string[];
  disable?: string[];
  /** Transport (default stdio), or a factory for a custom one (tests). */
  transport?: CodexTransportOption | (() => Transport | Promise<Transport>);
  clientInfo?: ClientInfo;
  /** Run against a codex version outside SUPPORTED_CODEX_LINES. */
  allowUnknownVersion?: boolean;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Notification methods this connection never wants (sent in initialize). */
  optOutNotificationMethods?: string[];
  /** Defaults for every session; `HarnessOpenArgs.options` overrides per session. */
  profiles?: Record<string, CodexProfile>;
  resolveMedia?: MediaResolver;
}

interface Buffered {
  kind: 'n' | 'r';
  id?: RequestId;
  method: string;
  params: unknown;
}

interface Connector {
  open(): Promise<Transport>;
  /** Reconnect after a dropped connection instead of failing the sessions (the server outlives connections). */
  reconnect: boolean;
  reconnectWindowMs: number;
  /** Where running-turn snapshots live, for transports whose server outlives the host. */
  turnsDir?: string;
  /** Stop the server once no session uses it (stdio child only). */
  stopWhenIdle: boolean;
}

/** `env` over process.env, `CODEX_HOME` from `codexHome`, undefined values removed. */
export function codexEnv(opts: Pick<CodexHarnessOptions, 'env' | 'codexHome'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, ...(opts.codexHome ? { CODEX_HOME: opts.codexHome } : {}) };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

const SEG = String.raw`(?:[A-Za-z0-9_][A-Za-z0-9_-]*|"[^"\\]*")`;
const KEY = new RegExp(String.raw`^${SEG}(?:\.${SEG})*$`);
const FEATURE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** A JSON value as an inline TOML value (what `codex -c key=value` parses). */
export function tomlValue(v: unknown, where = 'value'): string {
  if (typeof v === 'string') return JSON.stringify(v); // JSON string escapes are valid TOML basic-string escapes
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${where}: TOML has no ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map((x, i) => tomlValue(x, `${where}[${i}]`)).join(', ')}]`;
  if (v && typeof v === 'object') {
    const parts = Object.entries(v).map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${tomlValue(x, `${where}.${k}`)}`);
    return `{ ${parts.join(', ')} }`;
  }
  throw new Error(`${where}: ${v === null ? 'null' : typeof v} cannot be written as TOML`);
}

/** Names that hold a secret value (`GITHUB_TOKEN`, `Authorization`, `experimental_bearer_token`, `X-Api-Key`…). */
const SECRET = /(^|[_-])(token|secret|password|passwd|api[_-]?key|authorization|credentials?|cookie)$/i;
/** Names whose values are environment variable names, not secrets (`env_key`, `env_http_headers`, `bearer_token_env_var`). */
const ENV_REF = /^env_|_env_var$/i;

/** The dotted path of the first secret-looking setting under `segs`/`v`, if any. */
function secretAt(segs: string[], v: unknown): string | undefined {
  for (const [i, raw] of segs.entries()) {
    const seg = raw.replace(/^"|"$/g, '');
    if (ENV_REF.test(seg)) return undefined;
    if (SECRET.test(seg)) return segs.slice(0, i + 1).join('.');
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) {
      const hit = secretAt([...segs, k], x);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * `-c key=value`, `--enable`, `--disable` flags for `codex app-server`. Throws on keys/names
 * codex would misparse, and on secret-looking settings: argv is readable by other local users.
 */
export function launchFlags(opts: Pick<CodexHarnessOptions, 'config' | 'enable' | 'disable'>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(opts.config ?? {})) {
    if (!KEY.test(k)) throw new Error(`@agents-io/harness-codex: config key ${JSON.stringify(k)} is not a dotted TOML key`);
    const secret = secretAt(k.match(new RegExp(SEG, 'g')) ?? [k], v);
    if (secret) {
      throw new Error(
        `@agents-io/harness-codex: config ${secret} looks like a secret; -c values are on the app-server command line (visible via ps). ` +
          'Pass it through `env` and name the variable instead (env_key, bearer_token_env_var, env_http_headers, env_vars), or put it in CODEX_HOME/config.toml',
      );
    }
    out.push('-c', `${k}=${tomlValue(v, `config.${k}`)}`);
  }
  for (const [flag, names] of [['--enable', opts.enable], ['--disable', opts.disable]] as const) {
    for (const n of names ?? []) {
      if (!FEATURE.test(n)) throw new Error(`@agents-io/harness-codex: feature name ${JSON.stringify(n)} is invalid`);
      out.push(flag, n);
    }
  }
  return out;
}

function makeConnector(opts: CodexHarnessOptions): Connector {
  const t = opts.transport;
  const bin = opts.bin ?? 'codex';
  const env = codexEnv(opts);
  const flags = launchFlags(opts);
  if (typeof t === 'function') return { open: async () => t(), reconnect: false, reconnectWindowMs: 0, stopWhenIdle: true };
  if (!t || t.kind === 'stdio') {
    return {
      open: async () => spawnTransport({ bin, args: [...(opts.args ?? ['app-server']), ...flags], env }),
      reconnect: false,
      reconnectWindowMs: 0,
      stopWhenIdle: true,
    };
  }
  if (t.spawn !== 'own' && flags.length)
    throw new Error(`@agents-io/harness-codex: config/enable/disable need a server this adapter starts (stdio or unix spawn 'own'), not unix spawn '${t.spawn}'`);
  const stateDir = t.stateDir ?? defaultStateDir();
  // Identifies how the server was launched, so a host never reattaches to one started for other settings.
  const launch = createHash('sha256').update(JSON.stringify([bin, env.CODEX_HOME ?? '', flags])).digest('hex').slice(0, 16);
  const open = async (): Promise<Transport> => {
    let path: string;
    if (t.spawn === 'own') path = (await ensureOwnServer({ stateDir, socket: t.path, bin, env, args: flags, launch })).socket;
    else if (t.spawn === 'daemon') path = t.path ?? (await startDaemon(bin, env)).socket;
    else path = t.path ?? defaultCodexSocket(env);
    if (!t.allowInsecureSocket) assertPrivateSocket(path);
    return connectUnix(path, opts.handshakeTimeoutMs ?? 10_000);
  };
  return { open, reconnect: true, reconnectWindowMs: t.reconnectWindowMs ?? 60_000, turnsDir: join(stateDir, 'turns'), stopWhenIdle: false };
}

async function handshake(transport: Transport, opts: CodexHarnessOptions): Promise<{ rpc: RpcClient; init: InitializeResponse; version: string }> {
  const rpc = new RpcClient(transport, opts.requestTimeoutMs ?? 120_000);
  try {
    const params: InitializeParams = {
      clientInfo: opts.clientInfo ?? { name: 'agents_io', title: 'agents-io', version: '0.1.0' },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: opts.optOutNotificationMethods ?? DEFAULT_OPT_OUT,
      },
    };
    const init = await rpc.request<InitializeResponse>('initialize', params, opts.handshakeTimeoutMs ?? 30_000);
    const version = versionFromUserAgent(init.userAgent);
    assertSupportedVersion(version, opts.allowUnknownVersion);
    rpc.notify('initialized');
    return { rpc, init, version: version! };
  } catch (e) {
    rpc.close();
    const tail = 'stderrTail' in transport ? (transport as { stderrTail(): string }).stderrTail().trim() : '';
    if (tail && e instanceof Error && !e.message.includes(tail)) e.message += `\n--- codex stderr ---\n${tail.slice(-1500)}`;
    throw e;
  }
}

/** One app-server and our initialized connection to it, shared by all sessions of a CodexHarness. */
class AppServer implements SessionHost {
  readonly sessions = new Map<string, CodexSession>();
  /** Thread events that arrive before the session registers (thread/start response and notifications share a chunk). */
  private early = new Map<string, Buffered[]>();
  private closing = false;
  private deadCbs: (() => void)[] = [];
  rpc!: RpcClient;
  version!: string;
  init!: InitializeResponse;

  private constructor(
    private readonly connector: Connector,
    private readonly opts: CodexHarnessOptions,
    private readonly onEmpty: (s: AppServer) => void,
  ) {}

  static async start(connector: Connector, opts: CodexHarnessOptions, onEmpty: (s: AppServer) => void): Promise<AppServer> {
    const s = new AppServer(connector, opts, onEmpty);
    s.attach(await handshake(await connector.open(), opts));
    return s;
  }

  /** The server is gone for good (no reconnect, or reconnect gave up). */
  onDead(cb: () => void): void {
    this.deadCbs.push(cb);
  }

  private attach(h: { rpc: RpcClient; init: InitializeResponse; version: string }): void {
    this.rpc = h.rpc;
    this.init = h.init;
    this.version = h.version;
    const rpc = h.rpc;
    rpc.onNotification((method, params) => this.route({ kind: 'n', method, params }));
    rpc.onServerRequest((id, method, params) => this.route({ kind: 'r', id, method, params }));
    rpc.onClose((reason) => {
      if (this.rpc !== rpc) return;
      if (this.closing || !this.connector.reconnect) return this.fail(reason);
      void this.reconnect(reason);
    });
  }

  /** New connection to the same server: initialize again, then every session rejoins its thread. */
  private async reconnect(reason: string): Promise<void> {
    const until = Date.now() + this.connector.reconnectWindowMs;
    let wait = 200;
    let last = reason;
    while (!this.closing && Date.now() < until) {
      try {
        this.attach(await handshake(await this.connector.open(), this.opts));
        for (const s of [...this.sessions.values()]) {
          await s.reattach().catch((e: Error) => s.transportClosed(`reattach failed: ${e.message}`));
        }
        return;
      } catch (e) {
        last = (e as Error).message;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 5000);
      }
    }
    if (!this.closing) this.fail(`lost codex app-server connection (${reason}); reconnect failed: ${last}`);
  }

  private fail(reason: string): void {
    for (const s of [...this.sessions.values()]) s.transportClosed(reason);
    this.sessions.clear();
    for (const cb of this.deadCbs.splice(0)) cb();
  }

  register(s: CodexSession): void {
    this.sessions.set(s.threadId, s);
    const early = this.early.get(s.threadId);
    this.early.delete(s.threadId);
    for (const m of early ?? []) this.deliver(s, m);
  }

  detach(s: CodexSession): void {
    if (this.sessions.get(s.threadId) === s) this.sessions.delete(s.threadId);
    if (this.sessions.size === 0) this.onEmpty(this);
  }

  saveTurn(threadId: string, snap: TurnSnapshot | undefined): void {
    const dir = this.connector.turnsDir;
    if (!dir) return;
    const file = join(dir, `${threadId}.json`);
    if (!snap) return removeFile(file);
    ensurePrivateDir(dir);
    writeJson(file, snap);
  }

  loadTurn(threadId: string): TurnSnapshot | undefined {
    return this.connector.turnsDir ? readJson<TurnSnapshot>(join(this.connector.turnsDir, `${threadId}.json`)) : undefined;
  }

  get stopWhenIdle(): boolean {
    return this.connector.stopWhenIdle;
  }

  close(): void {
    this.closing = true;
    this.rpc.close();
  }

  private route(m: Buffered): void {
    const threadId = (m.params as { threadId?: unknown } | undefined)?.threadId;
    if (typeof threadId !== 'string') {
      if (m.kind === 'r') this.rpc.respondError(m.id!, -32601, `@agents-io/harness-codex does not handle ${m.method}`);
      return;
    }
    const s = this.sessions.get(threadId);
    if (s) return this.deliver(s, m);
    // Keep a little for a session that is about to register; Codex replays pending requests on resume anyway.
    const buf = this.early.get(threadId) ?? [];
    if (buf.length < 256) buf.push(m);
    this.early.set(threadId, buf);
    if (buf.length === 1) setTimeout(() => this.early.delete(threadId), 10_000).unref();
  }

  private deliver(s: CodexSession, m: Buffered): void {
    if (m.kind === 'n') s.onNotification(m.method, m.params);
    else s.onServerRequest(m.id!, m.method, m.params);
  }
}

/**
 * Harness adapter for Codex. One app-server per adapter instance; each `open()`
 * is one Codex thread on it. Over stdio the process is a child of this host and
 * is stopped with the last session. Over a Unix socket the server outlives the
 * host: dropped connections are re-established (initialize, `thread/resume` of
 * every open thread, pending approvals replayed by Codex), and after a host
 * restart `open({ resume })` adopts a turn that is still running.
 */
export class CodexHarness implements HarnessAdapter {
  readonly id = 'codex';
  private server: Promise<AppServer> | undefined;
  private opening = 0;
  private readonly connector: Connector;

  constructor(private readonly opts: CodexHarnessOptions = {}) {
    this.connector = makeConnector(opts);
  }

  async probe(): Promise<{ version: string; caps: HarnessCaps }> {
    const s = await this.connect();
    const out = { version: s.version, caps: { ...CODEX_CAPS } };
    this.stop(s); // no-op while sessions or opens are using it
    return out;
  }

  async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    const options = (args.options ?? {}) as CodexOpenOptions;
    const opts: CodexOpenOptions = {
      ...options,
      profiles: { ...this.opts.profiles, ...options.profiles },
      resolveMedia: options.resolveMedia ?? this.opts.resolveMedia,
    };
    this.opening++;
    try {
      return await this.openOn(await this.connect(), args, opts);
    } finally {
      this.opening--;
    }
  }

  /**
   * Host shutdown that must not disturb Codex: sessions end without interrupting
   * or unsubscribing, running turns stay snapshotted, the connection closes. Over
   * a Unix socket the app-server keeps running; over stdio it dies with us.
   */
  async detach(): Promise<void> {
    const p = this.server;
    this.server = undefined;
    const s = await p?.catch(() => undefined);
    if (!s) return;
    for (const session of [...s.sessions.values()]) session.detachFromServer();
    s.sessions.clear();
    s.close();
  }

  /** Closes the connection (and the stdio child) now, failing every session on it. */
  async dispose(): Promise<void> {
    const p = this.server;
    this.server = undefined;
    (await p?.catch(() => undefined))?.close();
  }

  /** Stops the server started by `transport: { kind: 'unix', spawn: 'own' }`. */
  async shutdownOwnServer(): Promise<boolean> {
    await this.dispose();
    const t = this.opts.transport;
    if (typeof t !== 'object' || t.kind !== 'unix' || t.spawn !== 'own') return false;
    return stopOwnServer(t.stateDir ?? defaultStateDir());
  }

  private async openOn(server: AppServer, args: HarnessOpenArgs, opts: CodexOpenOptions): Promise<HarnessSession> {
    const profile = resolveProfile(args.run.profile, opts.profiles);
    const config: Record<string, JsonValue> = { ...(opts.config as Record<string, JsonValue> | undefined) };
    if (args.mcp) {
      const mcpServers = { ...((config.mcp_servers as Record<string, JsonValue> | undefined) ?? {}) };
      mcpServers[opts.mcpServerName ?? 'agents_io'] = { url: args.mcp.url, http_headers: { Authorization: `Bearer ${args.mcp.token}` } };
      config.mcp_servers = mcpServers;
    }
    const common = {
      cwd: args.cwd,
      approvalPolicy: profile.approvalPolicy ?? null,
      approvalsReviewer: profile.approvalsReviewer ?? null,
      sandbox: sandboxModeOf(profile) ?? null,
      config: Object.keys(config).length ? config : null,
      baseInstructions: opts.baseInstructions ?? null,
      developerInstructions: opts.developerInstructions ?? null,
      ...(args.run.model ? { model: args.run.model } : {}),
    };
    let res: ThreadStartResponse | ThreadResumeResponse;
    try {
      if (args.resume) {
        const params: ThreadResumeParams = { threadId: args.resume, excludeTurns: true, ...common };
        res = await server.rpc.request<ThreadResumeResponse>('thread/resume', params);
      } else {
        const params: ThreadStartParams = { ...common, ephemeral: opts.ephemeral ?? null, serviceName: 'agents-io' };
        res = await server.rpc.request<ThreadStartResponse>('thread/start', params);
      }
    } catch (e) {
      this.stop(server);
      throw e;
    }
    const adopt = args.resume ? server.loadTurn(res.thread.id) : undefined;
    const session = new CodexSession(
      server,
      res.thread.id,
      args,
      opts,
      { model: res.model, effort: res.reasoningEffort ?? undefined, profile: args.run.profile },
      adopt,
    );
    server.register(session);
    if (adopt) await session.afterResume(res.thread.status);
    return session;
  }

  private connect(): Promise<AppServer> {
    if (!this.server) {
      const p = AppServer.start(this.connector, this.opts, (s) => this.stop(s));
      this.server = p;
      p.then(
        (s) =>
          s.onDead(() => {
            if (this.server === p) this.server = undefined;
          }),
        () => {
          if (this.server === p) this.server = undefined;
        },
      );
    }
    return this.server;
  }

  private stop(s: AppServer): void {
    void this.server?.then((cur) => {
      if (cur === s && s.sessions.size === 0 && this.opening === 0) {
        this.server = undefined;
        s.close();
      }
    });
  }
}
