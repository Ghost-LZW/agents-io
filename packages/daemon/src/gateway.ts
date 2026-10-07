import { randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  routeKey,
  type ChannelAdapter,
  type ContentBlock,
  type HarnessAdapter,
  type HarnessCaps,
  type HarnessEvent,
  type HarnessOpenArgs,
  type HarnessSession,
  type HostRequestFrame,
  type InboundEnvelope,
  type InputRecord,
  type Origin,
  type Policy,
  type ReplyRoute,
  type RunSpec,
  type Tier,
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
  Outbox,
  Router,
  SqliteSessionLog,
  WatchDispatcher,
  WatchRegistry,
  defaultPolicy,
  type AddWatchResult,
  type FullPolicy,
  type IngressResult,
  type RemoveWatchResult,
  type SessionLog,
} from '@agents-io/session';
import { HostMcpServer, HostTools, ToolError } from '@agents-io/host-mcp';
import { ClaudeCodeHarness, findOnPath, type ClaudeCodeHarnessConfig } from '@agents-io/harness-claude-code';
import { CodexHarness, type CodexProfile } from '@agents-io/harness-codex';
import { LarkBotAdapter } from '@agents-io/channel-lark-bot';
import { MailChannel, type MailChannelConfig } from '@agents-io/channel-mail';
import { spawnChannel } from '@agents-io/channel-jsonl-bridge';
import { agentSpec, configTable, type AgentConfig, type Config, type HarnessInstance, type ResolvedChannel } from './config.js';
import type { ClientCommand, SessionInfo } from './frames.js';
import { HostService, isHostOrigin } from './host.js';
import { LocalServer } from './local-server.js';
import { privateDb, privateDir } from './private.js';
import { blobResolvers, type MediaResolvers } from './media.js';
import { DaemonRecords } from './records.js';
import { Runs } from './runs.js';
import { removeTokenFile, tokenPath, writeTokenFile } from './token.js';

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
  /** Host token (default: a fresh random one, written next to the socket when listening). */
  token?: string;
  /** Inbound push: how long a pushed item waits for the host's result, and the retry delay (tests). */
  hostPush?: { timeoutMs?: number; retryMs?: number };
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
}

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
  /** Host output tools (`config.outputTools`), mounted into every harness binding over MCP. */
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
  /** Secret a host presents in `host.hello` (written 0600 next to the socket). */
  readonly token: string;
  /** Built instance adapters, by instance name (lazily, on first use). */
  private readonly instances = new Map<string, HarnessAdapter>();
  /** Adapters of configured agents (their cwd and instructions over the instance's). */
  private readonly agentAdapters = new Map<string, HarnessAdapter>();
  private readonly lanes = new Map<string, Lane>();
  /** Agent and working directory of each live lane. */
  private readonly laneInfo = new Map<string, { agent: AgentConfig; cwd?: string }>();
  private readonly compositors: Compositor[] = [];
  private readonly sessionCompositors = new Map<string, Compositor[]>();
  private readonly channels: RunningChannel[] = [];
  private server: LocalServer | undefined;
  private tokenFile: string | undefined;
  private readonly log: LogFn;
  private stopped = false;

  private constructor(private readonly o: GatewayOptions) {
    const c = o.config;
    // The default instance must be usable (e.g. its env refs set); others fail when a turn names them.
    this.harness();
    this.log = o.logger ?? ((level, msg) => console.error(`[aio] ${level}: ${msg}`));
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
    this.token = o.token ?? randomBytes(32).toString('hex');
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
      routeCallout: (bindingId, input, envelope) => this.host.routeCallout(bindingId, input, envelope),
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
    this.policy = {
      ...base,
      // The router's identity maps (the owners config; a host's map once one is pushed).
      identify: async (a) => router.identify(a),
      // The host (authenticated with the token) may interrupt and cancel what it started and what it watches.
      control: async (a) => (isHostOrigin(a.origin) ? 'allow' : base.control(a)),
      ...o.policy,
    } as FullPolicy;
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
    if (c.outputTools) {
      this.tools = new HostTools({
        hub: this.hub,
        outbox: this.outbox,
        policy: this.policy,
        // Only lanes that exist: a tool call always comes from a running harness session.
        turn: (key) => this.lanes.get(key)?.currentTurn(),
        adapter: (id) => this.channels.find((ch) => ch.adapter.id === id)?.adapter,
        blobs: this.blobs,
        cwd: (key) => this.laneInfo.get(key)?.cwd ?? this.instanceOf(this.lanes.get(key)?.harnessId)?.cwd ?? c.cwd,
        tier: (r) => this.channels.find((ch) => ch.adapter.id === r.channel)?.tier,
        routes: () => c.policy.routes,
        // Agents add watches as themselves (kind agent); Policy.watch decides, the target is pinned to their session.
        watches: { add: (by, d) => this.addWatch(by, d), remove: (by, id) => this.removeWatch(by, id), list: (key) => this.listWatches(key) },
        // Decision 4: every write carries where the turn's inputs came from.
        provenance: (key, turnId) => this.lanes.get(key)?.provenance(turnId),
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
      lanes: (key, agent) => this.lane(key, agent),
      hub: this.hub,
      watches: this.watches,
      onWatchError: (err) => this.log('warn', `watch fan-out failed: ${(err as Error).message}`),
      // `on: "host"` inputs wait in the durable queue until the host acks them.
      hostQueue: this.hostQueue,
      replyCaps: (ch, account) => this.replyCaps(ch, account),
      // Clicks on ask_choice buttons (and numbered replies) go back to the session that asked.
      ...(tools ? { rewrite: (a) => tools.rewriteInbound(a) } : {}),
    });
  }

  static async start(o: GatewayOptions): Promise<Gateway> {
    const gw = new Gateway(o);
    try {
      if (gw.mcp) {
        const url = await gw.mcp.listen();
        gw.log('info', `host MCP output tools on ${url}`);
      }
      gw.watches.start();
      gw.runs.settleAllDangling();
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
    } catch (e) {
      await gw.stop().catch(() => undefined);
      throw e;
    }
    return gw;
  }

  get config(): Config {
    return this.o.config;
  }

  /** Host frames on the local socket (LocalHost). */
  get hostFrames(): HostService {
    return this.host;
  }

  /**
   * Accept one envelope from a channel: route it (Ingress) and remember who sent
   * it as the channel reported it, so `input.verify` can answer later.
   */
  async accept(env: InboundEnvelope): Promise<IngressResult> {
    const r = await this.ingress.accept(env);
    if (r.accepted && r.origin && r.action !== 'duplicate') {
      try {
        this.records.recordInput(env, r.origin, r.inputId);
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
    a = this.o.buildHarness?.(inst) ?? buildHarness(inst, blobResolvers(this.blobs));
    this.instances.set(name, a);
    return a;
  }

  private instanceOf(harnessId: string | undefined): HarnessInstance | undefined {
    return this.o.harness || harnessId === undefined ? undefined : this.o.config.harnesses[harnessId];
  }

  /**
   * The lane of a session, created on first use with the session's agent (the
   * one recorded for it, else `agent`, else the agent whose prefix the key has,
   * else the default agent). Its harness session opens with the first turn.
   */
  lane(sessionKey: string, agentName?: string): Lane {
    let lane = this.lanes.get(sessionKey);
    if (lane) {
      const had = this.laneInfo.get(sessionKey)?.agent.name;
      if (agentName !== undefined && had !== undefined && had !== agentName) this.log('warn', `${sessionKey} belongs to agent ${had}; a rule for agent ${agentName} delivered to it`);
      return lane;
    }
    if (sessionKey.startsWith('run:')) throw new Error(`${sessionKey} is a task run session; it only exists while its run.start runs`);
    const agent = this.agentFor(sessionKey, agentName);
    const c = this.o.config;
    const cwd = agent.configured ? (agent.cwd ?? c.harnesses[agent.harness]?.cwd ?? c.cwd) : c.cwd;
    lane = new Lane({
      sessionKey,
      harness: this.agentHarness(agent),
      ...(this.o.harness ? {} : { harnessFor: (name: string) => (name === agent.harness ? this.agentHarness(agent) : this.harness(name)) }),
      resumeFor: (id) => this.nativeIdOf(sessionKey, id),
      hub: this.hub,
      policy: this.agentPolicy(agent),
      cwd,
      ...(this.mcp && agent.tools ? { mcp: (a: { sessionKey: string; generation: number; harnessId: string }) => this.mcp!.mcpFor(a) } : {}),
      onHarnessEvent: (e) => this.o.onHarnessEvent?.(sessionKey, e),
    });
    this.lanes.set(sessionKey, lane);
    this.laneInfo.set(sessionKey, { agent, ...(agent.configured ? { cwd } : {}) });
    for (const ch of this.channels) this.compose(sessionKey, ch.adapter, ch.tier);
    return lane;
  }

  /** The agent of an interactive session. */
  private agentFor(sessionKey: string, wanted: string | undefined): AgentConfig {
    const c = this.o.config;
    const usable = (n: string | undefined) => (n !== undefined && c.agents[n]?.mode === 'interactive' ? c.agents[n] : undefined);
    const recorded = usable(this.records.agentOf(sessionKey));
    if (recorded) return recorded;
    const byPrefix = Object.values(c.agents).find((a) => a.name !== c.defaultAgent && a.mode === 'interactive' && sessionKey.startsWith(`${a.name}:`));
    const agent = usable(wanted) ?? byPrefix ?? usable(c.defaultAgent);
    if (!agent) throw new Error(`no interactive agent for session ${sessionKey} (configure one, or a defaultAgent)`);
    if (agent.configured) this.records.setAgent(sessionKey, agent.name);
    return agent;
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
    const provenance: TurnProvenance = { sessionKey: r.sessionKey, turnId: r.turnId, triggeredBy: [`host:${this.host.hostName() ?? 'cli'}`], watched: false, external: false, group: false };
    const env = { ...r.env, AGENTS_IO_RUN_ID: r.runId, AGENTS_IO_TURN_PROVENANCE: JSON.stringify(provenance) };
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
      own = this.o.buildHarness?.(runInst) ?? buildHarness(runInst, blobResolvers(this.blobs));
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
    for (const ch of this.channels) this.compose(r.sessionKey, ch.adapter, ch.tier);
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
    const ch = this.channels.find((x) => x.adapter.id === f.route.channel && x.account === f.route.account) ?? this.channels.find((x) => x.adapter.id === f.route.channel);
    if (!ch) return fail('unknown_channel', `no running channel ${f.route.channel} (running: ${this.channels.map((x) => x.adapter.id).join(', ') || 'none'})`);
    const rec = await this.outbox.send(ch.adapter, { operationId, sessionKey: `host:${hostName}`, route: f.route, msg: f.message });
    return { ok: true, value: { ...rec, operationId: f.operationId, duplicate: false } };
  }

  /** The instance's own session/thread id last bound to this session, so a restart resumes it. */
  private nativeIdOf(sessionKey: string, harnessId: string): string | undefined {
    let id: string | undefined;
    for (const e of this.hub.log.read(sessionKey, 0)) {
      if (e.body.t === 'session.bound' && e.harness === harnessId) id = e.body.nativeId;
    }
    return id;
  }

  private compose(sessionKey: string, adapter: ChannelAdapter, tier: Tier | undefined): void {
    const c = new Compositor({
      hub: this.hub,
      sessionKey,
      adapter,
      outbox: this.outbox,
      ...(tier ? { tier } : {}),
      // A stop button on streaming cards; Ingress turns its click into an `interrupt` command.
      interruptButton: true,
      onError: (err) => this.log('warn', `render to ${adapter.id} failed: ${(err as Error).message}`),
    });
    c.start();
    this.compositors.push(c);
    const list = this.sessionCompositors.get(sessionKey);
    if (list) list.push(c);
    else this.sessionCompositors.set(sessionKey, [c]);
  }

  private async startChannels(): Promise<void> {
    const all: { adapter: ChannelAdapter; account: string; tier?: Tier; config?: unknown; close?: () => Promise<void> }[] = [];
    for (const ch of this.o.config.channels) all.push(await buildChannel(ch));
    for (const x of this.o.channels ?? []) all.push({ adapter: x.adapter, account: x.account ?? 'default', ...(x.tier ? { tier: x.tier } : {}) });
    for (const ch of all) {
      const ac = new AbortController();
      const running = ch.adapter
        .start({
          account: ch.account,
          config: ch.config,
          signal: ac.signal,
          blobs: this.blobs,
          emit: async (env) => {
            const r = await this.accept(env);
            return { accepted: r.accepted, ...(r.inputId !== undefined ? { inputId: r.inputId } : {}) };
          },
          log: (level, msg) => this.log(level, `${ch.adapter.id}: ${msg}`),
        })
        .catch((err: Error) => this.log('error', `channel ${ch.adapter.id} stopped: ${err.message}`));
      this.channels.push({ adapter: ch.adapter, account: ch.account, ...(ch.tier ? { tier: ch.tier } : {}), ac, running, ...(ch.close ? { close: ch.close } : {}) });
      this.log('info', `channel ${ch.adapter.id} (${ch.account}) started`);
    }
  }

  /** Caps and tier of the running channel that renders replies to (channel, account), for the input's `reply` summary. */
  private replyCaps(channel: string, account: string) {
    const ch = this.channels.find((c) => c.adapter.id === channel && c.account === account) ?? this.channels.find((c) => c.adapter.id === channel);
    if (!ch) return undefined;
    const caps = ch.adapter.caps(account);
    return { caps, tier: ch.tier ?? caps.defaultTier };
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
    let lane: Lane;
    try {
      const live = this.lanes.get(cmd.sessionKey);
      if (!live && cmd.sessionKey.startsWith('run:')) return fail('no_run', `${cmd.sessionKey} is not running (task run sessions only take commands while their run runs)`);
      lane = live ?? this.lane(cmd.sessionKey);
    } catch (e) {
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
          inputId: cmd.input.inputId ?? `in_${randomUUID()}`,
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
      case 'interrupt':
      case 'resolve':
      case 'control': {
        const r = await lane.command({ ...cmd, origin });
        return r.ok ? { ok: true, value: {} } : fail(r.reason);
      }
      case 'subscribe':
      case 'unsubscribe':
        return fail('use_subscribe', 'subscriptions belong to a connection');
    }
  }

  sessions(): SessionInfo[] {
    const keys = new Set([...this.hub.log.sessions(), ...this.lanes.keys()]);
    return [...keys].sort().map((sessionKey) => {
      const s = this.hub.snapshot(sessionKey);
      return {
        sessionKey,
        harness: s.harness,
        state: s.state,
        head: s.seq,
        ...(s.turn ? { turnId: s.turn.turnId } : {}),
        queued: s.queued.length,
        pendingRequests: s.pendingRequests.map((r) => r.requestId),
        live: this.lanes.has(sessionKey),
      };
    });
  }

  /**
   * Shut down. Codex is detached, not closed: over a Unix socket its turns keep
   * running and the next gateway adopts them. Other harnesses are closed (their
   * running turn is interrupted and recorded).
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.host.close();
    // Runs end (interrupted) while their connections can still hear run.ended.
    await within(this.runs.stop(), 10_000);
    this.server?.close('gateway stopping');
    if (this.tokenFile) removeTokenFile(this.tokenFile, this.token);
    this.watches.stop();
    for (const ch of this.channels) ch.ac.abort();
    await within(Promise.all(this.channels.map((c) => c.running)), 3000);
    const codex = (l: Lane) => codexOf(this.o.harness ?? this.instances.get(l.harnessId));
    const detached = [...this.lanes.values()].filter(codex);
    const closed = [...this.lanes.values()].filter((l) => !codex(l));
    for (const l of detached) l.detach();
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
    await within(Promise.all(this.compositors.map((c) => c.stop())), 5000);
    for (const ch of this.channels) await within(ch.close?.().catch(() => undefined), 3000);
    await within(this.watches.idle(), 3000);
    await within(this.mcp?.close(), 2000);
    await within(new Promise(() => {}), 50);
    this.watches.registry.close();
    this.hostQueue.close();
    this.records.close();
    this.router.close();
    this.hub.log.close?.();
  }
}

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

/** The Codex adapter behind an instance adapter, if it is one (Codex is detached at shutdown, not closed). */
function codexOf(a: HarnessAdapter | undefined): CodexHarness | undefined {
  if (a instanceof InstanceHarness) return codexOf(a.inner);
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
  ) {
    this.id = instance.name;
  }

  probe(): Promise<{ version: string; caps: HarnessCaps }> {
    return this.inner.probe();
  }

  open(args: HarnessOpenArgs): Promise<HarnessSession> {
    const i = this.instance;
    const options = i.kind === 'claude-code' ? { ...i.options, profiles: i.profiles } : i.options;
    return this.inner.open({ ...args, ...(i.cwd ? { cwd: i.cwd } : {}), options: { ...options, ...args.options } });
  }
}

/**
 * The adapter for one instance. Environment values are handed to the child process only, never logged.
 * `media` resolves stored blob refs for the harness (Claude: inline image / file path; Codex: local path).
 */
export function buildHarness(i: HarnessInstance, media?: MediaResolvers): InstanceHarness {
  if (i.unavailable) throw new Error(`harness instance ${i.name} is unavailable: ${i.unavailable}`);
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

async function buildChannel(ch: ResolvedChannel): Promise<{ adapter: ChannelAdapter; account: string; tier?: Tier; config?: unknown; close?: () => Promise<void> }> {
  const tier = ch.tier ? { tier: ch.tier } : {};
  switch (ch.type) {
    case 'lark-bot':
      return { adapter: new LarkBotAdapter({ ...(ch.config ?? {}), ...ch.lark }), account: ch.account, ...tier };
    case 'mail':
      return { adapter: new MailChannel({ account: ch.account, ...ch.config } as MailChannelConfig), account: ch.account, ...tier };
    case 'bridge': {
      const b = await spawnChannel({
        command: ch.command,
        account: ch.account,
        ...(ch.args ? { args: ch.args } : {}),
        ...(ch.env ? { env: ch.env } : {}),
        ...(ch.cwd ? { cwd: ch.cwd } : {}),
        ...(ch.config !== undefined ? { config: ch.config } : {}),
      });
      return { adapter: b, account: ch.account, config: ch.config, close: () => b.close(), ...tier };
    }
  }
}
