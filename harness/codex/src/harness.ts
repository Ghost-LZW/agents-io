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
  /** Arguments after the binary for stdio (default `['app-server']`). */
  args?: string[];
  env?: NodeJS.ProcessEnv;
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

function makeConnector(opts: CodexHarnessOptions): Connector {
  const t = opts.transport;
  const bin = opts.bin ?? 'codex';
  if (typeof t === 'function') return { open: async () => t(), reconnect: false, reconnectWindowMs: 0, stopWhenIdle: true };
  if (!t || t.kind === 'stdio') {
    return {
      open: async () => spawnTransport({ bin, args: opts.args ?? ['app-server'], env: opts.env }),
      reconnect: false,
      reconnectWindowMs: 0,
      stopWhenIdle: true,
    };
  }
  const stateDir = t.stateDir ?? defaultStateDir();
  const open = async (): Promise<Transport> => {
    let path: string;
    if (t.spawn === 'own') path = (await ensureOwnServer({ stateDir, socket: t.path, bin, env: opts.env })).socket;
    else if (t.spawn === 'daemon') path = t.path ?? (await startDaemon(bin, opts.env)).socket;
    else path = t.path ?? defaultCodexSocket(opts.env);
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
