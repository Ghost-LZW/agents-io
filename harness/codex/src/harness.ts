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
import { resolveProfile, sandboxModeOf, type CodexProfile, type MediaResolver } from './map.js';
import { RpcClient, spawnTransport, type Transport } from './rpc.js';
import { CodexSession, type CodexOpenOptions, type SessionHost } from './session.js';
import { assertSupportedVersion, versionFromUserAgent } from './version.js';

export interface CodexHarnessOptions {
  /** codex binary (default `codex`). */
  bin?: string;
  /** Arguments after the binary (default `['app-server']`, i.e. stdio). */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Replaces the spawned process; used by tests and for custom transports. */
  transport?: () => Transport;
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

/** Notifications nothing in this adapter maps; suppressed per connection. */
export const DEFAULT_OPT_OUT = [
  'account/login/completed',
  'account/rateLimits/updated',
  'account/updated',
  'app/list/updated',
  'command/exec/outputDelta',
  'deprecationNotice',
  'externalAgentConfig/import/completed',
  'externalAgentConfig/import/progress',
  'fs/changed',
  'fuzzyFileSearch/sessionCompleted',
  'fuzzyFileSearch/sessionUpdated',
  'item/fileChange/outputDelta',
  'item/reasoning/summaryPartAdded',
  'mcpServer/oauthLogin/completed',
  'process/exited',
  'process/outputDelta',
  'project/changed',
  'remoteControl/status/changed',
  'thread/realtime/closed',
  'thread/realtime/error',
  'thread/realtime/item/completed',
  'thread/realtime/item/started',
  'thread/realtime/item/transcript/delta',
  'thread/realtime/itemAdded',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/started',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
];

/**
 * What Codex 0.160 app-server supports, as agents-io capabilities:
 * - steer: `turn/steer` with `expectedTurnId` injects into the running turn;
 * - interrupt: `turn/interrupt`;
 * - approvals / questions: server requests (`item/*\/requestApproval`, `item/tool/requestUserInput`);
 * - tokenDeltas: `item/agentMessage/delta`;
 * - injectWithoutTurn: `thread/inject_items` exists (not exposed by HarnessSession yet);
 * - resume: `thread/resume`;
 * - switchModelMidSession: `turn/start.model` overrides per turn.
 */
export const CODEX_CAPS: HarnessCaps = {
  steer: 'native',
  interrupt: true,
  approvals: true,
  questions: true,
  tokenDeltas: true,
  cancelQueued: false,
  injectWithoutTurn: true,
  resume: true,
  switchModelMidSession: true,
};

interface Buffered {
  kind: 'n' | 'r';
  id?: RequestId;
  method: string;
  params: unknown;
}

/** One `codex app-server` process and its initialized connection, shared by all sessions of a CodexHarness. */
class AppServer implements SessionHost {
  readonly sessions = new Map<string, CodexSession>();
  /** Thread events that arrive before the session registers (thread/start response and notifications share a chunk). */
  private early = new Map<string, Buffered[]>();

  private constructor(
    readonly rpc: RpcClient,
    readonly version: string,
    readonly init: InitializeResponse,
    private readonly onEmpty: (s: AppServer) => void,
  ) {
    rpc.onNotification((method, params) => this.route({ kind: 'n', method, params }));
    rpc.onServerRequest((id, method, params) => this.route({ kind: 'r', id, method, params }));
    rpc.onClose((reason) => {
      for (const s of [...this.sessions.values()]) s.transportClosed(reason);
      this.sessions.clear();
    });
  }

  static async start(opts: CodexHarnessOptions, onEmpty: (s: AppServer) => void): Promise<AppServer> {
    const transport = opts.transport
      ? opts.transport()
      : spawnTransport({ bin: opts.bin ?? 'codex', args: opts.args ?? ['app-server'], env: opts.env });
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
      return new AppServer(rpc, version!, init, onEmpty);
    } catch (e) {
      rpc.close();
      const tail = 'stderrTail' in transport ? (transport as { stderrTail(): string }).stderrTail().trim() : '';
      if (tail && e instanceof Error && !e.message.includes(tail)) e.message += `\n--- codex stderr ---\n${tail.slice(-1500)}`;
      throw e;
    }
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

  close(): void {
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
 * Harness adapter for Codex. Spawns one `codex app-server` (JSON-RPC over stdio)
 * per adapter instance; each `open()` is one Codex thread on that process. The
 * process is stopped when its last session closes and respawned on demand.
 */
export class CodexHarness implements HarnessAdapter {
  readonly id = 'codex';
  private server: Promise<AppServer> | undefined;
  private opening = 0;

  constructor(private readonly opts: CodexHarnessOptions = {}) {}

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

  /** Stops the app-server process now, ending every session on it. */
  async dispose(): Promise<void> {
    const p = this.server;
    this.server = undefined;
    (await p?.catch(() => undefined))?.close();
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
    const session = new CodexSession(server, res.thread.id, args, opts, {
      model: res.model,
      effort: res.reasoningEffort ?? undefined,
      profile: args.run.profile,
    });
    server.register(session);
    return session;
  }

  private connect(): Promise<AppServer> {
    if (!this.server) {
      const p = AppServer.start(this.opts, (s) => this.stop(s));
      this.server = p;
      p.then(
        (s) => s.rpc.onClose(() => {
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
