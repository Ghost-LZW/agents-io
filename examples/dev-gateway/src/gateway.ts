import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  routeKey,
  type ChannelAdapter,
  type HarnessAdapter,
  type HarnessCaps,
  type HarnessEvent,
  type HarnessOpenArgs,
  type HarnessSession,
  type InputRecord,
  type Origin,
  type Policy,
  type ReplyRoute,
  type Tier,
} from '@agents-io/protocol';
import {
  Compositor,
  FsBlobStore,
  Hub,
  Ingress,
  Lane,
  Outbox,
  SqliteSessionLog,
  defaultPolicy,
  type FullPolicy,
  type SessionLog,
} from '@agents-io/session';
import { ClaudeCodeHarness, findOnPath, type ClaudeCodeHarnessConfig } from '@agents-io/harness-claude-code';
import { CodexHarness, type CodexProfile } from '@agents-io/harness-codex';
import { LarkBotAdapter } from '@agents-io/channel-lark-bot';
import { MailChannel, type MailChannelConfig } from '@agents-io/channel-mail';
import { spawnChannel } from '@agents-io/channel-jsonl-bridge';
import type { Config, HarnessInstance, ResolvedChannel } from './config.js';
import type { ClientCommand, SessionInfo } from './frames.js';
import { LocalServer } from './local-server.js';
import { blobResolvers, type MediaResolvers } from './media.js';

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
  /** Hooks that replace defaultPolicy's. */
  policy?: Partial<Policy>;
  /** Use this log instead of SQLite at `config.logPath` (tests). */
  log?: SessionLog;
  /** Serve the local client socket (default true). */
  listen?: boolean;
  /** Tee of raw harness events per session (conformance checks). */
  onHarnessEvent?: (sessionKey: string, e: HarnessEvent) => void;
  logger?: LogFn;
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
  readonly ingress: Ingress;
  readonly outbox: Outbox;
  /** Inbound media (channels put, harnesses read). */
  readonly blobs: FsBlobStore;
  /** Built instance adapters, by instance name (lazily, on first use). */
  private readonly instances = new Map<string, HarnessAdapter>();
  private readonly lanes = new Map<string, Lane>();
  private readonly compositors: Compositor[] = [];
  private readonly channels: RunningChannel[] = [];
  private server: LocalServer | undefined;
  private readonly log: LogFn;
  private stopped = false;

  private constructor(private readonly o: GatewayOptions) {
    const c = o.config;
    // The default instance must be usable (e.g. its env refs set); others fail when a turn names them.
    this.harness();
    this.log = o.logger ?? ((level, msg) => console.error(`[aio] ${level}: ${msg}`));
    if (!o.log && c.logPath !== ':memory:') mkdirSync(dirname(c.logPath), { recursive: true, mode: 0o700 });
    this.hub = new Hub(o.log ?? new SqliteSessionLog({ path: c.logPath }));
    this.policy = {
      ...defaultPolicy({
        owners: c.policy.owners,
        selfAccounts: c.policy.selfAccounts,
        agentAccounts: c.policy.agentAccounts,
        routes: c.policy.routes,
        run: c.harnesses[c.defaultHarness]!.run,
        ...(c.policy.ownerSessionKey ? { ownerSessionKey: c.policy.ownerSessionKey } : {}),
      }),
      ...o.policy,
    } as FullPolicy;
    this.outbox = new Outbox({ hub: this.hub, policy: this.policy });
    this.blobs = new FsBlobStore(c.blobs);
    this.ingress = new Ingress({ policy: this.policy, lanes: (key) => this.lane(key), replyCaps: (ch, account) => this.replyCaps(ch, account) });
  }

  static async start(o: GatewayOptions): Promise<Gateway> {
    const gw = new Gateway(o);
    try {
      await gw.startChannels();
      await gw.adoptRunningTurns();
      if (o.listen !== false) {
        gw.server = new LocalServer(gw, o.config.socketPath);
        await gw.server.listen();
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

  /** The lane of a session, created on first use. Its harness session opens with the first turn. */
  lane(sessionKey: string): Lane {
    let lane = this.lanes.get(sessionKey);
    if (lane) return lane;
    lane = new Lane({
      sessionKey,
      harness: this.harness(),
      ...(this.o.harness ? {} : { harnessFor: (name: string) => this.harness(name) }),
      resumeFor: (id) => this.nativeIdOf(sessionKey, id),
      hub: this.hub,
      policy: this.policy,
      cwd: this.o.config.cwd,
      onHarnessEvent: (e) => this.o.onHarnessEvent?.(sessionKey, e),
    });
    this.lanes.set(sessionKey, lane);
    for (const ch of this.channels) this.compose(sessionKey, ch.adapter, ch.tier);
    return lane;
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
          emit: this.ingress.emitter(),
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
    const lane = this.lane(cmd.sessionKey);
    switch (cmd.type) {
      case 'input': {
        const input: InputRecord = {
          inputId: cmd.input.inputId ?? `in_${randomUUID()}`,
          origin,
          content: cmd.input.content,
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
    this.server?.close('gateway stopping');
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
    await within(new Promise(() => {}), 50);
    this.hub.log.close?.();
  }
}

function fail(code: string, message = code): Outcome {
  return { ok: false, code, message };
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
