import { spawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import {
  ChannelAdapterFrame,
  ChannelHello,
  PROTOCOL_VERSION,
  check,
  errors,
  type ChannelAdapter,
  type ChannelCaps,
  type ChannelContext,
  type InboundEnvelope,
} from '@agents-io/protocol';
import { FrameLink, isObject, sleep } from './link.js';

/** A failed bridge request. `retryable` is true for transport trouble (timeout, child exit). */
export class ChannelBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ChannelBridgeError';
  }
}

export interface BridgeOptions {
  account: string;
  config?: unknown;
  /** Per-request timeout. Default 30s. */
  requestTimeoutMs?: number;
  /** Consecutive request timeouts after which the peer counts as wedged and is killed (and restarted by `start`). Default 3. */
  timeoutsBeforeRestart?: number;
  /** Time allowed for the `hello` handshake. Default 10s. */
  helloTimeoutMs?: number;
  /** Restart backoff (exponential, capped). Default 200ms .. 10s. */
  backoff?: { minMs?: number; maxMs?: number };
  /** How long to wait for the peer to exit after `shutdown` before killing it. Default 2s. */
  shutdownGraceMs?: number;
  /** Logger used until `start` supplies `ctx.log`. */
  log?: ChannelContext['log'];
  /**
   * When the first connect (spawn + `hello`) fails, resolve `open` anyway with a
   * disconnected bridge instead of rejecting (except when the command cannot be run
   * at all: ENOENT / EACCES / ENOTDIR still reject); `start` then keeps retrying with the
   * restart backoff. Until a hello succeeds the adapter reports `id` (below) and
   * offline caps, and every request fails `unavailable` (retryable). Default false.
   */
  retryFirstConnect?: boolean;
  /** Adapter id before the first successful `hello` (with `retryFirstConnect`). Default `bridge`. */
  id?: string;
  /** Called whenever the peer connects, goes away, or a connect attempt fails. */
  onState?: (s: BridgeState) => void;
}

/** Connection state of a bridged channel. */
export interface BridgeState {
  connected: boolean;
  /** Why the last connect attempt failed, or why the peer went away. */
  error?: string;
}

export interface SpawnChannelOptions extends BridgeOptions {
  command: string;
  args?: string[];
  /** Merged over the parent environment. */
  env?: Record<string, string>;
  cwd?: string;
}

export type ConnectChannelOptions = BridgeOptions & ({ path: string } | { host: string; port: number });

/** The adapter returned by the host side; `close` stops the peer without needing `start`. */
export interface BridgedChannel extends ChannelAdapter {
  close(): Promise<void>;
  /** Connected to a peer that answered `hello`, and why not otherwise. */
  state(): BridgeState;
}

/** Caps of a bridge whose peer never answered `hello` (`retryFirstConnect`): plain final text only. */
export const OFFLINE_CHANNEL_CAPS: ChannelCaps = {
  text: { maxChars: 4000, markdown: 'none' },
  edit: false,
  buttons: false,
  media: { in: [], out: [] },
  voiceOut: 'none',
  threads: false,
  approvals: 'none',
  defaultTier: 'final',
  evidence: [],
  declaresSender: false,
};

interface Transport {
  input: Readable;
  output: Writable;
  stderr?: Readable;
  /** Resolves (never rejects) with a reason once the connection is gone. */
  closed: Promise<string>;
  kill(): void;
}

const ADAPTER_FRAME_TYPES = new Set(['result', 'inbound', 'log']);

/** Spawn a channel adapter process and attach to it over stdio. */
export function spawnChannel(opts: SpawnChannelOptions): Promise<BridgedChannel> {
  return Bridge.open(opts, () => {
    const child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Promise<Transport>((resolve, reject) => {
      const closed = new Promise<string>((done) => {
        child.once('close', (code, sig) => done(`exited (${sig ?? code})`));
      });
      child.once('error', (err) => {
        reject(err);
        // `close` may never fire when spawn itself failed.
        child.emit('close', null, 'spawn_error');
      });
      child.once('spawn', () =>
        resolve({
          input: child.stdout,
          output: child.stdin,
          stderr: child.stderr,
          closed,
          kill: () => child.kill('SIGKILL'),
        }),
      );
    });
  });
}

/** The child process could not be started at all (ENOENT, EACCES, …): retrying will not help. */
function isSpawnError(err: unknown): boolean {
  const e = err as { code?: unknown; syscall?: unknown } | undefined;
  return typeof e?.syscall === 'string' && e.syscall.startsWith('spawn') && (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'ENOTDIR');
}

/** Attach to an already-running adapter listening on a unix socket (`path`) or TCP (`host`+`port`). */
export function connectChannel(opts: ConnectChannelOptions): Promise<BridgedChannel> {
  return Bridge.open(opts, () => {
    const sock = 'path' in opts ? netConnect({ path: opts.path }) : netConnect({ host: opts.host, port: opts.port });
    return new Promise<Transport>((resolve, reject) => {
      const closed = new Promise<string>((done) => sock.once('close', () => done('socket closed')));
      sock.once('error', reject);
      sock.once('connect', () => {
        sock.off('error', reject);
        sock.on('error', () => {});
        resolve({ input: sock, output: sock, closed, kill: () => sock.destroy() });
      });
    });
  });
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

interface Conn {
  transport: Transport;
  link: FrameLink;
  pending: Map<string, Pending>;
  since: number;
  gone: boolean;
  /** Requests that timed out since the peer last answered one. */
  timeouts: number;
}

class Bridge implements BridgedChannel {
  private conn: Conn | undefined;
  private hello: ChannelHello | undefined;
  private lastError: string | undefined;
  /** `open` returned without a peer (`retryFirstConnect`): `start` waits a backoff step before dialing. */
  private firstFailed = false;
  private ctx: ChannelContext | undefined;
  private ctxWaiters: (() => void)[] = [];
  private nextId = 0;
  private closing = false;
  /** Aborted by `close`, so a running `start` loop stops too. */
  private readonly stopper = new AbortController();
  /** The transport whose hello is in flight, so `close` can cut it short. */
  private dialing: Transport | undefined;
  private log: ChannelContext['log'];
  private readonly requestTimeoutMs: number;
  private readonly timeoutsBeforeRestart: number;
  private readonly helloTimeoutMs: number;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly grace: number;

  // Optional methods are attached in `open` only when the peer declared them.
  edit?: ChannelAdapter['edit'];
  finalize?: ChannelAdapter['finalize'];
  retract?: ChannelAdapter['retract'];
  speak?: ChannelAdapter['speak'];
  typing?: ChannelAdapter['typing'];
  reconcile?: ChannelAdapter['reconcile'];

  private constructor(
    private readonly opts: BridgeOptions,
    private readonly opener: () => Promise<Transport>,
  ) {
    this.log = opts.log ?? (() => {});
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.timeoutsBeforeRestart = opts.timeoutsBeforeRestart ?? 3;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
    this.minBackoff = opts.backoff?.minMs ?? 200;
    this.maxBackoff = opts.backoff?.maxMs ?? 10_000;
    this.grace = opts.shutdownGraceMs ?? 2_000;
  }

  static async open(opts: BridgeOptions, opener: () => Promise<Transport>): Promise<BridgedChannel> {
    const b = new Bridge(opts, opener);
    try {
      await b.connect();
    } catch (err) {
      // A command that cannot be run at all (missing, not executable) is a config error, not a peer that is not up yet.
      if (!opts.retryFirstConnect || b.closing || isSpawnError(err)) throw err;
      b.firstFailed = true;
      b.failed(err);
      b.log('warn', `channel connect failed: ${errMsg(err)}; retrying once started`);
    }
    return b;
  }

  /** Optional methods as the latest `hello` declared them. */
  private attachMethods(methods: readonly string[]): void {
    const has = new Set<string>(methods);
    const set = <K extends 'edit' | 'finalize' | 'retract' | 'speak' | 'typing' | 'reconcile'>(k: K, f: ChannelAdapter[K]) => {
      if (has.has(k)) this[k] = f as this[K];
      else delete this[k];
    };
    set('edit', async (route, providerMessageId, msg, op) => void (await this.request('edit', { route, providerMessageId, msg, op })));
    set('finalize', async (route, providerMessageId, msg) => void (await this.request('finalize', { route, providerMessageId, msg })));
    set('retract', async (route, providerMessageId, outcome) => void (await this.request('retract', { route, providerMessageId, outcome })));
    set('speak', async (route, utterance) => void (await this.request('speak', { route, utterance })));
    set('typing', async (route, on) => void (await this.request('typing', { route, on })));
    set('reconcile', async (route, providerMessageId) => {
      const v = await this.request('reconcile', { route, providerMessageId });
      if (v !== 'alive' && v !== 'gone') throw new ChannelBridgeError('bad_result', `reconcile returned ${JSON.stringify(v)}`, false);
      return v;
    });
  }

  get id(): string {
    return this.hello?.adapterId ?? this.opts.id ?? 'bridge';
  }

  caps(): ChannelCaps {
    return this.hello?.caps ?? OFFLINE_CHANNEL_CAPS;
  }

  state(): BridgeState {
    return { connected: !!this.conn, ...(this.lastError !== undefined ? { error: this.lastError } : {}) };
  }

  private failed(err: unknown): void {
    this.lastError = errMsg(err);
    this.opts.onState?.(this.state());
  }

  async send(route: Parameters<ChannelAdapter['send']>[0], msg: Parameters<ChannelAdapter['send']>[1], op: Parameters<ChannelAdapter['send']>[2]) {
    const v = await this.request('send', { route, msg, op });
    if (v === undefined || v === null) return {};
    if (!isObject(v) || (v.providerMessageId !== undefined && typeof v.providerMessageId !== 'string'))
      throw new ChannelBridgeError('bad_result', 'send returned a malformed SendResult', false);
    return v.providerMessageId === undefined ? {} : { providerMessageId: v.providerMessageId as string };
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.ctx = ctx;
    this.log = ctx.log;
    for (const w of this.ctxWaiters.splice(0)) w();
    const signal = AbortSignal.any([ctx.signal, this.stopper.signal]);
    const aborted = new Promise<'abort'>((r) => {
      if (signal.aborted) r('abort');
      else signal.addEventListener('abort', () => r('abort'), { once: true });
    });
    let attempt = 0;
    if (this.firstFailed) {
      // `open` just failed to connect: back off before dialing again.
      this.firstFailed = false;
      await sleep(this.delay(attempt++), signal);
    }
    while (!signal.aborted) {
      if (!this.conn) {
        try {
          await this.connect();
        } catch (err) {
          if (signal.aborted) break;
          this.failed(err);
          const wait = this.delay(attempt++);
          this.log('warn', `channel connect failed: ${errMsg(err)}; retry in ${wait}ms`);
          await sleep(wait, signal);
          continue;
        }
        // Aborted while connecting: the fresh peer is shut down by `close` below.
        if (signal.aborted) break;
      }
      const conn = this.conn!;
      const why = await Promise.race([conn.transport.closed, aborted]);
      if (why === 'abort') break;
      if (Date.now() - conn.since >= this.maxBackoff) attempt = 0;
      const wait = this.delay(attempt++);
      this.log('warn', `channel peer ${why}; restarting in ${wait}ms`);
      await sleep(wait, signal);
    }
    await this.close();
  }

  /** Ask the peer to shut down, then kill it after the grace period. Safe to call twice. */
  async close(): Promise<void> {
    this.closing = true;
    this.stopper.abort();
    const dialing = this.dialing;
    if (dialing) {
      dialing.kill();
      await dialing.closed;
    }
    const conn = this.conn;
    if (!conn) return;
    conn.link.send({ v: PROTOCOL_VERSION, type: 'shutdown' });
    const exited = await Promise.race([conn.transport.closed.then(() => true), sleep(this.grace).then(() => false)]);
    if (!exited) conn.transport.kill();
    await conn.transport.closed;
  }

  private delay(attempt: number): number {
    return Math.min(this.maxBackoff, this.minBackoff * 2 ** attempt);
  }

  // ---- connection ---------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.closing) throw new ChannelBridgeError('closed', 'bridge is closing', false);
    const transport = await this.opener();
    const pending = new Map<string, Pending>();
    const conn: Conn = { transport, pending, since: Date.now(), gone: false, timeouts: 0, link: undefined as never };
    conn.link = new FrameLink(
      transport.input,
      transport.output,
      (f) => this.onFrame(conn, f),
      (line, err) => this.log('warn', 'dropping malformed line from channel peer', { line: line.slice(0, 200), error: errMsg(err) }),
      () => {},
    );
    if (transport.stderr) {
      transport.stderr.setEncoding('utf8');
      let buf = '';
      transport.stderr.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trimEnd();
          buf = buf.slice(nl + 1);
          if (line) this.log('info', line, { stream: 'stderr' });
        }
      });
    }
    void transport.closed.then((reason) => {
      conn.gone = true;
      if (this.conn === conn) {
        this.conn = undefined;
        if (!this.closing) this.failed(`channel peer ${reason}`);
      }
      for (const [id, p] of conn.pending) {
        clearTimeout(p.timer);
        p.reject(new ChannelBridgeError('peer_closed', `channel peer ${reason}`, true));
        conn.pending.delete(id);
      }
    });
    if (this.closing) {
      transport.kill();
      throw new ChannelBridgeError('closed', 'bridge is closing', false);
    }
    this.dialing = transport;
    try {
      const value = await this.call(conn, 'hello', { account: this.opts.account, config: this.opts.config }, this.helloTimeoutMs);
      if (!check(ChannelHello, value)) throw new ChannelBridgeError('bad_hello', `invalid hello: ${errors(ChannelHello, value).slice(0, 3).join('; ')}`, false);
      this.hello = value;
      this.attachMethods(value.methods);
    } catch (err) {
      transport.kill();
      throw err;
    } finally {
      this.dialing = undefined;
    }
    if (this.closing) {
      transport.kill();
      throw new ChannelBridgeError('closed', 'bridge is closing', false);
    }
    this.conn = conn;
    this.lastError = undefined;
    this.opts.onState?.(this.state());
  }

  private request(type: string, body: Record<string, unknown>): Promise<unknown> {
    const conn = this.conn;
    if (!conn) return Promise.reject(new ChannelBridgeError('unavailable', 'channel peer is not connected', true));
    return this.call(conn, type, body, this.requestTimeoutMs);
  }

  private call(conn: Conn, type: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = `h${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new ChannelBridgeError('timeout', `${type} timed out after ${timeoutMs}ms`, true));
        // Alive but not answering: kill it so `start` restarts it like a crashed peer.
        if (++conn.timeouts >= this.timeoutsBeforeRestart && !conn.gone) {
          this.log('warn', `channel peer not answering (${conn.timeouts} requests timed out); killing it`);
          conn.transport.kill();
        }
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      if (!conn.link.send({ v: PROTOCOL_VERSION, type, id, ...body })) {
        clearTimeout(timer);
        conn.pending.delete(id);
        if (conn.link.congested && !conn.gone) {
          this.log('warn', 'channel peer stopped reading its input; killing it');
          conn.transport.kill();
        }
        reject(new ChannelBridgeError('peer_closed', 'channel peer is gone', true));
      }
    });
  }

  // ---- incoming frames ----------------------------------------------------

  private onFrame(conn: Conn, raw: unknown): void {
    if (!isObject(raw) || typeof raw.type !== 'string') {
      this.log('warn', 'dropping frame without a type', { frame: preview(raw) });
      return;
    }
    // Unknown types are ignored so either side can be newer.
    if (!ADAPTER_FRAME_TYPES.has(raw.type)) {
      this.log('debug', `ignoring unknown frame type ${raw.type}`);
      return;
    }
    if (!check(ChannelAdapterFrame, raw)) {
      this.log('warn', `dropping invalid ${raw.type} frame`, { errors: errors(ChannelAdapterFrame, raw).slice(0, 3), frame: preview(raw) });
      // A malformed answer still settles its request, with the peer's message if there is one.
      if (raw.type === 'result' && typeof raw.id === 'string') {
        const p = conn.pending.get(raw.id);
        if (p) {
          conn.pending.delete(raw.id);
          clearTimeout(p.timer);
          conn.timeouts = 0;
          const e = raw.error;
          const why = isObject(e) && typeof e.message === 'string' ? `: ${e.message}` : '';
          p.reject(new ChannelBridgeError('bad_result', `malformed result frame${why}`, false));
        }
      }
      // Don't leave the peer waiting on an inbound we refuse.
      if (raw.type === 'inbound' && typeof raw.id === 'string')
        conn.link.send({
          v: PROTOCOL_VERSION,
          type: 'result',
          id: raw.id,
          ok: false,
          error: { code: 'invalid_frame', message: 'inbound frame failed validation', retryable: false },
        });
      return;
    }
    switch (raw.type) {
      case 'result': {
        const p = conn.pending.get(raw.id as string);
        if (!p) return; // late answer after timeout
        conn.pending.delete(raw.id as string);
        clearTimeout(p.timer);
        conn.timeouts = 0;
        if (raw.ok) p.resolve(raw.value);
        else {
          const e = raw.error as { code: string; message: string; retryable?: boolean } | undefined;
          p.reject(new ChannelBridgeError(e?.code ?? 'error', e?.message ?? 'channel request failed', e?.retryable ?? false));
        }
        return;
      }
      case 'log': {
        const level = raw.level as 'debug' | 'info' | 'warn' | 'error' | 'fatal';
        this.log(level, String(raw.msg), raw.data);
        // `fatal`: the adapter gave up. Treat it as dead; `start` restarts it with backoff.
        if (level === 'fatal' && !conn.gone) conn.transport.kill();
        return;
      }
      case 'inbound':
        void this.onInbound(conn, raw.id as string, raw.envelope as InboundEnvelope);
        return;
    }
  }

  private async onInbound(conn: Conn, id: string, envelope: InboundEnvelope): Promise<void> {
    // Messages that arrive before `start` wait for the context instead of being lost.
    if (!this.ctx) await new Promise<void>((r) => this.ctxWaiters.push(r));
    try {
      const value = await this.ctx!.emit(envelope);
      conn.link.send({ v: PROTOCOL_VERSION, type: 'result', id, ok: true, value });
    } catch (err) {
      conn.link.send({ v: PROTOCOL_VERSION, type: 'result', id, ok: false, error: { code: 'emit_failed', message: errMsg(err), retryable: true } });
    }
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const preview = (v: unknown) => JSON.stringify(v)?.slice(0, 200);
