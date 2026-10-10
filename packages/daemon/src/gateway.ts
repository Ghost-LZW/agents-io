import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PROTOCOL_VERSION,
  routeKey,
  type AdminQueue,
  type AdminSession,
  type AdminSessions,
  type AdminChannelsApplied,
  type AdminStatus,
  type ChannelAdapter,
  type ContentBlock,
  type Evidence,
  type HarnessAdapter,
  type HarnessCaps,
  type HarnessEvent,
  type HarnessOpenArgs,
  type HarnessSession,
  type HostRequestFrame,
  type InboundEnvelope,
  type InputRecord,
  type LiveEndpoint,
  type LiveStartArgs,
  type HarnessFactory,
  type Origin,
  type Policy,
  type ReplyRoute,
  type RunSpec,
  type SessionLaunch,
  type SessionPrepare,
  type SessionPrepareResult,
  type InboundRedispatch,
  type InboundRedispatchResult,
  type Tier,
  type TopicSwitchFrame,
  type TurnContext,
  type TurnProvenance,
  type Watch,
  type WatchDraft,
} from '@agents-io/protocol';
import {
  Compositor,
  FsBlobStore,
  HostQueue,
  Hub,
  Ingress,
  Lane,
  LaneUnavailableError,
  LiveTransportError,
  Outbox,
  Router,
  SqliteSessionLog,
  SOURCE_MISMATCH,
  TOPIC_TOOLS_HINT,
  TopicError,
  TopicRegistry,
  WatchDispatcher,
  WatchRegistry,
  defaultPolicy,
  type AddWatchResult,
  type EmitSource,
  type FullPolicy,
  type IngressResult,
  type RemoveWatchResult,
  type SessionLog,
  type TopicChange,
  type TopicRecord,
  topicContext,
  topicView,
  settleLeftoverInputs,
} from '@agents-io/session';
import { HostMcpServer, HostTools, ToolError, agentIdentity, type TopicHandover } from '@agents-io/host-mcp';
import { ClaudeCodeHarness, findOnPath, type ClaudeCodeHarnessConfig } from '@agents-io/harness-claude-code';
import { CodexHarness, type CodexProfile } from '@agents-io/harness-codex';
import { loadChannelModule } from './channel-module.js';
import { LarkBotAdapter } from '@agents-io/channel-lark-bot';
import { MailChannel, type MailChannelConfig } from '@agents-io/channel-mail';
import { spawnChannel, type BridgedChannel, type BridgeState } from '@agents-io/channel-jsonl-bridge';
import { ConfigError, RESERVED_CHANNEL_IDS, UNGRANTED_EVIDENCE, agentSpec, configTable, type AgentConfig, type Config, type HarnessInstance, type ModuleLaunch, type ResolvedChannel } from './config.js';
import { ConsoleServer } from './console.js';
import { ConfigStore, canonical } from './console-config.js';
import { LarkBotJobs } from './provision.js';
import type { ClientCommand, SessionInfo } from './frames.js';
import { HostService, isHostOrigin } from './host.js';
import { LocalServer } from './local-server.js';
import { privateDb, privateDir } from './private.js';
import { blobResolvers, type MediaResolvers } from './media.js';
import { DaemonRecords } from './records.js';
import { checkLaunch, launchView, sameLaunch, type LaunchCheck } from './launch.js';
import { Runs } from './runs.js';
import { consoleUrlPath, loadOrCreateTokenFile, removeTokenFile, TokenError, tokenPath, writeTokenFile } from './token.js';

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => void;

/** An in-process channel handed to the gateway (tests and e2e scripted ends). */
export interface ExtraChannel {
  adapter: ChannelAdapter;
  account?: string;
  tier?: Tier;
}

export interface GatewayOptions {
  config: Config;
  /** Use this harness for every instance instead of building them from the config (tests). */
  harness?: HarnessAdapter;
  /** Build instance adapters with this instead of `buildHarness` (tests). */
  buildHarness?: (instance: HarnessInstance) => HarnessAdapter;
  /** In-process channels besides the configured ones. */
  channels?: ExtraChannel[];
  /** Build a configured channel's adapter with this instead of the built-in one when it returns one (embedding, tests). */
  channelAdapter?: (ch: ResolvedChannel) => ChannelAdapter | undefined;
  /**
   * Hooks that replace defaultPolicy's. A `Policy.admit` here is legacy: it then
   * routes instead of the default binding table (watches still apply).
   */
  policy?: Partial<Policy>;
  /** Use this log instead of SQLite at `config.logPath` (tests). */
  log?: SessionLog;
  /** Use this watch registry (default: tables in the SQLite log's database, else in memory). */
  watches?: WatchRegistry;
  /** Serve the local client socket (default true). */
  listen?: boolean;
  /** Every host output-tool call (debugging; e2e checks what harnesses send in `_meta`). */
  onToolCall?: (e: { sessionKey: string; tool: string; meta: Record<string, unknown> | undefined; ok: boolean; error?: string; provenance?: TurnProvenance }) => void;
  /** Tee of raw harness events per session (conformance checks). */
  onHarnessEvent?: (sessionKey: string, e: HarnessEvent) => void;
  logger?: LogFn;
  /** Host token (default: from `tokenFile`, else a fresh random one; written next to the socket when listening). */
  token?: string;
  /**
   * Operator-set host token file (`aio serve --token-file`; default `config.host.tokenFile`):
   * read if present, else generated and written (0600). Ignored when `token` is given.
   */
  tokenFile?: string;
  /** Inbound push: how long a pushed item waits for the host's result, and the retry delay (tests). */
  hostPush?: { timeoutMs?: number; retryMs?: number };
  /** Serve the console API per `config.console` (default false; `aio serve` turns it on unless `console.enabled` is false). */
  console?: boolean;
  /** Environment of provisioning children (default process.env; tests). */
  consoleEnv?: NodeJS.ProcessEnv;
  /**
   * `console.liveChannels`: how long a channel started live may take to fail its
   * `start` before it is reported `started` (default 1000). Bridges report their first
   * connect at once and are not waited for.
   */
  channelStartGraceMs?: number;
}

/** Outcome of a local command, mapped 1:1 onto a `result` frame. */
export type Outcome = { ok: true; value: unknown } | { ok: false; code: string; message: string };

interface RunningChannel {
  adapter: ChannelAdapter;
  account: string;
  tier?: Tier;
  ac: AbortController;
  running: Promise<void>;
  close?: () => Promise<void>;
  state: 'running' | 'stopped' | 'failed';
  error?: string;
  /** The config entry it was built from (configured channels only). */
  source?: ResolvedChannel;
  /** `start` returned or rejected: the channel no longer runs and is not retried. */
  ended?: boolean;
  /** A bridge reported its connection state (it has connected or failed a first connect). */
  reported?: boolean;
  /** Which adapter its channel id belongs to (channel-stamping F4, {@link channelOwner}). */
  owner: ChannelOwner;
  /** Envelopes refused for claiming another (channel, account) or reply route. */
  rejected: number;
  /** Envelopes whose evidence was capped to `none`. */
  evidenceCapped: number;
  /** Last warn per reason (rate limit: one a minute). */
  warnedAt?: Map<string, number>;
}

/**
 * Who a channel id belongs to: the built-in type (`lark-bot`, `mail`), one bridge
 * program (`bridge:` command and args), one module (`module:` file and export), or, for
 * an adapter the embedder passes (`GatewayOptions.channels`), its class (several bots
 * of one adapter class are several objects). Channels sharing an id must share an
 * owner; only their accounts differ.
 */
type ChannelOwner = string | Function;

function channelOwner(cfg: ResolvedChannel): string {
  switch (cfg.type) {
    case 'lark-bot':
    case 'mail':
      return cfg.type;
    case 'bridge':
      return `bridge:${JSON.stringify([cfg.command, cfg.args ?? []])}`;
    case 'module':
      return `module:${JSON.stringify([cfg.module, cfg.export ?? null])}`;
  }
}

const ownerName = (o: ChannelOwner) => (typeof o === 'string' ? o : `embedded adapter ${o.name || '(anonymous class)'}`);

/** Bridge and module channels give strong evidence only when the entry grants it. */
const grantedByDefault = (o: ChannelOwner) => typeof o !== 'string' || o === 'lark-bot' || o === 'mail';

const DAEMON_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

/** Local ends post to this route; no adapter renders it, they read the stream instead. */
export const localRoute = (sessionKey: string): ReplyRoute => ({ channel: 'local', account: 'local', conversationId: sessionKey });

/** Wait for `p`, at most `ms`; the timer holds the event loop and is cleared when `p` wins. */
async function within(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise((r) => (t = setTimeout(r, ms)))]);
  clearTimeout(t);
}

/**
 * Everything in one process: channels → Ingress → one Lane per session (created on
 * demand, harness opened on the first turn) → Hub, and per (session, channel) a
 * Compositor + Outbox that render turns back to the route they came from. Local
 * clients reach the same lanes and hub through a Unix socket.
 */
export class Gateway {
  readonly hub: Hub;
  readonly policy: FullPolicy;
  /** The binding tables: the owners config as the default table, plus watches as runtime rules. */
  readonly router: Router;
  readonly ingress: Ingress;
  readonly outbox: Outbox;
  /** Watches: sessions subscribed to inputs not addressed to them. */
  readonly watches: WatchDispatcher;
  /** Inbound media (channels put, harnesses read). */
  readonly blobs: FsBlobStore;
  /** Host output tools, when some agent has `tools` on; mounted over MCP into those agents' harness bindings only. */
  readonly tools: HostTools | undefined;
  private readonly mcp: HostMcpServer | undefined;
  /** The durable host inbound queue (`on: "host"` rules), in the log's database. */
  readonly hostQueue: HostQueue;
  /** Who sent each channel message (`input.verify`), settled deliveries, session → agent. */
  readonly records: DaemonRecords;
  /** The host protocol on the local socket. */
  readonly host: HostService;
  /** Task runs (`run.start`). */
  readonly runs: Runs;
  /** Topics of flat conversations (decision 6), in the log's database. */
  readonly topics: TopicRegistry;
  /** Secret a host presents in `host.hello` (written 0600 next to the socket). */
  readonly token: string;
  /** Built instance adapters, by instance name (lazily, on first use). */
  private readonly instances = new Map<string, HarnessAdapter>();
  /** What the factories of `use: "module"` instances returned, by instance name (loaded at start). */
  private readonly moduleAdapters = new Map<string, HarnessAdapter>();
  /** Adapters of configured agents (their cwd and instructions over the instance's). */
  private readonly agentAdapters = new Map<string, HarnessAdapter>();
  private readonly lanes = new Map<string, Lane>();
  /** Running lives (decision 11), by session: the channel's media peer of each. */
  /** Sessions with a live_join still opening its endpoint (the claim that keeps it to one live). */
  private readonly joining = new Set<string>();
  private readonly lives = new Map<string, { liveId: string; endpoint: LiveEndpoint }>();
  /** Agent and working directory of each live lane. */
  private readonly laneInfo = new Map<string, { agent: AgentConfig; cwd?: string }>();
  /** Per-session adapters of launched sessions (decision 7), closed with their lane. */
  private readonly launched = new Map<string, LaunchAdapters>();
  private readonly compositors: Compositor[] = [];
  private readonly sessionCompositors = new Map<string, Compositor[]>();
  /** The channel adapter each compositor renders to (to stop them with a channel removed live). */
  private readonly compositorAdapter = new WeakMap<Compositor, ChannelAdapter>();
  /** Live channel applies run one at a time. */
  private applying: Promise<unknown> = Promise.resolve();
  private readonly channels: RunningChannel[] = [];
  /** Every (channel id, account) configured or injected and not removed from the config: stays when its instance failed or stopped. */
  private readonly configured = new Map<string, { id: string; account: string }>();
  private server: LocalServer | undefined;
  private tokenFile: string | undefined;
  /** The console API server (`GatewayOptions.console`). */
  console: ConsoleServer | undefined;
  private consoleFile: string | undefined;
  /** The config file as the console edits it (when the config came from a file). */
  readonly configStore: ConfigStore | undefined;
  readonly larkBots: LarkBotJobs | undefined;
  readonly startedAt = Date.now();
  private readonly log: LogFn;
  private stopped = false;
  /** Parked topic sessions whose lane closes when this fires (`topics.parkedIdleMs`). */
  private readonly parkedTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor(private readonly o: GatewayOptions) {
    const c = o.config;
    // The default instance must be usable (e.g. its env refs set); others fail when a turn names them.
    // A module default is checked in `start`, once its module is loaded.
    if (o.harness || o.buildHarness || c.harnesses[c.defaultHarness]?.kind !== 'module') this.harness();
    this.log = o.logger ?? ((level, msg) => console.error(`[aio] ${level}: ${msg}`));
    for (const w of c.warnings ?? []) this.log('warn', `config: ${w}`);
    // Before anything opens: a bad token file fails the start without leaving handles behind.
    this.token = o.token ?? this.hostToken(o.tokenFile ?? c.host?.tokenFile);
    if (!o.log && c.logPath !== ':memory:') {
      // Transcripts and tool output: 0600 before SQLite opens it (its -wal/-shm files take the database's mode).
      const warn = (msg: string) => this.log('warn', msg);
      privateDir(dirname(c.logPath), warn);
      privateDb(c.logPath, warn);
    }
    const log = o.log ?? new SqliteSessionLog({ path: c.logPath });
    const db = log instanceof SqliteSessionLog ? { db: log.db } : {};
    this.hub = new Hub(log);
    this.records = new DaemonRecords(db);
    this.hostQueue = new HostQueue(db);
    // Every topic change is recorded (topic.changed) in the session left and the one now current.
    this.topics = new TopicRegistry({ ...db, hub: this.hub, onChange: (ch) => this.topicChanged(ch) });
    // Agents: the configured ones, or `default` on the default instance with sessions keyed by bare route keys as before.
    const legacyAdmit = o.policy?.admit;
    const table = configTable(c);
    this.router = new Router({
      agents: Object.values(c.agents).map((a) => agentSpec(a, c)),
      ...(c.defaultAgent !== undefined ? { defaultAgent: c.defaultAgent } : {}),
      ...(legacyAdmit ? { legacyAdmit: legacyAdmit.bind(o.policy) } : table ? { config: table } : {}),
      watches: { list: () => this.watches.list() },
      selfAccounts: c.policy.selfAccounts,
      agentAccounts: c.policy.agentAccounts,
      // An agent account's message declaring one of our sessions (SendOp.as) is our own echo.
      isSelfDeclared: (declared) => declared.startsWith('session:') && this.isOurSession(declared.slice('session:'.length)),
      routeCallout: (bindingId, input, envelope) => this.host.routeCallout(bindingId, input, envelope),
      topics: this.topics,
      // Decision 7: callout answers may launch the session they land in; pinned sessions may skip the callout.
      launches: {
        check: (a) => this.launchCheck(a.sessionKey, a.agent, a.launch),
        pinned: (key) => this.records.launchOf(key) !== undefined,
      },
      ...db,
      log: (level, msg) => this.log(level, `router: ${msg}`),
    });
    const router = this.router;
    const base = defaultPolicy({
      owners: c.policy.owners,
      selfAccounts: c.policy.selfAccounts,
      agentAccounts: c.policy.agentAccounts,
      routes: c.policy.routes,
      watchAllowlist: c.policy.watchAllowlist,
      run: c.harnesses[c.defaultHarness]!.run,
    });
    const local = {
      ...base,
      // The router's identity maps (the owners config; a host's map once one is pushed).
      identify: async (a) => router.identify(a),
      // The host (authenticated with the token) may interrupt and cancel what it started and what it watches.
      control: async (a) => (isHostOrigin(a.origin) ? 'allow' : base.control(a)),
      ...o.policy,
    } as FullPolicy;
    this.policy = {
      ...local,
      // A connected host whose hello lists `resolve` decides who answers a request; when it
      // cannot (timeout, error, bad answer) the local policy does. This falls back (fails open to
      // the built-in resolvers), it does not deny: a host restricting who may answer is not
      // enforced while it is slow or down. (outbound below denies instead.)
      resolve: async (req, ctx) => {
        if (!this.host.answers('resolve')) return local.resolve(req, ctx);
        try {
          return await this.host.resolveCallout(req, ctx);
        } catch (e) {
          this.log('warn', `${ctx.sessionKey}: host resolve callout for ${req.requestId} failed (${(e as Error).message}); the local policy decides`);
          return local.resolve(req, ctx);
        }
      },
      // A connected host whose hello lists `outbound` decides where agents may send; no answer denies.
      // While that host is away (also after a restart, until it or a host without the hook
      // connects) only the turn's own routes stay open: the local policy's wider allowances
      // (preregistered routes) are what the host may have tightened, so they fail closed.
      outbound: async (a) => {
        const held = this.host.outboundHeldBy();
        if (held !== undefined) {
          const k = routeKey(a.to);
          const own = a.from ? [a.from.replyRoute, ...a.from.inputs.map((i) => i.replyRoute)] : [];
          if (own.some((r) => r && routeKey(r) === k)) return 'allow';
          this.log('warn', `host ${held} decides outbound and is not connected: ${k} denied`);
          return 'deny';
        }
        if (!this.host.answers('outbound')) return local.outbound(a);
        try {
          return await this.host.outboundCallout(a.from, a.to);
        } catch (e) {
          this.log('warn', `host outbound callout to ${routeKey(a.to)} failed (${(e as Error).message}); denied`);
          return 'deny';
        }
      },
    };
    this.outbox = new Outbox({ hub: this.hub, policy: this.policy, store: this.records });
    this.runs = new Runs({
      hub: this.hub,
      agents: () => c.agents,
      agentCwd: (a) => a.cwd ?? c.harnesses[a.harness]?.cwd ?? c.cwd,
      openRunLane: (r) => this.openRunLane(r),
      hostPeer: () => this.host.hostPeer(),
      log: (level, msg, data) => this.log(level, msg, data),
    });
    this.host = new HostService({
      token: this.token,
      router,
      queue: this.hostQueue,
      records: this.records,
      runs: this.runs,
      deliver: (name, f) => this.deliver(name, f),
      prepareSession: (f) => this.prepareSession(f),
      redispatch: (name, f) => this.redispatch(name, f),
      calloutTimeouts: { resolve: c.hostCallouts.resolveTimeoutMs, outbound: c.hostCallouts.outboundTimeoutMs },
      answerOnBehalf: c.policy.answerOnBehalf,
      log: (level, msg, data) => this.log(level, msg, data),
      ...(o.hostPush?.timeoutMs !== undefined ? { pushTimeoutMs: o.hostPush.timeoutMs } : {}),
      ...(o.hostPush?.retryMs !== undefined ? { pushRetryMs: o.hostPush.retryMs } : {}),
    });
    this.blobs = new FsBlobStore(c.blobs);
    // Watches live next to the log (same SQLite file), so they and their digest buffers survive a restart.
    const registry = o.watches ?? new WatchRegistry(log instanceof SqliteSessionLog ? { db: log.db } : {});
    this.watches = new WatchDispatcher({
      registry,
      policy: this.policy,
      lanes: (key) => this.lane(key),
      replyRoute: (w) => this.homeRoute(w.target.sessionKey),
      onError: (err, id) => this.log('warn', `watch ${id}: ${(err as Error).message}`),
    });
    // Built when some agent has tools (agents.<name>.tools, default `outputTools`, off); only those agents' harnesses mount them.
    if (Object.values(c.agents).some((a) => a.tools)) {
      this.tools = new HostTools({
        hub: this.hub,
        outbox: this.outbox,
        policy: this.policy,
        // Only lanes that exist: a tool call always comes from a running harness session.
        turn: (key) => this.lanes.get(key)?.currentTurn(),
        adapter: (r) => this.channelFor(r)?.adapter,
        as: (key) => agentIdentity(key),
        blobs: this.blobs,
        cwd: (key) => this.laneInfo.get(key)?.cwd ?? this.instanceOf(this.lanes.get(key)?.harnessId)?.cwd ?? c.cwd,
        tier: (r) => this.channelFor(r)?.tier,
        routes: () => c.policy.routes,
        // Agents add watches as themselves (kind agent); Policy.watch decides, the target is pinned to their session.
        watches: { add: (by, d) => this.addWatch(by, d), remove: (by, id) => this.removeWatch(by, id), list: (key) => this.listWatches(key) },
        // Decision 4: every write carries where the turn's inputs came from.
        provenance: (key, turnId) => this.lanes.get(key)?.provenance(turnId),
        // Decision 6: the agent decides when a conversation moves to another topic.
        topics: {
          list: (key) => (this.topics.bySession(key) ? this.topics.siblings(key).map(topicView) : undefined),
          rotate: (key, turn, a) => this.rotateTopic(key, turn, a),
          switch: (key, turn, a) => this.switchTopicFor(key, turn, a.topicId),
        },
        // Decision 9: realtime voice on the session's harness, the media peer from a channel.
        live: {
          join: (key, turn, a) => this.joinLive(key, turn, a),
          say: async (key, text) => {
            const lane = this.lanes.get(key);
            if (!lane?.liveInfo()) throw new ToolError('no live is running in this session; live_join first');
            await lane.liveSay(text);
          },
          leave: (key) => this.leaveLive(key, 'left by the agent'),
        },
      });
      const tools = this.tools;
      this.mcp = new HostMcpServer({
        tools,
        ...(o.onToolCall
          ? { onCall: (e) => o.onToolCall!({ sessionKey: e.binding.sessionKey, tool: e.tool, meta: e.meta, ok: e.ok, ...(e.error ? { error: e.error } : {}), ...(e.provenance ? { provenance: e.provenance } : {}) }) }
          : {}),
      });
    }
    const tools = this.tools;
    this.ingress = new Ingress({
      policy: this.policy,
      router: this.router,
      lanes: (key, agent, launch) => this.lane(key, agent, launch),
      hub: this.hub,
      watches: this.watches,
      onWatchError: (err) => this.log('warn', `watch fan-out failed: ${(err as Error).message}`),
      // `on: "host"` inputs wait in the durable queue until the host acks them.
      hostQueue: this.hostQueue,
      replyCaps: (ch, account) => this.replyCaps(ch, account),
      // Clicks on ask_choice buttons (and numbered replies) go back to the session that asked.
      ...(tools ? { rewrite: (a) => tools.rewriteInbound(a) } : {}),
      // `/new`, `/topics`, `/switch` answer with one short message on the route they came from.
      systemReply: (a) => this.systemReply(a),
      // Inputs of a current topic say how to move between topics, to agents that have the session_* tools.
      ...(tools ? { topicHint: (agent: string | undefined) => (c.agents[agent ?? c.defaultAgent ?? '']?.tools ? TOPIC_TOOLS_HINT : undefined) } : {}),
      onReplyError: (err) => this.log('warn', `topic command reply failed: ${(err as Error).message}`),
      // A session whose agent is gone refuses the input: its log says so, and the route
      // too when the message was addressed to it (observe-only messages stay silent).
      onUnavailable: (a) => this.refuseUnavailable(a.sessionKey, a.code, a.message, a.input.inputId, a.on === 'dispatch' ? a.input.replyRoute : null),
    });
    if (c.source) {
      this.configStore = new ConfigStore({ path: c.source.path, ...(c.source.envFile ? { envFile: c.source.envFile } : {}), ...(o.consoleEnv ? { env: o.consoleEnv } : {}) });
      const store = this.configStore;
      this.larkBots = new LarkBotJobs({
        command: c.console.larkBotCommand,
        dir: join(c.dataDir, 'provision'),
        config: store,
        ...(c.console.liveChannels ? { applyChannels: () => this.applyChannels() } : {}),
        log: (level, msg) => this.log(level, msg),
        ...(o.consoleEnv ? { env: o.consoleEnv } : {}),
      });
    }
  }

  /** The operator's token file (read, or created), else a fresh token for this start only. */
  private hostToken(file: string | undefined): string {
    if (file === undefined) return randomBytes(32).toString('hex');
    // `<socket>.token` is the daemon's copy, rewritten at listen and removed at stop: never the operator's file.
    if (resolvePath(file) === resolvePath(tokenPath(this.o.config.socketPath))) throw new TokenError(`token file ${file} is the daemon's own copy next to the socket (${tokenPath(this.o.config.socketPath)}); choose another path`);
    const r = loadOrCreateTokenFile(file);
    this.log('info', r.created ? `host token generated and written to ${file}` : `host token read from ${file}`);
    return r.token;
  }

  static async start(o: GatewayOptions): Promise<Gateway> {
    const gw = new Gateway(o);
    try {
      await gw.loadHarnessModules();
      gw.harness();
      if (gw.mcp) {
        const url = await gw.mcp.listen();
        gw.log('info', `host MCP output tools on ${url}`);
      }
      gw.watches.start();
      gw.runs.settleAllDangling();
      // Sends an earlier process left in flight: unknown, never resent (decision 13).
      for (const r of gw.outbox.recover()) gw.log('warn', `delivery ${r.operationId} was in flight when the previous daemon stopped; settled unknown, not resent`);
      gw.settleLeftoverInputs();
      await gw.loadConfigWatches();
      await gw.startChannels();
      await gw.adoptRunningTurns();
      if (o.listen !== false) {
        gw.server = new LocalServer(gw, o.config.socketPath);
        await gw.server.listen();
        // The socket directory is private (0700) by now; the token file is 0600 in it.
        gw.tokenFile = tokenPath(o.config.socketPath);
        writeTokenFile(gw.tokenFile, gw.token);
      }
      if (o.console) await gw.startConsole();
    } catch (e) {
      await gw.stop().catch(() => undefined);
      throw e;
    }
    return gw;
  }

  get config(): Config {
    return this.o.config;
  }

  /**
   * The console API. A port that is taken is logged, not fatal: the daemon's
   * channels and sockets keep working without it.
   */
  private async startConsole(): Promise<void> {
    const c = this.o.config;
    if (this.larkBots) privateDir(join(c.dataDir, 'provision'), (msg) => this.log('warn', msg));
    const server = new ConsoleServer({
      config: c.console,
      host: {
        local: this,
        token: this.token,
        status: () => this.adminStatus(),
        queue: () => this.adminQueue(),
        sessions: () => this.adminSessions(),
        explain: (id) => this.router.explain(id),
        consoleOrigin: (key) => this.consoleOrigin(key),
        ...(this.configStore ? { configStore: this.configStore } : {}),
        ...(this.larkBots ? { larkBots: this.larkBots } : {}),
        ...(this.configStore && c.console.liveChannels ? { applyChannels: () => this.applyChannels() } : {}),
      },
      log: (level, msg) => this.log(level, msg),
    });
    // A file left by a daemon that died must not point `aio console-link` at whoever holds that port now.
    const urlFile = consoleUrlPath(c.socketPath);
    if (this.tokenFile) rmSync(urlFile, { force: true });
    try {
      await server.listen();
    } catch (e) {
      this.log('error', `console API not started: cannot listen on ${c.console.host}:${c.console.port}: ${(e as Error).message}`);
      return;
    }
    this.console = server;
    this.log('info', `console API on ${server.url}`);
    if (this.tokenFile) {
      // Next to the token file (same private directory), so `aio console-link` finds the port.
      this.consoleFile = urlFile;
      writeTokenFile(this.consoleFile, server.url);
    }
  }

  /** Origin of a console connection's client frames: the local principal, via the console. */
  consoleOrigin(sessionKey: string): Origin {
    return { ...this.localOrigin(sessionKey), via: 'console', adapter: 'console' };
  }

  /** `GET /api/status`. */
  adminStatus(): AdminStatus {
    const c = this.o.config;
    const h = this.host.info();
    const st = this.router.hostTable();
    const sessions = this.sessions();
    return {
      version: DAEMON_VERSION,
      protocol: PROTOCOL_VERSION,
      pid: process.pid,
      startedAt: this.startedAt,
      now: Date.now(),
      dataDir: c.dataDir,
      socket: c.socketPath,
      ...(c.source ? { configPath: c.source.path } : {}),
      host: {
        connected: this.router.hostConnected,
        ...(h ? { name: h.name, callouts: h.callouts, ...(h.consumer !== undefined ? { consumer: h.consumer } : {}) } : {}),
        ...(st ? { table: { version: st.table.version, active: st.active, ...(st.suspended ? { suspended: st.suspended } : {}) } } : {}),
      },
      channels: this.channels.map((ch) => ({ id: ch.adapter.id, account: ch.account, state: ch.state, ...(ch.error ? { error: ch.error } : {}), ...(ch.rejected ? { rejected: ch.rejected } : {}), ...(ch.evidenceCapped ? { evidenceCapped: ch.evidenceCapped } : {}) })),
      agents: Object.values(c.agents).map((a) => ({
        name: a.name,
        harness: a.harness,
        mode: a.mode,
        ...(a.model !== undefined ? { model: a.model } : {}),
        ...(a.effort !== undefined ? { effort: a.effort } : {}),
        ...(a.profile !== undefined ? { profile: a.profile } : {}),
        ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
        ...(a.name === c.defaultAgent ? { default: true } : {}),
      })),
      sessions: { total: sessions.length, live: sessions.filter((s) => s.live).length, running: sessions.filter((s) => s.turnId !== undefined).length },
      runs: { running: this.runs.running() },
      queue: { head: this.hostQueue.head() },
    };
  }

  /** `GET /api/queue`: per consumer, without registering anyone. */
  adminQueue(): AdminQueue {
    const h = this.host.info();
    return {
      head: this.hostQueue.head(),
      consumers: this.hostQueue.consumers().map((x) => {
        const p = this.hostQueue.pending(x.acked);
        return { consumer: x.name, acked: x.acked, pending: p.count, push: h?.consumer === x.name, ...(p.oldestAt !== undefined ? { oldestPendingAt: p.oldestAt } : {}) };
      }),
    };
  }

  /** `GET /api/sessions`: `SessionInfo` plus agent, conversation (the latest reply route), run id, last event time. */
  adminSessions(): AdminSessions {
    const c = this.o.config;
    return {
      sessions: this.sessions().map((info): AdminSession => {
        let route: ReplyRoute | undefined;
        let lastEventAt: number | undefined;
        for (const e of this.hub.log.read(info.sessionKey, 0)) {
          lastEventAt = e.ts;
          if (e.body.t === 'turn.started' && e.body.replyRoute) route = e.body.replyRoute;
        }
        const agent = this.laneInfo.get(info.sessionKey)?.agent.name ?? this.records.agentOf(info.sessionKey) ?? (info.sessionKey.startsWith('run:') ? undefined : c.defaultAgent);
        return {
          ...info,
          ...(agent !== undefined ? { agent } : {}),
          ...(route && route.channel !== 'local' ? { conversation: routeKey(route) } : {}),
          ...(info.sessionKey.startsWith('run:') ? { runId: info.sessionKey.slice(4) } : {}),
          ...(lastEventAt !== undefined ? { lastEventAt } : {}),
        };
      }),
    };
  }

  /** Topic frames on the local socket (LocalHost). */
  get topicFrames(): Pick<Gateway, 'topicList' | 'topicSwitch'> {
    return this;
  }

  /** Host frames on the local socket (LocalHost). */
  get hostFrames(): HostService {
    return this.host;
  }

  /**
   * Accept one envelope from a channel: route it (Ingress) and remember who sent
   * it as stamped, so `input.verify` can answer later. Channels started by the
   * gateway pass their `source` (channel-stamping); without one the caller is trusted.
   */
  async accept(env: InboundEnvelope, source?: EmitSource): Promise<IngressResult> {
    if (this.refusingInbound) return { accepted: false, action: 'invalid', error: 'gateway stopping' };
    const r = await this.ingress.accept(env, source);
    if (r.accepted && r.origin && r.action !== 'duplicate') {
      try {
        // As stamped (evidence capped), not as claimed: hosts verify authors with it.
        this.records.recordInput(r.envelope ?? env, r.origin, r.inputId);
      } catch (e) {
        this.log('warn', `recording input ${r.inputId ?? env.id} failed: ${(e as Error).message}`);
      }
    }
    return r;
  }

  /**
   * The adapter of a harness instance (`RunSpec.harness`), built on first use.
   * Its id is the instance name, so session events and resume ids stay per instance.
   */
  harness(name: string = this.o.config.defaultHarness): HarnessAdapter {
    if (this.o.harness) return this.o.harness;
    let a = this.instances.get(name);
    if (a) return a;
    const inst = this.o.config.harnesses[name];
    if (!inst) throw new Error(`unknown harness instance ${JSON.stringify(name)} (configured: ${Object.keys(this.o.config.harnesses).join(', ')})`);
    a = this.build(inst);
    this.instances.set(name, a);
    return a;
  }

  /** An instance's adapter, built now: a module instance wraps what its factory returned at start. */
  private build(inst: HarnessInstance): HarnessAdapter {
    const own = this.o.buildHarness?.(inst);
    if (own) return own;
    if (inst.kind !== 'module') return buildHarness(inst, blobResolvers(this.blobs));
    const a = this.moduleAdapters.get(inst.name);
    if (!a) throw new Error(inst.unavailable ? `harness instance ${inst.name} is unavailable: ${inst.unavailable}` : `harness instance ${inst.name}: its module was not loaded`);
    return new InstanceHarness(inst, a);
  }

  /**
   * Import the `use: "module"` instances' modules and run their factories, in config order.
   * A failure fails the start (a config error naming the instance). `init.harness(name)`
   * hands out another instance by name; it is built when first used, so the order of the
   * entries does not matter.
   */
  private async loadHarnessModules(): Promise<void> {
    if (this.o.harness || this.o.buildHarness) return;
    const c = this.o.config;
    for (const inst of Object.values(c.harnesses)) {
      if (inst.kind !== 'module' || inst.unavailable) continue;
      const adapter = await loadHarnessModule({
        name: inst.name,
        module: inst.module,
        log: (level, msg, data) => this.log(level, `harness ${inst.name}: ${msg}`, data),
        harness: (name) => {
          if (!c.harnesses[name]) throw new Error(`unknown harness instance ${JSON.stringify(name)} (configured: ${Object.keys(c.harnesses).join(', ')})`);
          return { id: name, probe: () => this.harness(name).probe(), open: (args) => this.harness(name).open(args) };
        },
      }).catch((e: Error) => {
        throw new ConfigError(e.message);
      });
      this.moduleAdapters.set(inst.name, adapter);
    }
  }

  private instanceOf(harnessId: string | undefined): HarnessInstance | undefined {
    return this.o.harness || harnessId === undefined ? undefined : this.o.config.harnesses[harnessId];
  }

  /**
   * The lane of a session, created on first use with the session's agent (the
   * one recorded for it, else `agent`, else the agent whose prefix the key has,
   * else the default agent). Its harness session opens with the first turn.
   * `launch` (decision 7) is pinned with a new session and must match an existing
   * one's; a session pinned to a launch always opens with it.
   */
  lane(sessionKey: string, agentName?: string, launch?: SessionLaunch): Lane {
    // Before the live-lane shortcut: a conflicting launch must not pass silently.
    let fresh: SessionLaunch | undefined;
    if (launch !== undefined) {
      const c = this.launchCheck(sessionKey, agentName, launch);
      if (!c.ok) throw new LaneUnavailableError(c.code, c.message);
      if (c.outcome === 'applied') fresh = c.launch;
    }
    let lane = this.lanes.get(sessionKey);
    if (lane) {
      const had = this.laneInfo.get(sessionKey)?.agent.name;
      if (agentName !== undefined && had !== undefined && had !== agentName) this.log('warn', `${sessionKey} belongs to agent ${had}; a rule for agent ${agentName} delivered to it`);
      return lane;
    }
    if (sessionKey.startsWith('run:')) throw new Error(`${sessionKey} is a task run session; it only exists while its run.start runs`);
    const agent = this.agentFor(sessionKey, agentName, fresh);
    const c = this.o.config;
    const pinned = agent.configured ? this.records.launchOf(sessionKey) : undefined;
    const launched = pinned ? this.launchAdapters(agent, pinned) : undefined;
    const cwd = pinned?.cwd ?? (agent.configured ? (agent.cwd ?? c.harnesses[agent.harness]?.cwd ?? c.cwd) : c.cwd);
    lane = new Lane({
      sessionKey,
      // A launched session's adapters go through both: the lane uses `harnessFor` whenever it is set.
      harness: launched ? launched.adapter(agent.harness) : this.agentHarness(agent),
      ...(launched
        ? { harnessFor: (name: string) => launched.adapter(name) }
        : this.o.harness
          ? {}
          : { harnessFor: (name: string) => (name === agent.harness ? this.agentHarness(agent) : this.harness(name)) }),
      resumeFor: (id) => this.nativeIdOf(sessionKey, id),
      hub: this.hub,
      policy: this.agentPolicy(agent),
      cwd,
      ...(this.mcp && agent.tools ? { mcp: (a: { sessionKey: string; generation: number; harnessId: string }) => this.mcp!.mcpFor(a) } : {}),
      onLiveEnded: (liveId, reason) => this.liveEnded(sessionKey, liveId, reason),
      onHarnessEvent: (e) => {
        // A topic remembers its harness session id (switching back resumes it; the lane resumes from the log).
        if (e.body.t === 'session.bound') this.topics.setNativeId(sessionKey, e.body.nativeId);
        this.o.onHarnessEvent?.(sessionKey, e);
      },
    });
    this.lanes.set(sessionKey, lane);
    this.laneInfo.set(sessionKey, { agent, ...(agent.configured ? { cwd } : {}) });
    if (launched) this.launched.set(sessionKey, launched);
    for (const ch of this.channels) this.compose(sessionKey, ch.adapter, ch.tier, ch.account);
    // A parked topic's lane opened again (an answer to a question it asked): it idles out like any parked one.
    if (this.topics.bySession(sessionKey)?.state === 'parked') this.idleOut(sessionKey);
    return lane;
  }

  /**
   * The agent of an interactive session. A session keeps the agent first recorded
   * for it; if that agent is no longer configured (or no longer interactive), the
   * session refuses with `agent_unavailable` instead of running the conversation
   * under another agent's cwd, profile and tools.
   */
  private agentFor(sessionKey: string, wanted: string | undefined, launch?: SessionLaunch): AgentConfig {
    const agent = this.pickAgent(sessionKey, wanted);
    // The agent and a launch are pinned together (one transaction), or the agent alone.
    if (agent.configured && this.records.agentOf(sessionKey) === undefined) {
      if (launch) this.records.pin(sessionKey, agent.name, launch);
      else this.records.setAgent(sessionKey, agent.name);
    }
    return agent;
  }

  /** `agentFor` without recording anything. */
  private pickAgent(sessionKey: string, wanted: string | undefined): AgentConfig {
    const c = this.o.config;
    const usable = (n: string | undefined) => (n !== undefined && c.agents[n]?.mode === 'interactive' ? c.agents[n] : undefined);
    const pinned = this.records.agentOf(sessionKey);
    if (pinned !== undefined) {
      const recorded = usable(pinned);
      if (recorded) return recorded;
      const why = c.agents[pinned] ? 'is a task agent now' : 'is not configured any more';
      throw new LaneUnavailableError('agent_unavailable', `session ${sessionKey} belongs to agent ${JSON.stringify(pinned)}, which ${why}; configure it again to continue this session`);
    }
    const byPrefix = Object.values(c.agents).find((a) => a.name !== c.defaultAgent && a.mode === 'interactive' && sessionKey.startsWith(`${a.name}:`));
    const agent = usable(wanted) ?? byPrefix ?? usable(c.defaultAgent);
    if (!agent) throw new Error(`no interactive agent for session ${sessionKey} (configure one, or a defaultAgent)`);
    return agent;
  }

  // ---- session launch (decision 7) -----------------------------------------

  /**
   * Whether `launch` may apply to a session (records nothing): within its agent's
   * `sessionParams`, and either the same as the launch the session is pinned to
   * (`same`) or for a session that does not exist yet (`applied`). Anything else is
   * `launch_conflict`: a session keeps the launch it started with (its harness
   * resumes in that cwd and config dir); another launch needs another session key.
   */
  private launchCheck(sessionKey: string, agentName: string | undefined, launch: SessionLaunch): ({ ok: true; outcome: 'applied' | 'same'; launch: SessionLaunch }) | Extract<LaunchCheck, { ok: false }> {
    if (sessionKey.startsWith('run:')) return { ok: false, code: 'launch_not_allowed', message: `${sessionKey} is a task run session; runs take their cwd and env from run.start` };
    let agent: AgentConfig;
    try {
      agent = this.pickAgent(sessionKey, agentName);
    } catch (e) {
      return { ok: false, code: e instanceof LaneUnavailableError ? e.code : 'no_agent', message: (e as Error).message };
    }
    const checked = checkLaunch(agent, launch, this.o.config.harnesses[agent.harness]);
    if (!checked.ok) return checked;
    const pinned = this.records.launchOf(sessionKey);
    if (pinned) {
      if (sameLaunch(pinned, checked.launch)) return { ok: true, outcome: 'same', launch: pinned };
      return { ok: false, code: 'launch_conflict', message: `session ${sessionKey} was launched otherwise; a session keeps its launch (use another session key)` };
    }
    if (this.sessionExists(sessionKey)) return { ok: false, code: 'launch_conflict', message: `session ${sessionKey} already exists without a launch (use another session key)` };
    return { ok: true, outcome: 'applied', launch: checked.launch };
  }

  /**
   * A session exists once it has an agent or launch row, a lane, or anything in its
   * log but topic bookkeeping (a new topic's key gets `topic.changed` before its lane
   * opens). The log counts for sessions of the unconfigured default agent, which never
   * get an agent row.
   */
  private sessionExists(sessionKey: string): boolean {
    if (this.records.agentOf(sessionKey) !== undefined || this.records.launchOf(sessionKey) || this.lanes.has(sessionKey)) return true;
    for (const e of this.hub.log.read(sessionKey, 0)) if (e.body.t !== 'topic.changed') return true;
    return false;
  }

  /** `session.prepare`: pin an agent and a launch to a key no input has opened yet (or the same ones again). */
  prepareSession(f: SessionPrepare): Outcome {
    if (this.stopped) return fail('stopped', 'daemon is stopping');
    if (!f.sessionKey) return fail('invalid_frame', 'sessionKey is empty');
    if (f.sessionKey.startsWith('run:')) return fail('invalid_frame', `${f.sessionKey} is a task run session key (task runs use run.start)`);
    const agent = this.o.config.agents[f.agent];
    if (!agent) return fail('unknown_agent', `unknown agent ${JSON.stringify(f.agent)} (agents: ${Object.keys(this.o.config.agents).join(', ')})`);
    if (agent.mode !== 'interactive') return fail('not_interactive_agent', `agent ${f.agent} is a task agent (run.start runs it)`);
    const had = this.records.agentOf(f.sessionKey);
    if (had !== undefined && had !== f.agent) return fail('agent_conflict', `session ${f.sessionKey} belongs to agent ${had}`);
    const c = this.launchCheck(f.sessionKey, f.agent, f.launch);
    if (!c.ok) return fail(c.code, c.message);
    if (c.outcome === 'applied') {
      this.records.pin(f.sessionKey, f.agent, c.launch);
      const v = launchView(c.launch);
      this.log('info', `${f.sessionKey}: prepared for agent ${f.agent}${v.cwd ? ` in ${v.cwd}` : ''}${v.envKeys.length ? ` (env: ${v.envKeys.join(', ')})` : ''}`);
    }
    return { ok: true, value: { sessionKey: f.sessionKey, agent: f.agent, launch: launchView(c.launch), created: c.outcome === 'applied' } satisfies SessionPrepareResult };
  }

  /** `inbound.redispatch` in flight, per cursor (a second request waits for the first). */
  private readonly redispatching = new Map<number, Promise<Outcome>>();

  /**
   * `inbound.redispatch`: deliver a queued host-inbound item to a session as the
   * input it was (original origin), at most once per cursor. A pending record is
   * written before the delivery and completed after it: a delivery cut off by a
   * stop is reported (`duplicate`, `interrupted`), never repeated. A delivery that
   * fails is not recorded, so the host may try another session.
   */
  redispatch(hostName: string, f: InboundRedispatch): Promise<Outcome> {
    const running = this.redispatching.get(f.cursor);
    if (running) return running.then((r) => (r.ok ? { ok: true, value: { ...(r.value as InboundRedispatchResult), duplicate: true } } : this.redispatch(hostName, f)));
    const p = this.redispatchOnce(hostName, f).finally(() => this.redispatching.delete(f.cursor));
    this.redispatching.set(f.cursor, p);
    return p;
  }

  private async redispatchOnce(hostName: string, f: InboundRedispatch): Promise<Outcome> {
    if (this.stopped) return fail('stopped', 'daemon is stopping');
    const prior = this.hostQueue.redispatched<InboundRedispatchResult & { pending?: true }>(f.cursor);
    if (prior) {
      // Not in flight here (the map would have it): a pending record is an attempt an earlier run cut off.
      const { pending, ...v } = prior;
      return { ok: true, value: { ...v, duplicate: true, ...(pending ? { interrupted: true } : {}) } satisfies InboundRedispatchResult };
    }
    const item = this.hostQueue.get(f.cursor);
    if (!item) return fail('unknown_cursor', `no host inbound item at cursor ${f.cursor} (never queued, or pruned after every consumer acked it)`);
    const by = `host:${hostName}`;
    let recorded = false;
    let agent: string | undefined;
    try {
      const r = await this.ingress.redispatch(item, {
        by,
        ...(f.agent !== undefined ? { agent: f.agent } : {}),
        ...(f.session !== undefined ? { session: f.session } : {}),
        ...(f.launch !== undefined ? { launch: f.launch } : {}),
        beforeDeliver: (d, inputId, launch) => {
          // The session's own agent: a named agent must match it (as session.prepare checks).
          const had = this.laneInfo.get(d.sessionKey)?.agent.name ?? this.records.agentOf(d.sessionKey);
          if (f.agent !== undefined && had !== undefined && had !== f.agent) return { ok: false, code: 'agent_conflict', message: `session ${d.sessionKey} belongs to agent ${had}` };
          agent = had ?? d.agent;
          const pending = {
            cursor: item.cursor,
            of: item.input.inputId,
            inputId,
            sessionKey: d.sessionKey,
            ...(agent ? { agent } : {}),
            on: d.on === 'dispatch' ? 'dispatch' : 'context',
            ...(launch ? { launch } : {}),
            at: Date.now(),
            by,
            duplicate: false,
            pending: true,
          };
          // A concurrent request on another connection for this cursor waits on the map, so this is the first.
          recorded = this.hostQueue.recordRedispatch(item.cursor, pending);
          return recorded ? { ok: true } : { ok: false, code: 'conflict', message: `cursor ${item.cursor} is being redispatched` };
        },
      });
      if (!r.ok) {
        if (recorded) this.hostQueue.dropRedispatch(item.cursor);
        return fail(r.code === 'task_agent' ? 'not_interactive_agent' : r.code, r.message);
      }
      const res = r.outcome.result;
      const refused = r.outcome.unavailable ? fail(r.outcome.unavailable.code, r.outcome.unavailable.message) : res && !res.ok ? fail(res.reason, `session ${r.delivery.sessionKey} refused the input: ${res.reason}`) : undefined;
      if (refused) {
        this.hostQueue.dropRedispatch(item.cursor);
        return refused;
      }
      const value: InboundRedispatchResult = {
        cursor: item.cursor,
        of: item.input.inputId,
        inputId: r.inputId,
        sessionKey: r.delivery.sessionKey,
        ...(agent ? { agent } : {}),
        on: r.delivery.on === 'dispatch' ? 'dispatch' : 'context',
        ...(r.launch ? { launch: r.launch } : {}),
        ...(res?.ok && res.disposition !== undefined ? { disposition: res.disposition } : {}),
        at: Date.now(),
        by,
        duplicate: false,
      };
      this.hostQueue.finishRedispatch(item.cursor, value);
      this.log('info', `host ${hostName} redispatched inbound ${item.cursor} (${item.input.inputId}) to ${value.sessionKey}`);
      return { ok: true, value };
    } catch (e) {
      if (recorded) this.hostQueue.dropRedispatch(item.cursor);
      throw e;
    }
  }

  /**
   * The adapters one launched session opens, built lazily per instance and kept
   * (the lane compares adapters by identity: a new object each time would restart
   * the harness every turn). Claude takes the env per session; a Codex session with
   * env gets its own stdio app-server (like a task run), closed with the lane.
   */
  private launchAdapters(agent: AgentConfig, launch: SessionLaunch): LaunchAdapters {
    const c = this.o.config;
    const env = launch.env ?? {};
    const hasEnv = Object.keys(env).length > 0;
    const cache = new Map<string, HarnessAdapter>();
    const owned: HarnessAdapter[] = [];
    const adapter = (name: string): HarnessAdapter => {
      const key = this.o.harness ? '' : name;
      let a = cache.get(key);
      if (a) return a;
      if (this.o.harness) a = withLaunch(this.o.harness, undefined, hasEnv ? env : undefined);
      else {
        const inst = c.harnesses[name];
        if (!inst) throw new Error(`unknown harness instance ${JSON.stringify(name)}`);
        let base: HarnessAdapter;
        let perOpen: Record<string, string> | undefined = hasEnv ? env : undefined;
        if (inst.kind === 'codex' && hasEnv) {
          if (inst.codex.transport.kind === 'unix') throw new Error(`launch_unsupported: harness instance ${name} is a shared Codex app-server (unix transport); this session's env cannot apply there`);
          // The env reaches only this session's app-server; its CODEX_HOME replaces the instance's.
          const own = {
            ...inst,
            env: { ...inst.env, ...env },
            codex: { ...inst.codex, transport: { kind: 'stdio' as const }, ...(env.CODEX_HOME !== undefined ? { codexHome: env.CODEX_HOME } : {}) },
          } as HarnessInstance;
          base = this.build(own);
          owned.push(base);
          perOpen = undefined;
        } else base = this.harness(name);
        const cwd = launch.cwd ?? (name === agent.harness ? agent.cwd : undefined);
        a = withLaunch(name === agent.harness ? withAgent(base, agent, agent.cwd) : base, cwd, perOpen);
      }
      cache.set(key, a);
      return a;
    };
    return {
      adapter,
      owns: () => owned.length > 0,
      dispose: async () => {
        await Promise.all(owned.map((a) => within(codexOf(a)?.dispose(), 3000)));
      },
    };
  }

  /** The adapter an agent's sessions open: its instance's, with the agent's cwd and instructions. */
  private agentHarness(agent: AgentConfig): HarnessAdapter {
    if (this.o.harness || !agent.configured) return this.harness(agent.harness);
    let a = this.agentAdapters.get(agent.name);
    if (!a) {
      a = withAgent(this.harness(agent.harness), agent, agent.cwd);
      this.agentAdapters.set(agent.name, a);
    }
    return a;
  }

  /** Configured agents plan their own harness, model, effort and (when set) profile; the policy's profile otherwise. */
  private agentPolicy(agent: AgentConfig): FullPolicy {
    if (!agent.configured || this.o.policy?.plan) return this.policy;
    const policy = this.policy;
    const inst = this.o.config.harnesses[agent.harness]!;
    return {
      ...policy,
      plan: async (draft) => {
        const p = await policy.plan(draft);
        return { ...agentRun(agent, inst), profile: agent.profile ?? p.profile };
      },
    };
  }

  /**
   * The lane of one task run: its own harness adapter, built for this run with the
   * request env over the instance's (the child's environment only), the run's cwd,
   * the agent's run config, and no retry of an unconsumed input.
   */
  private openRunLane(r: { runId: string; sessionKey: string; agent: AgentConfig; cwd: string; env: Record<string, string>; turnId: string }): { lane: Lane; dispose(): Promise<void> } {
    const c = this.o.config;
    const inst = c.harnesses[r.agent.harness];
    if (!inst) throw new Error(`agent ${r.agent.name}: unknown harness instance ${r.agent.harness}`);
    // AGENTS_IO_RUN_ID lets a host command run in the workspace tie itself to this run. There is no
    // per-run provenance variable: it was a constant the host that started the run already knows (decision 13).
    const env = { ...r.env, AGENTS_IO_RUN_ID: r.runId };
    let adapter: HarnessAdapter;
    let own: HarnessAdapter | undefined;
    if (this.o.harness) adapter = this.o.harness;
    else {
      // A Codex run gets its own app-server over stdio: the env reaches only this run's child, which ends with it.
      const runInst = {
        ...inst,
        cwd: r.cwd,
        env: { ...inst.env, ...env },
        ...(inst.kind === 'codex' ? { codex: { ...inst.codex, transport: { kind: 'stdio' as const } } } : {}),
      } as HarnessInstance;
      own = this.build(runInst);
      adapter = withAgent(own, r.agent, r.cwd);
    }
    const spec: RunSpec = { ...agentRun(r.agent, inst), profile: r.agent.profile ?? 'restricted' };
    let firstTurn = true;
    const lane = new Lane({
      sessionKey: r.sessionKey,
      harness: adapter,
      hub: this.hub,
      policy: { ...this.policy, plan: async () => spec },
      cwd: r.cwd,
      requeueLimit: 0,
      newId: (p) => {
        if (p === 'turn' && firstTurn) {
          firstTurn = false;
          return r.turnId;
        }
        return `${p}_${randomUUID()}`;
      },
      ...(this.mcp && r.agent.tools ? { mcp: (a: { sessionKey: string; generation: number; harnessId: string }) => this.mcp!.mcpFor(a) } : {}),
      onHarnessEvent: (e) => this.o.onHarnessEvent?.(r.sessionKey, e),
    });
    this.lanes.set(r.sessionKey, lane);
    this.laneInfo.set(r.sessionKey, { agent: r.agent, cwd: r.cwd });
    for (const ch of this.channels) this.compose(r.sessionKey, ch.adapter, ch.tier, ch.account);
    return {
      lane,
      dispose: async () => {
        await within(lane.close('run ended').catch(() => undefined), 8000);
        await within(lane.whenIdle(), 3000);
        const comps = this.sessionCompositors.get(r.sessionKey) ?? [];
        await within(Promise.all(comps.map((x) => x.stop())), 5000);
        this.sessionCompositors.delete(r.sessionKey);
        for (const x of comps) this.compositors.splice(this.compositors.indexOf(x), 1);
        this.lanes.delete(r.sessionKey);
        this.laneInfo.delete(r.sessionKey);
        await within(codexOf(own)?.dispose(), 3000);
      },
    };
  }

  /** `deliver`: send a host's message through the outbox, idempotent per operationId (across restarts too). */
  async deliver(hostName: string, f: Extract<HostRequestFrame, { type: 'deliver' }>): Promise<Outcome> {
    if (this.stopped) return fail('stopped', 'daemon is stopping');
    if (!f.operationId) return fail('invalid_frame', 'operationId is empty');
    // Host operation ids get their own namespace, apart from the compositor's and the output tools'.
    const operationId = `host:${f.operationId}`;
    const settled = this.outbox.get(operationId);
    if (settled) return { ok: true, value: { ...settled, operationId: f.operationId, duplicate: true } };
    const ch = this.channelFor(f.route);
    if (!ch) return fail('unknown_channel', this.noChannelMessage(f.route));
    // A single-entry fallback sends as that entry's account (the adapter refuses routes of other accounts).
    // Not agent-authored (the host speaks): no `as`.
    const rec = await this.outbox.send(ch.adapter, { operationId, sessionKey: `host:${hostName}`, route: { ...f.route, account: ch.account }, msg: f.message });
    return { ok: true, value: { ...rec, operationId: f.operationId, duplicate: false } };
  }

  // ---- topics (decision 6) -------------------------------------------------

  /**
   * A session refused an input because its agent is gone (`agent_unavailable`): a
   * notice and `input.rejected` in its log, a warning, and — given a route (a
   * dispatched channel message) — one short message there (local ends read their stream).
   */
  private async refuseUnavailable(sessionKey: string, code: string, message: string, inputId: string, route: ReplyRoute | null): Promise<void> {
    this.log('warn', `${code}: ${message}`);
    const ev = { ts: Date.now(), level: 'primary' as const, audience: 'status' as const, durability: 'durable' as const, visibility: 'participants' as const };
    this.hub.append(sessionKey, { ...ev, body: { t: 'notice', code: 'other', message: `${code}: ${message}` } });
    this.hub.append(sessionKey, { ...ev, body: { t: 'input.rejected', inputIds: [inputId], reason: code } });
    if (route && route.channel !== 'local') {
      const text =
        code === 'agent_unavailable'
          ? 'This conversation\'s agent is not available any more, so the message was not delivered. Ask the operator to restore it.'
          : `This conversation could not be started (${code}), so the message was not delivered. Ask the operator.`;
      await this.systemReply({ route, text, operationId: `${code}:${inputId}`, sessionKey });
    }
  }

  /** A topic command's answer: one plain message on the route, through the outbox (recorded in the topic's session). */
  private async systemReply(a: { route: ReplyRoute; text: string; operationId: string; sessionKey: string }): Promise<void> {
    const ch = this.channelFor(a.route);
    if (!ch) {
      // Local ends read their stream; a channel route with no instance is never sent as another account (decision 8).
      if (a.route.channel !== 'local') this.log('warn', `system reply not sent: ${this.noChannelMessage(a.route)}`);
      return;
    }
    const { replyToMessageId: _r, ...route } = { ...a.route, account: ch.account };
    await this.outbox.send(ch.adapter, { operationId: a.operationId, sessionKey: a.sessionKey, route, msg: { text: a.text } });
  }

  /**
   * Hand a turn's triggering inputs to the topic now current (session_rotate /
   * session_switch): the same records under new ids, queued there; `context`
   * first, as a context item. Then the conversation's messages still queued behind
   * that turn follow it (they were sent to the topic that is no longer current).
   * The turn that handed them over ends on its own. If the handover fails, the
   * conversation goes back to `from` and the turn is told to answer there.
   */
  private async handOver(from: TopicRecord, to: TopicRecord, turn: TurnContext, context?: InputRecord): Promise<string[]> {
    let lane!: Lane;
    const send = async (i: InputRecord) => {
      const { topic: _topic, topicTitle: _title, topicTools: _tools, ...ctx } = i.channelContext;
      // Handed over on purpose: this topic answers it (the session_* tools refuse to move it again).
      const input: InputRecord = { ...i, inputId: `${i.inputId}>${to.id}`, channelContext: { ...ctx, ...topicContext(to, HANDED_HINT), handedFrom: turn.sessionKey } };
      const r = await lane.command({ type: 'input', sessionKey: to.sessionKey, input, mode: 'queue' });
      if (!r.ok) throw new Error(r.reason);
      return input.inputId;
    };
    const handed: string[] = [];
    try {
      // Inside the try: a target topic whose agent is gone (`agent_unavailable`) also sends the conversation back.
      lane = this.lane(to.sessionKey, to.agent);
      if (context) {
        const r = await lane.observe(context);
        if (!r.ok) throw new Error(r.reason);
      }
      for (const i of turn.inputs) if (i.channelContext.context !== true) handed.push(await send(i));
    } catch (e) {
      // Nothing was handed: the conversation stays where the message is (reason system; the turn's card answers as usual).
      if (this.topics.current(from.conversation, from.agent)?.id !== from.id) this.topics.switchTo(from.id, 'system', { turn: turnRef(turn) });
      throw new ToolError(`handing the message to topic ${to.id} failed (${(e as Error).message}); the conversation stays in this topic: answer the message here`);
    }
    // Messages of this topic still queued here (not context, not answers to a question this topic asked).
    const old = this.lanes.get(turn.sessionKey);
    const queued = old ? await old.take((i) => i.channelContext.topic === from.id && i.channelContext.context !== true && !i.content.some((c) => c.type === 'event'), 'moved_to_topic') : [];
    for (const i of queued) {
      try {
        handed.push(await send(i));
      } catch (e) {
        this.log('warn', `${turn.sessionKey}: moving queued input ${i.inputId} to topic ${to.id} failed: ${(e as Error).message}`);
      }
    }
    return handed;
  }

  private topicOfSession(sessionKey: string): TopicRecord {
    const t = this.topics.bySession(sessionKey);
    if (!t) throw new ToolError('this session is not a topic of a conversation');
    return t;
  }

  /** session_rotate: a new topic, current from now on, gets the turn's inputs with the summary ahead of them. */
  // ---- live (decision 11) ----------------------------------------------------

  private async joinLive(sessionKey: string, turn: TurnContext, a: { target: string; channel?: string; instructions?: string; voice?: string }) {
    const lane = this.lanes.get(sessionKey);
    if (!lane) throw new ToolError(`no session ${sessionKey}`);
    const cur = this.lives.get(sessionKey);
    if (cur) throw new ToolError(`already in a live (${cur.endpoint.title}); live_leave first`);
    // Decision 11: one live per session. Claimed before the first await, so a concurrent join is refused
    // without touching the running one and without opening an endpoint of its own.
    if (this.joining.has(sessionKey)) throw new ToolError('another live_join is in progress for this session; at most one live per session');
    this.joining.add(sessionKey);
    let endpoint: LiveEndpoint;
    let ch: RunningChannel;
    const liveId = `live_${randomUUID().slice(0, 8)}`;
    try {
      ch = this.liveChannel(turn, a.channel);
      // DL-5: where a live happens is an outbound destination like any other (the bot speaks
      // there). Asked before opening when the channel can name the route; otherwise of the
      // opened endpoint, which is closed again when denied.
      const at = ch.adapter.liveRoute?.(ch.account, a.target);
      if (at) await this.liveAllowed(turn, at);
      endpoint = await ch.adapter.openLive!(ch.account, a.target);
      if (!at || routeKey(at) !== routeKey(endpoint.route)) {
        const opened = endpoint;
        await this.liveAllowed(turn, opened.route).catch(async (e: unknown) => {
          await opened.close('not an allowed destination').catch(() => undefined);
          throw e;
        });
      }
      // stop() already left the lives it knew of: a join that lands after that is closed here.
      if (this.stopped) {
        await endpoint.close('gateway stopping').catch(() => undefined);
        throw new ToolError('the gateway is stopping');
      }
      this.lives.set(sessionKey, { liveId, endpoint });
    } finally {
      this.joining.delete(sessionKey);
    }
    try {
      const offer = endpoint.offer;
      let transport: LiveStartArgs['transport'];
      if (offer.type === 'webrtc') transport = offer;
      else {
        if (!endpoint.media) throw new ToolError(`channel ${ch.adapter.id} opened a frames endpoint without media`);
        transport = { ...offer, media: endpoint.media };
      }
      // The lane refuses a transport the harness's live does not list, before `start`.
      const { answerSdp } = await lane
        .startLive(
          { liveId, title: endpoint.title, route: endpoint.route, controlRoute: turn.replyRoute },
          { transport, instructions: a.instructions ?? DEFAULT_LIVE_INSTRUCTIONS, ...(a.voice ? { voice: a.voice } : {}) },
        )
        .catch((e: Error) => {
          throw e instanceof LiveTransportError ? new ToolError(`${e.message}; ${endpoint.title} is a ${offer.type} endpoint`) : e;
        });
      if (offer.type === 'webrtc') {
        if (answerSdp === undefined) throw new Error(`harness ${lane.harnessId} gave no SDP answer`);
        if (!endpoint.answer) throw new Error(`channel ${ch.adapter.id} opened a webrtc endpoint that cannot take an answer`);
        await endpoint.answer(answerSdp);
      }
    } catch (e) {
      if (this.lives.get(sessionKey)?.liveId === liveId) this.lives.delete(sessionKey);
      await lane.stopLive().catch(() => undefined);
      await endpoint.close(`join failed: ${(e as Error).message}`).catch(() => undefined);
      throw e;
    }
    if (this.stopped) {
      await this.leaveLive(sessionKey, 'gateway stopping');
      throw new ToolError('the gateway is stopping');
    }
    this.log('info', `${sessionKey}: live ${liveId} joined ${endpoint.title}`);
    // The far side ended it (left, removed, meeting over): stop the voice; its live.ended closes the rest.
    void endpoint.ended.then((reason) => {
      if (this.lives.get(sessionKey)?.liveId !== liveId) return;
      this.log('info', `${sessionKey}: live ${liveId} ended by the channel (${reason})`);
      void lane.stopLive().catch(() => undefined);
    });
    return { liveId, title: endpoint.title, route: routeKey(endpoint.route) };
  }

  /** `Policy.outbound` for a live destination; a deny or a failing check refuses (fail closed). */
  private async liveAllowed(turn: TurnContext, to: ReplyRoute): Promise<void> {
    const v = await this.policy.outbound({ from: turn, to }).catch(() => 'deny' as const);
    if (v !== 'allow') throw new ToolError(`live_join: ${routeKey(to)} is not an allowed destination (Policy.outbound; preregister it in policy.routes)`);
  }

  /** The channel a live opens on: `spec` (id or id:account), else the turn's reply channel. */
  private liveChannel(turn: TurnContext, spec: string | undefined): RunningChannel {
    const able = this.channels.filter((c) => typeof c.adapter.openLive === 'function');
    const names = able.map((c) => `${c.adapter.id}:${c.account}`).join(', ') || 'none';
    let ch: RunningChannel | undefined;
    if (spec) {
      const [id, account] = spec.split(':');
      const same = this.channels.filter((c) => c.adapter.id === id && (account === undefined || c.account === account));
      ch = same.length === 1 ? same[0] : undefined;
      if (!ch) throw new ToolError(`no single running channel ${spec} (channels that can open a live: ${names})`);
    } else {
      if (!turn.replyRoute) throw new ToolError(`this turn has no reply channel; name one with \`channel\` (channels that can open a live: ${names})`);
      ch = this.channelFor(turn.replyRoute);
      if (!ch) throw new ToolError(`no running channel for ${routeKey(turn.replyRoute)}`);
    }
    if (typeof ch.adapter.openLive !== 'function') throw new ToolError(`channel ${ch.adapter.id} cannot open a live session (channels that can: ${names})`);
    return ch;
  }

  private async leaveLive(sessionKey: string, reason: string): Promise<boolean> {
    const cur = this.lives.get(sessionKey);
    if (!cur) return false;
    this.lives.delete(sessionKey);
    await this.lanes.get(sessionKey)?.stopLive().catch(() => undefined);
    await cur.endpoint.close(reason).catch((e: Error) => this.log('warn', `${sessionKey}: closing live ${cur.liveId}: ${e.message}`));
    return true;
  }

  /** The harness ended the live (voice closed, harness gone): leave the channel side too. */
  private liveEnded(sessionKey: string, liveId: string, reason: string): void {
    const cur = this.lives.get(sessionKey);
    if (!cur || cur.liveId !== liveId) return;
    this.lives.delete(sessionKey);
    this.log('info', `${sessionKey}: live ${liveId} ended (${reason})`);
    void cur.endpoint.close(reason).catch((e: Error) => this.log('warn', `${sessionKey}: closing live ${liveId}: ${e.message}`));
  }

  private async rotateTopic(sessionKey: string, turn: TurnContext, a: { title: string; summary: string }): Promise<TopicHandover> {
    const from = this.topicOfSession(sessionKey);
    // The summary describes the topic being left: it is saved on it (and handed to the new one as context).
    const r = this.router.newTopic(from.agent, from.conversation, { title: a.title }, 'agent', { turn: turnRef(turn), summaryOfPrevious: a.summary });
    const summary: InputRecord = {
      inputId: `sum_${turn.turnId}`,
      origin: { kind: 'system', principal: null, evidence: 'none', via: `topic:${from.id}`, adapter: 'session' },
      content: [{ type: 'text', text: `[Summary of the previous topic${from.title ? ` "${from.title}"` : ''} (${from.id}), written when this topic was started]
${a.summary}` }],
      replyRoute: turn.replyRoute,
      channelContext: { topicSummary: true, fromTopic: from.id },
    };
    const handed = await this.handOver(from, r.topic, turn, summary);
    this.log('info', `${sessionKey}: rotated to topic ${r.topic.id} (${r.topic.sessionKey}), ${handed.length} input(s) handed over`);
    return { topic: topicView(r.topic), previous: topicView(from), handed };
  }

  /** session_switch: a parked topic becomes current again and gets the turn's inputs (its lane resumes the harness session). */
  private async switchTopicFor(sessionKey: string, turn: TurnContext, topicId: string): Promise<TopicHandover> {
    const from = this.topicOfSession(sessionKey);
    const target = this.topics.get(topicId);
    if (!target || target.conversation !== from.conversation || target.agent !== from.agent) throw new ToolError(`no topic ${topicId} in this conversation`);
    const r = this.topics.switchTo(topicId, 'agent', { turn: turnRef(turn) });
    const handed = await this.handOver(from, r.topic, turn);
    this.log('info', `${sessionKey}: switched back to topic ${r.topic.id} (${r.topic.sessionKey}), ${handed.length} input(s) handed over`);
    return { topic: topicView(r.topic), ...(r.previous ? { previous: topicView(r.previous) } : {}), handed };
  }

  /** A topic was parked: its lane idles out; the one now current keeps its lane. */
  private topicChanged(c: TopicChange): void {
    // A new topic of a launched conversation keeps its launch. Synchronous on purpose:
    // TopicRegistry.create calls this after its commit and before it returns, so the
    // launch is pinned before the caller (handOver, `/new`) opens the new topic's lane.
    if (c.created && c.from) {
      const launch = this.records.launchOf(c.from.sessionKey);
      if (launch && this.records.agentOf(c.to.sessionKey) === undefined && !this.records.launchOf(c.to.sessionKey)) {
        try {
          this.records.pin(c.to.sessionKey, c.to.agent, launch);
        } catch (e) {
          this.log('warn', `${c.to.sessionKey}: keeping the launch of ${c.from.sessionKey} failed: ${(e as Error).message}`);
        }
      }
    }
    const t = this.parkedTimers.get(c.to.sessionKey);
    if (t) clearTimeout(t);
    this.parkedTimers.delete(c.to.sessionKey);
    if (c.from && c.from.sessionKey !== c.to.sessionKey && this.lanes.has(c.from.sessionKey)) this.idleOut(c.from.sessionKey);
  }

  /** Close a parked topic's lane after `topics.parkedIdleMs` (later while it still has work); switching back reopens and resumes it. */
  private idleOut(sessionKey: string): void {
    const ms = this.o.config.topics?.parkedIdleMs ?? 0;
    if (ms <= 0 || this.stopped) return;
    const prior = this.parkedTimers.get(sessionKey);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      this.parkedTimers.delete(sessionKey);
      const lane = this.lanes.get(sessionKey);
      if (this.stopped || !lane || this.topics.bySession(sessionKey)?.state !== 'parked') return;
      if (lane.activeTurn() || lane.queued().length) return this.idleOut(sessionKey);
      void this.closeLane(sessionKey, lane, 'topic parked').catch((e) => this.log('warn', `${sessionKey}: closing parked topic failed: ${(e as Error).message}`));
    }, ms);
    timer.unref?.();
    this.parkedTimers.set(sessionKey, timer);
  }

  /** Drop a lane and its renderers, then close its harness session (its log stays: the next lane resumes from it). */
  private async closeLane(sessionKey: string, lane: Lane, reason: string): Promise<void> {
    this.lanes.delete(sessionKey);
    this.laneInfo.delete(sessionKey);
    const launched = this.launched.get(sessionKey);
    this.launched.delete(sessionKey);
    const comps = this.sessionCompositors.get(sessionKey) ?? [];
    this.sessionCompositors.delete(sessionKey);
    await within(lane.close(reason).catch(() => undefined), 8000);
    await within(lane.whenIdle(), 3000);
    await within(Promise.all(comps.map((x) => x.stop())), 5000);
    for (const x of comps) this.compositors.splice(this.compositors.indexOf(x), 1);
    await launched?.dispose();
    this.log('info', `${sessionKey}: lane closed (${reason})`);
  }

  /** `topic.list`: newest activity first, only those of `conversation` / `sessionKey` when given. */
  topicList(f: { conversation?: string; sessionKey?: string }) {
    return this.topics.list({ ...(f.conversation !== undefined ? { conversation: f.conversation } : {}), ...(f.sessionKey !== undefined ? { sessionKey: f.sessionKey } : {}) }).map(topicView);
  }

  /** `topic.switch` from a client or the host, checked by `Policy.control` as a `reset` of the conversation's current topic session. */
  async topicSwitch(f: TopicSwitchFrame, origin: Origin): Promise<Outcome> {
    if (this.stopped) return fail('stopped', 'daemon is stopping');
    const hasId = 'topicId' in f && f.topicId !== undefined;
    const hasNew = 'new' in f && f.new !== undefined;
    if (hasId === hasNew) return fail('invalid_frame', 'topic.switch takes exactly one of topicId and new');
    const all = this.topics.list({ conversation: f.conversation });
    if (!all.length) return fail('unknown_conversation', `no topics in conversation ${f.conversation}`);
    const target = hasId ? all.find((t) => t.id === (f as { topicId: string }).topicId) : undefined;
    if (hasId && !target) return fail('unknown_topic', `no topic ${(f as { topicId: string }).topicId} in conversation ${f.conversation}`);
    const agent = target?.agent ?? all.find((t) => t.state === 'current')?.agent ?? all[0]!.agent;
    const cur = this.topics.current(f.conversation, agent);
    const verdict = await this.policy.control({ sessionKey: cur?.sessionKey ?? all[0]!.sessionKey, op: 'reset', origin });
    if (verdict !== 'allow') return fail('forbidden', 'not allowed to change the topics of this conversation');
    const reason = isHostOrigin(origin) ? 'system' : 'user';
    try {
      const r = target ? this.topics.switchTo(target.id, reason) : this.router.newTopic(agent, f.conversation, (f as { new: { title?: string } }).new, reason);
      return { ok: true, value: { topic: topicView(r.topic), ...(r.previous ? { previous: topicView(r.previous) } : {}), created: r.created } };
    } catch (e) {
      if (e instanceof TopicError) return fail(e.code, e.message);
      throw e;
    }
  }

  /** The instance's own session/thread id last bound to this session, so a restart resumes it. */
  private nativeIdOf(sessionKey: string, harnessId: string): string | undefined {
    let id: string | undefined;
    for (const e of this.hub.log.read(sessionKey, 0)) {
      if (e.body.t === 'session.bound' && e.harness === harnessId) id = e.body.nativeId;
    }
    return id;
  }

  private compose(sessionKey: string, adapter: ChannelAdapter, tier: Tier | undefined, account: string): void {
    const c = new Compositor({
      hub: this.hub,
      sessionKey,
      adapter,
      // Each bot renders its own routes only: two Lark bots must not race for one reply.
      account,
      outbox: this.outbox,
      // Every message the session's agent produces says who wrote it (POSITIONING §2 identity declaration).
      as: agentIdentity(sessionKey),
      ...(tier ? { tier } : {}),
      // A stop button on streaming cards; Ingress turns its click into an `interrupt` command.
      interruptButton: true,
      // Cards of a topic session carry the topic's title (Lark: the card header).
      title: () => this.topics.bySession(sessionKey)?.title,
      onError: (err) => this.log('warn', `render to ${adapter.id} failed: ${(err as Error).message}`),
    });
    c.start();
    this.compositorAdapter.set(c, adapter);
    this.compositors.push(c);
    const list = this.sessionCompositors.get(sessionKey);
    if (list) list.push(c);
    else this.sessionCompositors.set(sessionKey, [c]);
  }

  private async startChannels(): Promise<void> {
    const all: BuiltChannel[] = [];
    const closeAll = () => Promise.all(all.map((c) => c.close?.().catch(() => undefined)));
    try {
      let i = 0;
      for (const ch of this.o.config.channels) all.push(await this.buildConfigChannel(ch, i++));
      for (const x of this.o.channels ?? []) all.push({ adapter: x.adapter, account: x.account ?? 'default', owner: x.adapter.constructor, ...(x.tier ? { tier: x.tier } : {}) });
      // Only now is a module channel's id known: one channel id belongs to one adapter, one (channel, account)
      // is one route target. A bridge without `id` that has not connected yet is checked at its hello.
      const known: BuiltChannel[] = [];
      for (const c of all) {
        if (!idKnown(c)) continue;
        const why = idConflict(c.adapter.id, c.owner, c.account, known);
        if (why) throw new ConfigError(why);
        known.push(c);
      }
    } catch (e) {
      await closeAll();
      throw e;
    }
    for (const b of all) this.launchChannel(b);
  }

  /**
   * Build one configured channel (not started yet). A bridge whose first `hello` fails
   * does not stop the daemon: once launched it is listed `failed` with the reason and
   * keeps being retried with the bridge's restart backoff; it turns `running` once a
   * peer answers.
   */
  private async buildConfigChannel(cfg: ResolvedChannel, index: number): Promise<BuiltChannel> {
    let entry: RunningChannel | undefined;
    let early: BridgeState | undefined;
    const onState = (st: BridgeState) => {
      if (!entry) return void (early = st);
      this.bridgeState(entry, st);
    };
    const owner = channelOwner(cfg);
    // Each hello's id is checked against the running channels (a bridge without `id` learns its id there).
    const acceptId = (id: string) => idConflict(id, owner, cfg.account, this.channels.filter((e) => e !== entry));
    const own = this.o.channelAdapter?.(cfg);
    const built = own ? { adapter: own, account: cfg.account, ...(cfg.tier ? { tier: cfg.tier } : {}) } : await buildChannel(cfg, index, (l, m, d) => this.log(l, m, d), onState, acceptId);
    return {
      ...built,
      owner,
      source: cfg,
      bind: (e) => {
        entry = e;
        if (early) this.bridgeState(e, early);
      },
    };
  }

  private launchChannel(b: BuiltChannel): RunningChannel {
    const e = this.startChannel(b);
    if (b.source) e.source = b.source;
    b.bind?.(e);
    // A bridge's caps are its peer's: checked once it connects (bridgeState).
    if (idKnown(b) && !isBridge(b.adapter)) this.checkGrant(e);
    return e;
  }

  /**
   * The source a channel's envelopes are stamped against: its id and account, and
   * the evidence it may give — the entry's `evidence` grant (default: caps for
   * built-in and embedded adapters, `device_only` for bridges and modules) ∩ the
   * adapter's current `caps.evidence` (a bridge's change with each hello), plus `none`.
   */
  private emitSource(e: RunningChannel): EmitSource {
    const caps = e.adapter.caps(e.account);
    const grant = e.source?.evidence ?? (grantedByDefault(e.owner) ? caps.evidence : UNGRANTED_EVIDENCE);
    const evidence: Evidence[] = [...caps.evidence.filter((x) => grant.includes(x)), 'none'];
    return { channel: e.adapter.id, account: e.account, evidence, declaresSender: caps.declaresSender };
  }

  /** Warn about an `evidence` grant the adapter cannot give (it is only intersected with caps). */
  private checkGrant(e: RunningChannel): void {
    const caps = e.adapter.caps(e.account).evidence;
    const extra = (e.source?.evidence ?? []).filter((x) => x !== 'none' && !caps.includes(x));
    if (extra.length) this.log('warn', `channel ${e.adapter.id} (${e.account}): evidence ${extra.join(', ')} granted in the config, but the adapter cannot give it (caps.evidence: ${caps.join(', ') || 'none'}); ignored`);
  }

  /** Count and log (one per reason a minute) what stamping did to an envelope from `e`. */
  private stamped(e: RunningChannel, env: InboundEnvelope, r: IngressResult): void {
    const warn = (reason: string, msg: string) => {
      const now = Date.now();
      const at = (e.warnedAt ??= new Map()).get(reason);
      if (at !== undefined && now - at < 60_000) return;
      e.warnedAt.set(reason, now);
      this.log('warn', `channel ${e.adapter.id} (${e.account}): ${msg} (status counts every one)`);
    };
    if (!r.accepted && r.error?.startsWith(SOURCE_MISMATCH)) {
      e.rejected++;
      warn('source', `refused envelope ${env.id}: ${r.error.slice(SOURCE_MISMATCH.length).trim()}`);
    } else if (r.claimedEvidence !== undefined && r.action !== 'duplicate') {
      e.evidenceCapped++;
      warn('evidence', `envelope ${env.id} claims evidence ${r.claimedEvidence}, beyond this channel's cap (grant it with "evidence" on the channel entry); taken as none`);
    }
  }

  /** Build and start one configured channel next to the running ones (live apply). */
  private async startConfigChannel(cfg: ResolvedChannel, index: number): Promise<RunningChannel> {
    const b = await this.buildConfigChannel(cfg, index);
    // stop() may have run while it was built: close it rather than start it into closed stores.
    if (this.stopped) {
      await b.close?.().catch(() => undefined);
      throw new Error('gateway stopping');
    }
    const why = idKnown(b) ? idConflict(b.adapter.id, b.owner, b.account, this.channels) : undefined;
    if (why) {
      await b.close?.().catch(() => undefined);
      throw new ConfigError(why);
    }
    return this.launchChannel(b);
  }

  private bridgeState(entry: RunningChannel, st: BridgeState): void {
    if (entry.ac.signal.aborted || entry.state === 'stopped') return;
    entry.reported = true;
    const was = entry.state;
    if (st.connected) {
      entry.state = 'running';
      delete entry.error;
      if (was === 'failed') this.log('info', `channel ${entry.adapter.id} (${entry.account}) connected`);
      this.checkGrant(entry);
    } else {
      entry.state = 'failed';
      entry.error = `${st.error ?? 'not connected'}; retrying`;
      if (was !== 'failed') this.log('warn', `channel ${entry.adapter.id} (${entry.account}): ${entry.error}`);
    }
  }

  /**
   * `console.liveChannels`: make the running configured channels match the config file's
   * `channels` (after `PUT /api/config` or a provisioned bot). Entries are compared as
   * resolved (env references substituted, so a changed secret counts as a change):
   * removed and changed ones stop, new and changed ones start (stops first, so an app
   * moved to another entry never runs twice), unchanged ones keep running (one whose
   * `start` already ended is started again).
   *
   * `started` lists channels launched that had not failed when the answer was made: a
   * bridge whose first connect failed (it keeps retrying), or a channel whose `start`
   * rejects within `channelStartGraceMs`, is listed in `failed` instead, and so is an
   * unchanged one still failing; the file then does not count as applied. A failure
   * an adapter only logs (it retries internally, as lark-bot does with bad credentials)
   * or one after the grace shows in `GET /api/status` only. Returns
   * undefined when it is off, there is no config file, or the file does not resolve.
   */
  applyChannels(): Promise<{ applied: 'live' | 'restart'; channels: AdminChannelsApplied } | undefined> {
    const p = this.applying.then(() => this.applyChannelsNow());
    this.applying = p.catch(() => undefined);
    return p;
  }

  private async applyChannelsNow(): Promise<{ applied: 'live' | 'restart'; channels: AdminChannelsApplied } | undefined> {
    const store = this.configStore;
    if (this.stopped || !store || !this.o.config.console.liveChannels) return undefined;
    const cur = store.read();
    if (cur.parseError) return undefined;
    let next: ResolvedChannel[];
    try {
      next = store.resolve(cur.raw).channels;
    } catch (e) {
      this.log('warn', `config channels not applied: ${(e as Error).message}`);
      return undefined;
    }
    const ref = (c: ResolvedChannel) => ({ type: c.type, account: c.account });
    const want = next.map((c, index) => ({ c, index, key: canonical(c), kept: false }));
    const stop: RunningChannel[] = [];
    for (const e of this.channels) {
      if (!e.source) continue;
      if (e.ended) {
        stop.push(e);
        continue;
      }
      const key = canonical(e.source);
      const same = want.find((w) => !w.kept && w.key === key);
      if (same) same.kept = true;
      else stop.push(e);
    }
    const out: AdminChannelsApplied = { started: [], stopped: [] };
    for (const e of stop) {
      await this.stopChannel(e);
      out.stopped.push(ref(e.source!));
    }
    const failed: NonNullable<AdminChannelsApplied['failed']> = [];
    const launched: RunningChannel[] = [];
    for (const w of want) {
      if (w.kept) continue;
      if (this.stopped) break;
      try {
        const e = await this.startConfigChannel(w.c, w.index);
        // Sessions already open render to it too, as if it had been there at their start.
        for (const key of this.lanes.keys()) this.compose(key, e.adapter, e.tier, e.account);
        launched.push(e);
      } catch (err) {
        failed.push({ ...ref(w.c), error: (err as Error).message });
        // Under its channel id when the entry names one (a bridge's `id`); a module's id is only known once loaded.
        const id = 'id' in w.c && typeof w.c.id === 'string' ? w.c.id : w.c.type;
        this.configured.set(`${id}\0${w.c.account}`, { id, account: w.c.account });
        this.log('error', `channel ${w.c.type} (${w.c.account}) not started: ${(err as Error).message}`);
      }
    }
    // A start that fails at once (bad config, unreachable service) is not reported as started.
    const grace = this.o.channelStartGraceMs ?? 1000;
    const pending = launched.filter((e) => !e.reported && !e.ended);
    if (pending.length && grace > 0) await within(Promise.all(pending.map((e) => e.running)), grace);
    for (const e of launched) {
      if (e.ended) {
        // Its start rejected: forget it, so the next apply starts it again.
        failed.push({ ...ref(e.source!), error: e.error ?? 'the channel stopped' });
        if (!this.stopped) await this.stopChannel(e, false);
      } else if (e.state === 'failed') failed.push({ ...ref(e.source!), error: e.error ?? 'not connected' });
      else out.started.push(ref(e.source!));
    }
    // An unchanged channel that is still failing keeps the file from counting as applied.
    for (const e of this.channels) if (e.source && !launched.includes(e) && e.state === 'failed') failed.push({ ...ref(e.source), error: e.error ?? 'failed' });
    if (failed.length) out.failed = failed;
    else store.channelsApplied(cur.raw);
    (this.o.config as { channels: ResolvedChannel[] }).channels = this.channels.flatMap((e) => (e.source ? [e.source] : []));
    if (out.started.length || out.stopped.length || failed.length) {
      const list = (xs: { type: string; account: string }[]) => xs.map((x) => `${x.type} (${x.account})`).join(', ') || 'none';
      this.log('info', `channels applied live: started ${list(out.started)}; stopped ${list(out.stopped)}${failed.length ? `; failed ${list(failed)}` : ''}`);
    }
    return { applied: store.appliedOf(cur.raw), channels: out };
  }

  /** Stop one running channel and the compositors rendering to it, and forget it. */
  private async stopChannel(e: RunningChannel, forget = true): Promise<void> {
    e.ac.abort();
    // Removed from the config: no longer configured. A start that failed stays configured (it is just not running).
    if (forget) this.configured.delete(`${e.adapter.id}\0${e.account}`);
    await within(e.running, 3000);
    const comps = this.compositors.filter((c) => this.compositorAdapter.get(c) === e.adapter);
    await within(Promise.all(comps.map((c) => c.stop())), 5000);
    for (const c of comps) this.compositors.splice(this.compositors.indexOf(c), 1);
    for (const [key, list] of this.sessionCompositors) {
      const rest = list.filter((c) => !comps.includes(c));
      if (rest.length !== list.length) this.sessionCompositors.set(key, rest);
    }
    await within(e.close?.().catch(() => undefined), 3000);
    const i = this.channels.indexOf(e);
    if (i >= 0) this.channels.splice(i, 1);
    e.state = 'stopped';
    delete e.error;
    this.log('info', `channel ${e.adapter.id} (${e.account}) stopped`);
  }

  private startChannel(ch: { adapter: ChannelAdapter; account: string; owner: ChannelOwner; tier?: Tier; config?: unknown; close?: () => Promise<void> }): RunningChannel {
    const ac = new AbortController();
    // Built before start(): an adapter may emit synchronously, before its first await.
    const entry: RunningChannel = { adapter: ch.adapter, account: ch.account, ...(ch.tier ? { tier: ch.tier } : {}), ac, running: Promise.resolve(), state: 'running', owner: ch.owner, rejected: 0, evidenceCapped: 0, ...(ch.close ? { close: ch.close } : {}) };
    entry.running = ch.adapter
      .start({
        account: ch.account,
        config: ch.config,
        signal: ac.signal,
        blobs: this.blobs,
        // Stamped against this instance: an envelope claiming another (channel, account) is refused.
        emit: async (env) => {
          const r = await this.accept(env, this.emitSource(entry));
          this.stamped(entry, env, r);
          return { accepted: r.accepted, ...(r.inputId !== undefined ? { inputId: r.inputId } : {}) };
        },
        log: (level, msg) => this.log(level, `${ch.adapter.id}: ${msg}`),
      })
      .then(
        () => {
          entry.ended = true;
          entry.state = 'stopped';
          delete entry.error;
        },
        (err: Error) => {
          entry.ended = true;
          entry.state = 'failed';
          entry.error = err.message;
          this.log('error', `channel ${ch.adapter.id} stopped: ${err.message}`);
        },
      );
    this.channels.push(entry);
    this.configured.set(`${ch.adapter.id}\0${ch.account}`, { id: ch.adapter.id, account: ch.account });
    this.log('info', `channel ${ch.adapter.id} (${ch.account}) started`);
    return entry;
  }

  /**
   * The channel that sends to a route: the entry of its (id, account), else — only
   * when that id has a single entry — that one (a host naming the one bot's account
   * otherwise). With several accounts of an id (several Lark bots) there is no guess:
   * a message never goes out as another bot (decision 8).
   */
  private channelFor(r: { channel: string; account: string }): RunningChannel | undefined {
    const same = this.channels.filter((x) => x.adapter.id === r.channel && !x.ended);
    const own = same.find((x) => x.account === r.account);
    if (own) return own;
    // The fallback counts configured entries, not running ones: a stopped or failed bot b must not turn a into the one bot.
    return same.length === 1 && this.configuredAccounts(r.channel).length <= 1 ? same[0] : undefined;
  }

  /** Accounts of the entries configured (or injected) for a channel id, running or not. */
  private configuredAccounts(channel: string): string[] {
    return [...this.configured.values()].filter((x) => x.id === channel).map((x) => x.account);
  }

  /** Why no instance sends to this route: configured but not running, or not configured; and what is available. */
  private noChannelMessage(r: { channel: string; account: string }): string {
    const avail = this.channels.filter((x) => !x.ended).map((x) => `${x.adapter.id} (${x.account})`).join(', ') || 'none';
    const configured = this.configured.has(`${r.channel}\0${r.account}`);
    const why = configured ? `channel ${r.channel} with account ${r.account} is configured but not running` : `no channel ${r.channel} with account ${r.account} is configured`;
    return `${why}; never sent as another account (available: ${avail})`;
  }

  /** Caps and tier of the running channel that renders replies to (channel, account), for the input's `reply` summary. */
  private replyCaps(channel: string, account: string) {
    const ch = this.channelFor({ channel, account });
    if (!ch) return undefined;
    const caps = ch.adapter.caps(account);
    return { caps, tier: ch.tier ?? caps.defaultTier };
  }

  /**
   * Inputs a previous process admitted but never settled (it crashed): rejected
   * (`host_restarted`), so no id stays queued in a snapshot (`aio sessions`). Before
   * any lane opens. Runs are settled by `Runs.settleAllDangling`.
   */
  private settleLeftoverInputs(): void {
    for (const key of this.hub.log.sessions()) {
      if (key.startsWith('run:')) continue;
      const ids = settleLeftoverInputs(this.hub, key);
      if (ids.length) this.log('warn', `${key}: ${ids.length} input(s) a previous process left unsettled rejected (host_restarted)`);
    }
  }

  /**
   * Sessions the log shows mid-turn were left by a previous process. A Codex
   * app-server on a Unix socket may still be running that turn: open the session
   * now so the harness adopts it (turn.adopted) instead of waiting for input.
   */
  private async adoptRunningTurns(): Promise<void> {
    for (const key of this.hub.log.sessions()) {
      if (key.startsWith('run:')) continue; // runs are settled at start (Runs.settleAllDangling)
      const snap = this.hub.snapshot(key);
      const inst = this.instanceOf(snap.harness);
      if (!snap.turn || inst?.kind !== 'codex' || inst.codex.transport.kind !== 'unix') continue;
      try {
        await this.lane(key).open();
        this.log('info', `${key}: reopened to adopt turn ${snap.turn.turnId}`);
      } catch (e) {
        this.log('warn', `${key}: could not reopen: ${(e as Error).message}`);
      }
    }
  }

  /** Config watches are the owner's: created as the local principal. A bad entry is logged, not fatal. */
  private async loadConfigWatches(): Promise<void> {
    const by: Origin = { ...this.localOrigin(this.o.config.local.session), via: 'config', adapter: 'config' };
    for (const w of this.o.config.watches) {
      const r = await this.watches.add(by, w);
      if (r.ok) this.log('info', `watch ${w.id} → ${w.target.sessionKey} (${w.mode})`);
      else this.log('warn', `config watch ${w.id}: ${r.message}`);
    }
  }

  /**
   * Where turns a watch starts reply: the route of the target session's latest
   * turn that had one (e.g. the owner's DM), else nowhere but the session stream.
   */
  homeRoute(sessionKey: string): ReplyRoute | null {
    let route: ReplyRoute | null = null;
    for (const e of this.hub.log.read(sessionKey, 0)) if (e.body.t === 'turn.started' && e.body.replyRoute) route = e.body.replyRoute;
    return route;
  }

  /** Create or replace a watch as `by` (checked by `Policy.watch`). Host MCP tools call this for agents. */
  addWatch(by: Origin, watch: WatchDraft): Promise<AddWatchResult> {
    return this.watches.add(by, watch);
  }

  removeWatch(by: Origin, id: string): Promise<RemoveWatchResult> {
    return this.watches.remove(by, id);
  }

  listWatches(sessionKey?: string): Watch[] {
    return this.watches.list(sessionKey !== undefined ? { target: sessionKey } : {});
  }

  /** Origin stamped on everything a local client sends. Clients cannot choose it. */
  localOrigin(sessionKey: string): Origin {
    return {
      kind: 'human',
      principal: this.o.config.local.principal,
      evidence: 'device_only',
      via: routeKey(localRoute(sessionKey)),
      adapter: 'local',
    };
  }

  /** Apply a command from a local client (subscriptions are the server's business). */
  async command(cmd: ClientCommand, origin: Origin): Promise<Outcome> {
    if (this.stopped) return fail('stopped', 'gateway is stopping');
    // An input's id is fixed before the lane: a refused input is recorded under it.
    const inputId = cmd.type === 'input' ? (cmd.input.inputId ?? `in_${randomUUID()}`) : undefined;
    let lane: Lane;
    try {
      const live = this.lanes.get(cmd.sessionKey);
      if (!live && cmd.sessionKey.startsWith('run:')) return fail('no_run', `${cmd.sessionKey} is not running (task run sessions only take commands while their run runs)`);
      lane = live ?? this.lane(cmd.sessionKey);
    } catch (e) {
      if (e instanceof LaneUnavailableError) {
        // Only a refused input is written to the session log; other commands just fail.
        if (inputId !== undefined) await this.refuseUnavailable(cmd.sessionKey, e.code, e.message, inputId, null);
        return fail(e.code, e.message);
      }
      return fail('no_agent', (e as Error).message);
    }
    switch (cmd.type) {
      case 'input': {
        let content: ContentBlock[] = cmd.input.content;
        if (this.tools && content.some((c) => c.type === 'event' && c.name === 'choice')) {
          // `/choose <id> <n>` from attach: the answer to an ask_choice, checked and filled in.
          try {
            content = this.tools.normalizeLocal(content);
          } catch (e) {
            return fail('bad_choice', e instanceof ToolError ? e.message : (e as Error).message);
          }
        }
        const input: InputRecord = {
          inputId: inputId!,
          origin,
          content,
          replyRoute: localRoute(cmd.sessionKey),
          channelContext: { channel: 'local', ...cmd.input.channelContext },
        };
        const r =
          cmd.mode === 'observe'
            ? await lane.observe(input)
            : await lane.command({ type: 'input', sessionKey: cmd.sessionKey, input, mode: cmd.mode, ...(cmd.expectedTurnId ? { expectedTurnId: cmd.expectedTurnId } : {}) });
        return r.ok ? { ok: true, value: { inputId: input.inputId, disposition: r.disposition } } : fail(r.reason);
      }
      case 'resolve':
        // Answering on someone's behalf is the host's (its connection is authenticated with the token).
        if (cmd.onBehalfOf !== undefined && !isHostOrigin(origin)) return fail('not_eligible', 'onBehalfOf is for host connections');
        // And only where the deployment turned it on (decision 13: one explicit switch, default off).
        if (cmd.onBehalfOf !== undefined && !this.o.config.policy.answerOnBehalf) return fail('on_behalf_not_allowed', 'answering on behalf is off: set policy.answerOnBehalf: true');
      // falls through
      case 'interrupt':
      case 'control': {
        const r = await lane.command({ ...cmd, origin });
        return r.ok ? { ok: true, value: {} } : fail(r.reason);
      }
      case 'subscribe':
      case 'unsubscribe':
        return fail('use_subscribe', 'subscriptions belong to a connection');
    }
  }

  /** A session this daemon has run or registered: its log, a lane, or a pinned agent or launch. */
  private isOurSession(key: string): boolean {
    return this.lanes.has(key) || this.hub.log.head(key) > 0 || this.records.agentOf(key) !== undefined || this.records.launchOf(key) !== undefined;
  }

  sessions(): SessionInfo[] {
    // Prepared sessions (session.prepare) are listed before their first input.
    const keys = new Set([...this.hub.log.sessions(), ...this.lanes.keys(), ...this.records.launchedSessions()]);
    return [...keys].sort().map((sessionKey) => {
      const s = this.hub.snapshot(sessionKey);
      const launch = this.records.launchOf(sessionKey);
      return {
        sessionKey,
        harness: s.harness,
        state: s.state,
        head: s.seq,
        ...(s.turn ? { turnId: s.turn.turnId } : {}),
        queued: s.queued.length,
        pendingRequests: s.pendingRequests.map((r) => r.requestId),
        live: this.lanes.has(sessionKey),
        ...(launch ? { launch: launchView(launch) } : {}),
      };
    });
  }

  /**
   * Shut down. Codex is detached, not closed: over a Unix socket its turns keep
   * running and the next gateway adopts them. Other harnesses are closed (their
   * running turn is interrupted and recorded).
   */
  /** Set by stop(): no new inbound while the last sends go out. */
  private refusingInbound = false;

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.parkedTimers.values()) clearTimeout(t);
    this.parkedTimers.clear();
    this.host.close();
    // Lives end first: the voice runs in the harness and the media peer in a channel, both about to go.
    await within(Promise.all([...this.lives.keys()].map((k) => this.leaveLive(k, 'gateway stopping'))), 5000);
    // Runs end (interrupted) while their connections can still hear run.ended.
    await within(this.runs.stop(), 10_000);
    this.server?.close('gateway stopping');
    this.console?.close('gateway stopping');
    this.larkBots?.close();
    if (this.tokenFile) removeTokenFile(this.tokenFile, this.token);
    if (this.consoleFile && this.console) removeTokenFile(this.consoleFile, this.console.url);
    this.watches.stop();
    // A live channel apply in progress finishes (it sees `stopped` and launches nothing more)
    // before the channels are aborted, so none starts after the snapshot below.
    await within(this.applying, 5000);
    // Inbound is refused from here; channels stay connected until the last sends (rejection
    // notices, finals) are out: a bridge's start() closes its peer as soon as it is aborted.
    this.refusingInbound = true;
    // A launched session's own app-server (stdio) ends with it: its lane is closed, not detached.
    const own = new Set([...this.launched].filter(([, x]) => x.owns()).map(([k]) => k));
    const codex = (l: Lane) => !own.has(l.sessionKey) && codexOf(this.o.harness ?? this.instances.get(l.harnessId));
    const detached = [...this.lanes.values()].filter(codex);
    const closed = [...this.lanes.values()].filter((l) => !codex(l));
    for (const l of detached) l.detach('gateway stopping');
    const adapters = this.o.harness ? [this.o.harness] : [...this.instances.values()];
    // Bounded by a timer that holds the event loop: harness close() may wait on unref'd timers only.
    await within(
      Promise.all([
        ...adapters.map((a) => codexOf(a)?.detach()),
        ...closed.map((l) => l.close('gateway stopping').catch(() => undefined)),
      ]),
      8000,
    );
    // Let the last events (interrupted turn, consumed inputs) reach the log before it closes.
    await within(Promise.all(closed.map((l) => l.whenIdle())), 3000);
    await within(Promise.all([...this.launched.values()].map((x) => x.dispose())), 3000);
    await within(Promise.all(this.compositors.map((c) => c.stop())), 5000);
    // Sends still running settle while their channel and the records are open; no more retries.
    await this.outbox.drain(5000);
    for (const ch of this.channels) ch.ac.abort();
    await within(Promise.all(this.channels.map((c) => c.running)), 3000);
    for (const ch of this.channels) await within(ch.close?.().catch(() => undefined), 3000);
    await within(this.watches.idle(), 3000);
    await within(this.mcp?.close(), 2000);
    await within(new Promise(() => {}), 50);
    this.watches.registry.close();
    this.hostQueue.close();
    // Anything still sending keeps its in-flight mark; the next start settles it as unknown.
    this.outbox.close();
    this.records.close();
    this.router.close();
    this.topics.close();
    this.hub.log.close?.();
  }
}

/** `topicTools` of an input handed to a topic by session_rotate / session_switch. */
const HANDED_HINT = 'this message was handed to this topic by a topic switch: answer it here; do not call session_rotate or session_switch for it';

const turnRef = (t: TurnContext) => ({ sessionKey: t.sessionKey, turnId: t.turnId });

function fail(code: string, message = code): Outcome {
  return { ok: false, code, message };
}

/** An agent's RunSpec over its instance's defaults (without the profile). */
function agentRun(agent: AgentConfig, inst: HarnessInstance): Omit<RunSpec, 'profile'> {
  const effort = agent.effort ?? inst.run.effort;
  return { harness: inst.name, model: agent.model ?? inst.run.model, ...(effort !== undefined ? { effort } : {}) };
}

/**
 * An instance adapter as one agent opens it: the agent's working directory and
 * instructions (Claude: appended to the preset system prompt; Codex: developer
 * instructions) over the instance's. Other adapters (tests) are used as they are.
 */
export function withAgent(a: HarnessAdapter, agent: AgentConfig, cwd: string | undefined): HarnessAdapter {
  if (!(a instanceof InstanceHarness)) return a;
  const i = a.instance;
  let options = i.options;
  if (agent.instructions !== undefined) {
    options =
      i.kind === 'claude-code'
        ? { ...options, sdk: { ...(options.sdk as Record<string, unknown> | undefined), systemPrompt: { type: 'preset', preset: 'claude_code', append: agent.instructions } } }
        : { ...options, developerInstructions: agent.instructions };
  }
  return new InstanceHarness({ ...i, ...(cwd !== undefined ? { cwd } : {}), options } as HarnessInstance, a.inner);
}

/** Per-session adapters of a launched session (`Gateway.launchAdapters`). */
interface LaunchAdapters {
  adapter(name: string): HarnessAdapter;
  /** Some adapter runs its own process (a Codex app-server with the session's env). */
  owns(): boolean;
  dispose(): Promise<void>;
}

/**
 * An adapter as one launched session opens it: in `cwd` (when given) with `env`
 * over the child's environment (`HarnessOpenArgs.env`). Other adapters (tests)
 * get the env through their open args; their cwd is the lane's.
 */
export function withLaunch(a: HarnessAdapter, cwd: string | undefined, env: Record<string, string> | undefined): HarnessAdapter {
  if (a instanceof InstanceHarness) return new InstanceHarness({ ...a.instance, ...(cwd !== undefined ? { cwd } : {}) } as HarnessInstance, a.inner, env);
  return env ? new LaunchEnvHarness(a, env) : a;
}

class LaunchEnvHarness implements HarnessAdapter {
  readonly id: string;
  constructor(
    readonly inner: HarnessAdapter,
    private readonly env: Record<string, string>,
  ) {
    this.id = inner.id;
  }

  probe(): Promise<{ version: string; caps: HarnessCaps }> {
    return this.inner.probe();
  }

  open(args: HarnessOpenArgs): Promise<HarnessSession> {
    return this.inner.open({ ...args, env: { ...args.env, ...this.env } });
  }
}

/** The Codex adapter behind an instance adapter, if it is one (Codex is detached at shutdown, not closed). */
function codexOf(a: HarnessAdapter | undefined): CodexHarness | undefined {
  if (a instanceof InstanceHarness || a instanceof LaunchEnvHarness) return codexOf(a.inner);
  return a instanceof CodexHarness ? a : undefined;
}

/**
 * One deployment harness instance: the kind's adapter launched with the
 * instance's environment and config dirs, under the instance name, opening its
 * sessions in the instance's cwd with its options.
 */
export class InstanceHarness implements HarnessAdapter {
  readonly id: string;
  constructor(
    readonly instance: HarnessInstance,
    readonly inner: HarnessAdapter,
    /** A launched session's env (decision 7), over the child's environment at open. */
    readonly env?: Record<string, string>,
  ) {
    this.id = instance.name;
  }

  probe(): Promise<{ version: string; caps: HarnessCaps }> {
    return this.inner.probe();
  }

  open(args: HarnessOpenArgs): Promise<HarnessSession> {
    const i = this.instance;
    const options = i.kind === 'claude-code' || i.kind === 'module' ? { ...i.options, profiles: i.profiles } : i.options;
    // A module harness runs in the daemon's process: the instance's env reaches it through the open args.
    const instEnv = i.kind === 'module' ? definedEnv(i.env) : undefined;
    const env = instEnv || this.env ? { ...instEnv, ...args.env, ...this.env } : undefined;
    return this.inner.open({ ...args, ...(i.cwd ? { cwd: i.cwd } : {}), options: { ...options, ...args.options }, ...(env ? { env } : {}) });
  }
}

/**
 * The adapter for one instance. Environment values are handed to the child process only, never logged.
 * `media` resolves stored blob refs for the harness (Claude: inline image / file path; Codex: local path).
 */
export function buildHarness(i: HarnessInstance, media?: MediaResolvers): InstanceHarness {
  if (i.unavailable) throw new Error(`harness instance ${i.name} is unavailable: ${i.unavailable}`);
  if (i.kind === 'module') throw new Error(`harness instance ${i.name} is a module harness; the gateway loads it at start`);
  if (i.kind === 'codex') {
    const x = i.codex;
    return new InstanceHarness(
      i,
      new CodexHarness({
        bin: x.bin ?? 'codex',
        env: i.env,
        transport: x.transport,
        profiles: i.profiles as Record<string, CodexProfile>,
        ...(x.codexHome ? { codexHome: x.codexHome } : {}),
        ...(x.config ? { config: x.config } : {}),
        ...(x.enable ? { enable: x.enable } : {}),
        ...(x.disable ? { disable: x.disable } : {}),
        ...(x.live ? { live: true } : {}),
        ...(media ? { resolveMedia: media.resolveMedia } : {}),
      }),
    );
  }
  const x = i.claude;
  const claudePath = x.claudePath && !x.claudePath.includes('/') ? (findOnPath(x.claudePath, i.env.PATH ?? process.env.PATH) ?? x.claudePath) : x.claudePath;
  const config: ClaudeCodeHarnessConfig = {
    env: i.env,
    ...(claudePath ? { claudePath } : {}),
    ...(x.configDir ? { configDir: x.configDir } : {}),
    ...(x.settings !== undefined ? { settings: x.settings as ClaudeCodeHarnessConfig['settings'] } : {}),
    ...(x.settingSources ? { settingSources: x.settingSources } : {}),
    ...(x.mcpServers ? { mcpServers: x.mcpServers as ClaudeCodeHarnessConfig['mcpServers'] } : {}),
    ...(x.plugins ? { plugins: x.plugins } : {}),
    ...(x.skills !== undefined ? { skills: x.skills } : {}),
    ...(x.extraArgs ? { extraArgs: x.extraArgs } : {}),
    ...(x.additionalDirectories ? { additionalDirectories: x.additionalDirectories } : {}),
  };
  // Resolvers ride in the instance's open options; explicit options in the config win.
  const inst = media ? { ...i, options: { resolveImage: media.resolveImage, resolveFile: media.resolveFile, ...i.options } } : i;
  return new InstanceHarness(inst, new ClaudeCodeHarness(config));
}

/** The variables an env map sets (`undefined` removes one from a child's env; in-process there is nothing to remove). */
function definedEnv(env: Record<string, string | undefined>): Record<string, string> | undefined {
  const out = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
  return Object.keys(out).length ? out : undefined;
}

/** Import a harness module, run its factory, and check the adapter's shape. */
async function loadHarnessModule(o: {
  name: string;
  module: ModuleLaunch;
  log: (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => void;
  harness: (name: string) => HarnessAdapter;
}): Promise<HarnessAdapter> {
  const where = `harnesses.${o.name} (module ${o.module.file})`;
  const name = o.module.export ?? 'createHarness';
  const mod = (await import(pathToFileURL(o.module.file).href).catch((e: Error) => {
    throw new Error(`${where}: cannot import: ${e.message}`);
  })) as Record<string, unknown>;
  const factory = o.module.export !== undefined ? mod[name] : (mod[name] ?? mod.default);
  if (typeof factory !== 'function') throw new Error(`${where}: export ${JSON.stringify(name)}${o.module.export !== undefined ? '' : ' (or default)'} is not a function`);
  let adapter: HarnessAdapter;
  try {
    adapter = await (factory as HarnessFactory)({ name: o.name, config: o.module.config, log: o.log, harness: o.harness });
  } catch (e) {
    throw new Error(`${where}: factory failed: ${(e as Error).message}`);
  }
  const a = adapter as unknown as Partial<Record<string, unknown>> | null;
  const bad = !a || typeof a.id !== 'string' || !a.id ? 'id (a non-empty string)' : (['probe', 'open'] as const).find((k) => typeof a[k] !== 'function');
  if (bad) throw new Error(`${where}: the factory did not return a HarnessAdapter (bad ${bad})`);
  return adapter;
}

/** What a live's voice is told when the agent gives no instructions (decision 11). */
const DEFAULT_LIVE_INSTRUCTIONS =
  'You take part by voice in a live session (a meeting or a call) as this deployment\'s assistant. Speak briefly and naturally, in the language people use. Stay quiet unless someone addresses you. For anything that needs facts, files, tools or actions, delegate it, then report the result accurately, without adding details.';

/** A channel built but not started yet. */
type BuiltChannel = { adapter: ChannelAdapter; account: string; owner: ChannelOwner; tier?: Tier; config?: unknown; close?: () => Promise<void>; source?: ResolvedChannel; bind?: (e: RunningChannel) => void };

const isBridge = (a: ChannelAdapter): a is BridgedChannel => typeof (a as Partial<BridgedChannel>).state === 'function' && typeof (a as Partial<BridgedChannel>).close === 'function';

/** Its channel id is settled: anything but a bridge without `id` whose peer has not said hello yet. */
function idKnown(b: { adapter: ChannelAdapter; source?: ResolvedChannel }): boolean {
  return !(b.source?.type === 'bridge' && b.source.id === undefined && isBridge(b.adapter) && !b.adapter.state().connected);
}

/**
 * Why a channel (`id`, `owner`, `account`) cannot run next to `others`, if it cannot:
 * one channel id belongs to one adapter, only accounts differ (channel-stamping F4), and
 * bridges and modules never take a built-in id.
 */
function idConflict(id: string, owner: ChannelOwner, account: string, others: Iterable<{ adapter: ChannelAdapter; owner: ChannelOwner; account: string }>): string | undefined {
  if (typeof owner === 'string' && owner !== 'lark-bot' && owner !== 'mail' && RESERVED_CHANNEL_IDS.includes(id)) return `channel id ${JSON.stringify(id)} is a built-in channel id; ${ownerName(owner)} cannot use it`;
  for (const o of others) {
    if (o.adapter.id !== id) continue;
    if (o.owner !== owner) return `channel id ${JSON.stringify(id)} belongs to ${ownerName(o.owner)}; ${ownerName(owner)} cannot use it too (one channel id is one adapter, only accounts differ)`;
    if (o.account === account) return `two channels have the same (channel, account) = (${id}, ${account}); give one another account`;
  }
  return undefined;
}

async function buildChannel(
  ch: ResolvedChannel,
  index: number,
  log: (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => void,
  onState?: (s: BridgeState) => void,
  acceptId?: (id: string) => string | undefined,
): Promise<{ adapter: ChannelAdapter; account: string; tier?: Tier; config?: unknown; close?: () => Promise<void> }> {
  const tier = ch.tier ? { tier: ch.tier } : {};
  switch (ch.type) {
    case 'lark-bot':
      return { adapter: new LarkBotAdapter(ch.config), account: ch.account, ...tier };
    case 'mail':
      return { adapter: new MailChannel({ ...ch.config, account: ch.account } as MailChannelConfig), account: ch.account, ...tier };
    case 'bridge': {
      const b = await spawnChannel({
        command: ch.command,
        account: ch.account,
        ...(ch.args ? { args: ch.args } : {}),
        ...(ch.env ? { env: ch.env } : {}),
        ...(ch.cwd ? { cwd: ch.cwd } : {}),
        ...(ch.config !== undefined ? { config: ch.config } : {}),
        // A peer that fails its first hello is retried with the restart backoff instead of failing the daemon.
        retryFirstConnect: true,
        ...(ch.id !== undefined ? { id: ch.id, expectId: ch.id } : {}),
        ...(onState ? { onState } : {}),
        ...(acceptId ? { acceptId } : {}),
      });
      return { adapter: b, account: ch.account, config: ch.config, close: () => b.close(), ...tier };
    }
    case 'module': {
      // A plugin that fails to load is a config error (exit 2), like any other bad channel entry.
      const adapter = await loadChannelModule({
        file: ch.module,
        ...(ch.export ? { export: ch.export } : {}),
        index,
        account: ch.account,
        config: ch.config,
        log: (level, msg, data) => log(level, `channel module ${ch.module}: ${msg}`, data),
      }).catch((e: Error) => {
        throw new ConfigError(e.message);
      });
      return { adapter, account: ch.account, config: ch.config, ...(adapter.close ? { close: () => adapter.close!() } : {}), ...tier };
    }
  }
}
