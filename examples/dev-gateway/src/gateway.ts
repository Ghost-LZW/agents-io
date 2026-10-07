import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  routeKey,
  type ChannelAdapter,
  type HarnessAdapter,
  type HarnessEvent,
  type InputRecord,
  type Origin,
  type Policy,
  type ReplyRoute,
  type Tier,
} from '@agents-io/protocol';
import {
  Compositor,
  Hub,
  Ingress,
  Lane,
  Outbox,
  SqliteSessionLog,
  defaultPolicy,
  type FullPolicy,
  type SessionLog,
} from '@agents-io/session';
import { ClaudeCodeHarness } from '@agents-io/harness-claude-code';
import { CodexHarness, type CodexProfile } from '@agents-io/harness-codex';
import { LarkBotAdapter } from '@agents-io/channel-lark-bot';
import { MailChannel, type MailChannelConfig } from '@agents-io/channel-mail';
import { spawnChannel } from '@agents-io/channel-jsonl-bridge';
import type { Config, HarnessConfig, ResolvedChannel } from './config.js';
import type { ClientCommand, SessionInfo } from './frames.js';
import { LocalServer } from './local-server.js';

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => void;

/** An in-process channel handed to the gateway (tests and e2e scripted ends). */
export interface ExtraChannel {
  adapter: ChannelAdapter;
  account?: string;
  tier?: Tier;
}

export interface GatewayOptions {
  config: Config;
  /** Use this harness instead of building one from the config (tests). */
  harness?: HarnessAdapter;
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
  readonly harness: HarnessAdapter;
  readonly outbox: Outbox;
  private readonly lanes = new Map<string, Lane>();
  private readonly compositors: Compositor[] = [];
  private readonly channels: RunningChannel[] = [];
  private server: LocalServer | undefined;
  private readonly log: LogFn;
  private stopped = false;

  private constructor(private readonly o: GatewayOptions) {
    const c = o.config;
    this.log = o.logger ?? ((level, msg) => console.error(`[aio] ${level}: ${msg}`));
    if (!o.log && c.logPath !== ':memory:') mkdirSync(dirname(c.logPath), { recursive: true, mode: 0o700 });
    this.hub = new Hub(o.log ?? new SqliteSessionLog({ path: c.logPath }));
    this.policy = {
      ...defaultPolicy({
        owners: c.policy.owners,
        selfAccounts: c.policy.selfAccounts,
        agentAccounts: c.policy.agentAccounts,
        routes: c.policy.routes,
        run: c.harness.run,
        ...(c.policy.ownerSessionKey ? { ownerSessionKey: c.policy.ownerSessionKey } : {}),
      }),
      ...o.policy,
    } as FullPolicy;
    this.harness = o.harness ?? buildHarness(c.harness);
    this.outbox = new Outbox({ hub: this.hub, policy: this.policy });
    this.ingress = new Ingress({ policy: this.policy, lanes: (key) => this.lane(key) });
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

  /** The lane of a session, created on first use. Its harness session opens with the first turn. */
  lane(sessionKey: string): Lane {
    let lane = this.lanes.get(sessionKey);
    if (lane) return lane;
    const h = this.o.config.harness;
    const resume = this.nativeIdOf(sessionKey);
    lane = new Lane({
      sessionKey,
      harness: this.harness,
      hub: this.hub,
      policy: this.policy,
      cwd: this.o.config.cwd,
      ...(resume ? { resume } : {}),
      harnessOptions: h.kind === 'claude-code' ? { ...h.options, profiles: h.profiles, env: { ...h.env, ...(h.options.env as object | undefined) } } : h.options,
      onHarnessEvent: (e) => this.o.onHarnessEvent?.(sessionKey, e),
    });
    this.lanes.set(sessionKey, lane);
    for (const ch of this.channels) this.compose(sessionKey, ch.adapter, ch.tier);
    return lane;
  }

  /** The harness's own session/thread id last bound to this session, so a restart resumes it. */
  private nativeIdOf(sessionKey: string): string | undefined {
    let id: string | undefined;
    for (const e of this.hub.log.read(sessionKey, 0)) {
      if (e.body.t === 'session.bound' && e.harness === this.harness.id) id = e.body.nativeId;
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
          emit: this.ingress.emitter(),
          log: (level, msg) => this.log(level, `${ch.adapter.id}: ${msg}`),
        })
        .catch((err: Error) => this.log('error', `channel ${ch.adapter.id} stopped: ${err.message}`));
      this.channels.push({ adapter: ch.adapter, account: ch.account, ...(ch.tier ? { tier: ch.tier } : {}), ac, running, ...(ch.close ? { close: ch.close } : {}) });
      this.log('info', `channel ${ch.adapter.id} (${ch.account}) started`);
    }
  }

  /**
   * Sessions the log shows mid-turn were left by a previous process. A Codex
   * app-server on a Unix socket may still be running that turn: open the session
   * now so the harness adopts it (turn.adopted) instead of waiting for input.
   */
  private async adoptRunningTurns(): Promise<void> {
    const h = this.o.config.harness;
    if (!(this.harness instanceof CodexHarness) || h.transport.kind !== 'unix') return;
    for (const key of this.hub.log.sessions()) {
      const snap = this.hub.snapshot(key);
      if (!snap.turn || snap.harness !== this.harness.id) continue;
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
    const lanes = [...this.lanes.values()];
    if (this.harness instanceof CodexHarness) {
      for (const l of lanes) l.detach();
      await within(this.harness.detach(), 5000);
    } else {
      // Bounded by a timer that holds the event loop: harness close() may wait on unref'd timers only.
      await within(Promise.all(lanes.map((l) => l.close('gateway stopping').catch(() => undefined))), 8000);
      // Let the last events (interrupted turn, consumed inputs) reach the log before it closes.
      await within(Promise.all(lanes.map((l) => l.whenIdle())), 3000);
    }
    await within(Promise.all(this.compositors.map((c) => c.stop())), 5000);
    for (const ch of this.channels) await within(ch.close?.().catch(() => undefined), 3000);
    await within(new Promise(() => {}), 50);
    this.hub.log.close?.();
  }
}

function fail(code: string, message = code): Outcome {
  return { ok: false, code, message };
}

export function buildHarness(h: HarnessConfig): HarnessAdapter {
  if (h.kind === 'codex') {
    return new CodexHarness({
      bin: h.codexBin ?? 'codex',
      transport: h.transport,
      env: { ...process.env, ...h.env },
      profiles: h.profiles as Record<string, CodexProfile>,
    });
  }
  return new ClaudeCodeHarness(h.claudePath ? { claudePath: h.claudePath } : {});
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
