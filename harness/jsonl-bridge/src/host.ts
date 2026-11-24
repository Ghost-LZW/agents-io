import { spawn, type ChildProcess } from 'node:child_process';
import {
  BLOB_GET_MAX_BYTES,
  HARNESS_ADAPTER_FRAME_TYPES,
  HARNESS_BRIDGE_FEATURES,
  HARNESS_DECLARATION_KEYS,
  HarnessAdapterFrame,
  OpenResult,
  PROTOCOL_VERSION,
  ProbeResult,
  STEER_RESULTS,
  check,
  errors,
  type BlobAccess,
  type Decision,
  type HarnessAdapter,
  type HarnessCaps,
  type HarnessDeclares,
  type HarnessEvent,
  type HarnessOpenArgs,
  type HarnessSession,
  type InputRecord,
  type NativeClient,
  type RunSpec,
  type SessionEnvSupport,
  type SteerResult,
} from '@agents-io/protocol';
import { AsyncQueue, FrameLink, errMsg, isObject, sleep } from './link.js';

/*
 * The host side of the harness bridge: a `HarnessAdapter` whose harness is a program in another
 * process (any language), spoken to over JSONL stdio (`HarnessHostFrame` / `HarnessAdapterFrame`
 * in `@agents-io/protocol`). The program starts on the first `probe` or `open` and says in its
 * answer to `probe` what it declares (`ProbeResult.declares`, `methods`); until then the adapter
 * declares nothing. A program that goes away ends its sessions (their event streams end); the next
 * `probe` or `open` starts it again, and that hello must declare what the first one did.
 */

/** A failed bridge request. `retryable` is true for transport trouble (timeout, the program exited). */
export class HarnessBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HarnessBridgeError';
  }
}

export type HarnessBridgeLog = (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => void;

export interface HarnessBridgeOptions {
  command: string;
  args?: string[];
  /** The program's environment over the host's; `undefined` removes a variable. SECRET: never logged. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The program's working directory (default the host's). */
  cwd?: string;
  /** The adapter's id (default `bridge`). */
  id?: string;
  /** Sent in `probe` as `instance`. */
  instance?: string;
  /** Sent in `probe` as `config`. */
  config?: unknown;
  /** Answers the program's `blob.stat` / `blob.get`, read-only; without it they fail `unsupported`. */
  blobs?: BlobAccess;
  log?: HarnessBridgeLog;
  /** Per-request timeout. Default 60s. */
  requestTimeoutMs?: number;
  /** Time allowed for the `probe` handshake. Default 10s. */
  helloTimeoutMs?: number;
  /** Consecutive request timeouts after which the program counts as wedged and is killed. Default 3. */
  timeoutsBeforeRestart?: number;
  /** How long to wait for the program to exit after `shutdown` before killing it. Default 2s. */
  shutdownGraceMs?: number;
}

/** The adapter `spawnHarness` returns. */
export interface BridgedHarness extends HarnessAdapter {
  /** Shut the program down (`shutdown`, killed after the grace period); final: nothing starts it again. */
  dispose(): Promise<void>;
  /** Connected to a program that answered `probe`, and why not otherwise. */
  state(): { connected: boolean; error?: string };
}

/** A harness program attached over stdio. Starts nothing: the first `probe` or `open` starts the program. */
export function spawnHarness(opts: HarnessBridgeOptions): BridgedHarness {
  return new HarnessBridge(opts);
}

/** A program's validated answer to `probe`: what the bridge declares and has. */
interface Hello {
  version: string;
  caps: HarnessCaps;
  declares: HarnessDeclares;
  /** The optional adapter methods it implements that this host knows: `detach`. */
  methods: string[];
  /** `declares` and `methods` as one string: a restarted program's hello must equal the first one's. */
  key: string;
}

/** Adapter methods a program may name in `methods` that this host carries. */
const KNOWN_METHODS = ['detach'] as const;
const ADAPTER_FRAME_TYPES = new Set<string>(HARNESS_ADAPTER_FRAME_TYPES);
const STEERED = new Set<string>(STEER_RESULTS);

/** The program's answer to `probe`, checked: why it is refused, or what it says. */
function readHello(v: unknown): Hello | string {
  if (!check(ProbeResult, v)) return `invalid probe answer: ${errors(ProbeResult, v).slice(0, 3).join('; ')}`;
  const d = v.declares ?? {};
  // The bridge carries no takeover (`HarnessAdapter.takeover`), which an in-process adapter needs for it too.
  if (d.attach === 'takeover') return "declares attach 'takeover', which needs a takeover (HarnessAdapter.takeover); the bridge cannot carry one";
  // In one order (`Hello.key`).
  const declares = Object.fromEntries(HARNESS_DECLARATION_KEYS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]])) as HarnessDeclares;
  const methods = KNOWN_METHODS.filter((m) => v.methods?.includes(m));
  return { version: v.version, caps: v.caps, declares, methods, key: JSON.stringify({ declares, methods }) };
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

interface Conn {
  child: ChildProcess;
  link: FrameLink;
  pending: Map<string, Pending>;
  /** Open sessions by key; a newer open of a key replaces the older. */
  sessions: Map<string, BridgedSession>;
  /** Resolves (never rejects) with why, once the program has exited. */
  closed: Promise<string>;
  gone: boolean;
  /** Requests that timed out since the program last answered one. */
  timeouts: number;
}

class HarnessBridge implements BridgedHarness {
  readonly id: string;
  private conn: Conn | undefined;
  private connecting: Promise<Conn> | undefined;
  private hello: Hello | undefined;
  /** No more connections: disposed or detached. */
  private ended = false;
  private lastError: string | undefined;
  private nextId = 0;
  /** How a terminal joins a native session (`nativeId.client`, `OpenResult.client`), by native id. */
  private readonly clients = new Map<string, NativeClient>();
  private readonly log: HarnessBridgeLog;
  private readonly requestTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly timeoutsBeforeRestart: number;
  private readonly grace: number;

  // Present only when the program's hello says so (`methods`, `declares.sessionEnv`).
  declare detach?: () => Promise<void>;
  declare ownProcess?: (o: { env: Record<string, string>; cwd?: string }) => HarnessAdapter;

  constructor(
    private readonly opts: HarnessBridgeOptions,
    /** What the program must declare (an `ownProcess` copy: its parent's hello), known before it starts. */
    private readonly pinned?: Hello,
  ) {
    this.id = opts.id ?? 'bridge';
    this.log = opts.log ?? (() => {});
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
    this.timeoutsBeforeRestart = opts.timeoutsBeforeRestart ?? 3;
    this.grace = opts.shutdownGraceMs ?? 2_000;
    if (pinned) this.attachMethods(pinned);
  }

  // ---- static declarations: the program's hello (an `ownProcess` copy: its parent's until then) ----

  private get declared(): HarnessDeclares {
    return (this.hello ?? this.pinned)?.declares ?? {};
  }
  get displayName(): string | undefined {
    return this.declared.displayName;
  }
  get compact(): { readonly command: string } | undefined {
    return this.declared.compact;
  }
  get modes(): readonly 'plan'[] | undefined {
    return this.declared.modes;
  }
  get ownerProfileSwitch(): boolean | undefined {
    return this.declared.ownerProfileSwitch;
  }
  get ephemeralOpen(): boolean | undefined {
    return this.declared.ephemeralOpen;
  }
  get adopts(): boolean | undefined {
    return this.declared.adopts;
  }
  get attach(): 'join' | 'takeover' | undefined {
    return this.declared.attach;
  }
  get sessionEnv(): SessionEnvSupport | undefined {
    return this.declared.sessionEnv;
  }

  /** The optional methods as a hello declares them. */
  private attachMethods(h: Hello): void {
    if (h.methods.includes('detach')) this.detach = () => this.detachNow();
    else delete this.detach;
    // One process serves every session: a launched session's env gets a copy of the program of its own.
    if (h.declares.sessionEnv === 'own-process')
      this.ownProcess = (o) => new HarnessBridge({ ...this.opts, env: { ...this.opts.env, ...o.env }, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}) }, this.hello ?? this.pinned);
    else delete this.ownProcess;
  }

  state(): { connected: boolean; error?: string } {
    return { connected: !!this.conn, ...(this.lastError !== undefined ? { error: this.lastError } : {}) };
  }

  async probe(): Promise<{ version: string; caps: HarnessCaps }> {
    await this.connect();
    const h = this.hello!;
    return { version: h.version, caps: h.caps };
  }

  async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    const conn = await this.connect();
    const caps = this.hello!.caps;
    // Events may come before the answer: the session is there to take them.
    conn.sessions.get(args.sessionKey)?.end();
    const s = new BridgedSession(this, conn, args.sessionKey, args.generation, caps);
    conn.sessions.set(args.sessionKey, s);
    try {
      const v = await this.call(conn, 'open', openBody(args), this.requestTimeoutMs);
      if (v !== undefined && v !== null) {
        if (!check(OpenResult, v)) throw new HarnessBridgeError('bad_result', `open answered ${preview(v)}: ${errors(OpenResult, v).slice(0, 3).join('; ')}`, false);
        if (v.nativeId !== undefined) s.native = v.nativeId;
        if (v.nativeId !== undefined && v.client) this.clients.set(v.nativeId, v.client);
      }
    } catch (err) {
      s.end();
      throw err;
    }
    return s;
  }

  nativeClient(nativeId: string): NativeClient | undefined {
    const c = this.clients.get(nativeId);
    return c && { command: c.command, args: [...c.args], ...(c.env ? { env: { ...c.env } } : {}) };
  }

  /** The program detaches every session (no interrupt, no more events), then it is shut down. Present only when it says it can. */
  private async detachNow(): Promise<void> {
    this.ended = true;
    const conn = this.conn;
    if (!conn || conn.gone) return;
    try {
      await this.call(conn, 'detach', {}, this.requestTimeoutMs);
    } catch (err) {
      this.log('warn', `detach failed: ${errMsg(err)}`);
    }
    for (const s of [...conn.sessions.values()]) s.end();
    await this.shutdown(conn);
  }

  async dispose(): Promise<void> {
    this.ended = true;
    // A program still starting is shut down once it said hello (`dial` sees `ended`).
    await this.connecting?.catch(() => undefined);
    const conn = this.conn;
    if (conn && !conn.gone) await this.shutdown(conn);
  }

  private async shutdown(conn: Conn): Promise<void> {
    conn.link.send({ v: PROTOCOL_VERSION, type: 'shutdown' });
    const exited = await Promise.race([conn.closed.then(() => true), sleep(this.grace).then(() => false)]);
    if (!exited) conn.child.kill('SIGKILL');
    await conn.closed;
  }

  // ---- connection ---------------------------------------------------------

  private connect(): Promise<Conn> {
    if (this.ended) return Promise.reject(new HarnessBridgeError('closed', 'the harness program was shut down', false));
    if (this.conn && !this.conn.gone) return Promise.resolve(this.conn);
    return (this.connecting ??= this.dial().finally(() => (this.connecting = undefined)));
  }

  private async dial(): Promise<Conn> {
    const o = this.opts;
    const child = spawn(o.command, o.args ?? [], { ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), env: childEnv(o.env), stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise<string>((done) => child.once('close', (code, sig) => done(`exited (${sig ?? code})`)));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (err) => {
        reject(err);
        // `close` may never fire when spawn itself failed.
        child.emit('close', null, 'spawn_error');
      });
    }).catch((err: unknown) => {
      this.lastError = errMsg(err);
      throw err;
    });
    child.on('error', () => {});
    const conn: Conn = { child, pending: new Map(), sessions: new Map(), closed, gone: false, timeouts: 0, link: undefined as never };
    conn.link = new FrameLink(
      child.stdout!,
      child.stdin!,
      (f) => this.onFrame(conn, f),
      (line, err) => this.log('warn', 'dropping malformed line from the harness program', { line: line.slice(0, 200), error: errMsg(err) }),
      () => {},
    );
    child.stderr!.setEncoding('utf8');
    let buf = '';
    child.stderr!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (line) this.log('info', line, { stream: 'stderr' });
      }
    });
    void closed.then((reason) => this.lost(conn, reason));
    let hello: Hello | string;
    try {
      const features: string[] = [...HARNESS_BRIDGE_FEATURES];
      hello = readHello(await this.call(conn, 'probe', { features, ...(o.instance !== undefined ? { instance: o.instance } : {}), ...(o.config !== undefined ? { config: o.config } : {}) }, this.helloTimeoutMs));
      const first = this.hello ?? this.pinned;
      if (typeof hello !== 'string' && first && hello.key !== first.key) hello = `declares ${hello.key}, but the program declared ${first.key} when it started; a restarted program must declare the same`;
      if (typeof hello === 'string') throw new HarnessBridgeError('bad_hello', hello, false);
      if (this.ended) throw new HarnessBridgeError('closed', 'the harness program was shut down', false);
    } catch (err) {
      this.lastError = errMsg(err);
      child.kill('SIGKILL');
      await closed;
      throw err;
    }
    this.hello = hello;
    this.attachMethods(hello);
    this.conn = conn;
    this.lastError = undefined;
    return conn;
  }

  /** The program exited: its sessions end (their lanes see the harness close), its requests fail retryably. */
  private lost(conn: Conn, reason: string): void {
    conn.gone = true;
    if (this.conn === conn) {
      this.conn = undefined;
      if (!this.ended) {
        this.lastError = `harness program ${reason}`;
        this.log('warn', `harness program ${reason}`);
      }
    }
    for (const [id, p] of conn.pending) {
      clearTimeout(p.timer);
      p.reject(new HarnessBridgeError('peer_closed', `harness program ${reason}`, true));
      conn.pending.delete(id);
    }
    for (const s of [...conn.sessions.values()]) s.end();
  }

  /** A request to `conn`'s program; its answer's `value`. */
  call(conn: Conn, type: string, body: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (conn.gone) return Promise.reject(new HarnessBridgeError('peer_closed', 'the harness program is gone', true));
    const id = `h${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new HarnessBridgeError('timeout', `${type} timed out after ${timeoutMs}ms`, true));
        // Alive but not answering: kill it, so the next open starts it again.
        if (++conn.timeouts >= this.timeoutsBeforeRestart && !conn.gone) {
          this.log('warn', `harness program not answering (${conn.timeouts} requests timed out); killing it`);
          conn.child.kill('SIGKILL');
        }
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      if (!conn.link.send({ v: PROTOCOL_VERSION, type, id, ...body })) {
        clearTimeout(timer);
        conn.pending.delete(id);
        if (conn.link.congested && !conn.gone) {
          this.log('warn', 'harness program stopped reading its input; killing it');
          conn.child.kill('SIGKILL');
        }
        reject(new HarnessBridgeError('peer_closed', 'the harness program is gone', true));
      }
    });
  }

  // ---- incoming frames ----------------------------------------------------

  private onFrame(conn: Conn, raw: unknown): void {
    if (!isObject(raw) || typeof raw.type !== 'string') return void this.log('warn', 'dropping frame without a type', { frame: preview(raw) });
    // Unknown types are ignored so either side can be newer.
    if (!ADAPTER_FRAME_TYPES.has(raw.type)) return void this.log('debug', `ignoring unknown frame type ${raw.type}`);
    if (!check(HarnessAdapterFrame, raw)) {
      this.log('warn', `dropping invalid ${raw.type} frame`, { errors: errors(HarnessAdapterFrame, raw).slice(0, 3), frame: preview(raw) });
      // A malformed answer still settles its request; a malformed request is still answered.
      if (typeof raw.id === 'string') {
        if (raw.type === 'result') this.settle(conn, raw.id, false, undefined, { code: 'bad_result', message: `malformed result frame${isObject(raw.error) && typeof raw.error.message === 'string' ? `: ${raw.error.message}` : ''}` });
        else conn.link.send({ v: PROTOCOL_VERSION, type: 'result', id: raw.id, ok: false, error: { code: 'invalid_frame', message: `${raw.type} frame failed validation`, retryable: false } });
      }
      return;
    }
    const f = raw as HarnessAdapterFrame;
    switch (f.type) {
      case 'result':
        return this.settle(conn, f.id, f.ok, f.value, f.error);
      case 'event': {
        const s = conn.sessions.get(f.sessionKey);
        if (s?.generation === f.generation) s.queue.push(f.event);
        return;
      }
      case 'nativeId': {
        const s = conn.sessions.get(f.sessionKey);
        if (s) s.native = f.nativeId;
        if (f.client) this.clients.set(f.nativeId, f.client);
        return;
      }
      case 'closed': {
        const s = conn.sessions.get(f.sessionKey);
        if (s?.generation === f.generation) s.end();
        return;
      }
      case 'blob.stat':
      case 'blob.get':
        return void this.answerBlob(conn, f.id, f.type, f.ref);
      case 'log':
        this.log(f.level, f.msg, f.data);
        // `fatal`: the program gave up. It is killed; the next open starts it again.
        if (f.level === 'fatal' && !conn.gone) conn.child.kill('SIGKILL');
        return;
    }
  }

  private settle(conn: Conn, id: string, ok: boolean, value: unknown, error: { code: string; message: string; retryable?: boolean } | undefined): void {
    const p = conn.pending.get(id);
    if (!p) return; // a late answer after a timeout
    conn.pending.delete(id);
    clearTimeout(p.timer);
    conn.timeouts = 0;
    if (ok) p.resolve(value);
    else p.reject(new HarnessBridgeError(error?.code ?? 'error', error?.message ?? 'harness request failed', error?.retryable ?? false));
  }

  /** `blob.stat` / `blob.get` from the program: the host's blob store, read-only (`HarnessFactoryInit.blobs`). */
  private async answerBlob(conn: Conn, id: string, type: 'blob.stat' | 'blob.get', ref: string): Promise<void> {
    const ok = (value: unknown) => conn.link.send({ v: PROTOCOL_VERSION, type: 'result', id, ok: true, value });
    const fail = (code: string, message: string) => conn.link.send({ v: PROTOCOL_VERSION, type: 'result', id, ok: false, error: { code, message, retryable: false } });
    const blobs = this.opts.blobs;
    if (!blobs) return void fail('unsupported', 'the host has no blob store');
    try {
      const st = await blobs.stat(ref);
      if (type === 'blob.stat') return void ok(st ? { path: st.path, mime: st.mime, ...(st.name !== undefined ? { name: st.name } : {}), size: st.size } : null);
      if (!st) return void fail('not_found', `no blob ${ref} in the host's store`);
      if (st.size > BLOB_GET_MAX_BYTES) return void fail('too_large', `blob ${ref} is ${st.size} bytes, more than blob.get answers (${BLOB_GET_MAX_BYTES}); read the file at blob.stat's path`);
      const b = await blobs.get(ref);
      ok({ base64: Buffer.from(b.bytes).toString('base64'), mime: b.mime, ...(b.name !== undefined ? { name: b.name } : {}) });
    } catch (err) {
      fail('blob_error', errMsg(err));
    }
  }
}

/** One session of the program (`open`), on the connection it was opened on: it ends when that connection does. */
class BridgedSession implements HarnessSession {
  readonly queue = new AsyncQueue<HarnessEvent>();
  readonly events: AsyncIterable<HarnessEvent> = this.queue;
  native: string | undefined;
  // Present when the program's caps say it has them.
  readonly cancelQueued?: (inputIds: string[]) => Promise<void>;
  readonly inject?: (inputs: InputRecord[]) => Promise<void>;

  constructor(
    private readonly bridge: HarnessBridge,
    private readonly conn: Conn,
    readonly key: string,
    readonly generation: number,
    caps: HarnessCaps,
  ) {
    if (caps.cancelQueued) this.cancelQueued = async (inputIds) => void (await this.request('cancelQueued', { inputIds }));
    if (caps.injectWithoutTurn) this.inject = async (inputs) => void (await this.request('inject', { inputs }));
  }

  nativeId(): string | undefined {
    return this.native;
  }

  private request(type: string, body: Record<string, unknown>): Promise<unknown> {
    return this.bridge.call(this.conn, type, { sessionKey: this.key, ...body });
  }

  async startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void> {
    await this.request('startTurn', { turnId, inputs, ...(run ? { run } : {}) });
  }

  async steer(inputs: InputRecord[], expectedTurnId: string): Promise<SteerResult> {
    const v = await this.request('steer', { inputs, expectedTurnId });
    if (typeof v !== 'string' || !STEERED.has(v)) throw new HarnessBridgeError('bad_result', `steer answered ${preview(v)}`, false);
    return v as SteerResult;
  }

  async interrupt(turnId: string): Promise<void> {
    await this.request('interrupt', { turnId });
  }

  async respond(requestId: string, decision: Decision): Promise<void> {
    await this.request('respond', { requestId, decision });
  }

  /** The program closes the session; the events it sent before its answer come first, then the stream ends. */
  async close(reason: string): Promise<void> {
    if (this.queue.isClosed) return;
    try {
      if (!this.conn.gone) await this.request('close', { reason });
    } catch {
      // Gone or not answering: the session is over here either way.
    } finally {
      this.end();
    }
  }

  /** No more events from it. */
  end(): void {
    this.queue.close();
    if (this.conn.sessions.get(this.key) === this) this.conn.sessions.delete(this.key);
  }
}

/** The `open` frame's body: the open args as JSON (functions in `options` do not cross). */
function openBody(a: HarnessOpenArgs): Record<string, unknown> {
  return {
    sessionKey: a.sessionKey,
    generation: a.generation,
    cwd: a.cwd,
    ...(a.resume !== undefined ? { resume: a.resume } : {}),
    run: a.run,
    ...(a.mcp ? { mcp: a.mcp } : {}),
    ...(a.options ? { options: a.options } : {}),
    ...(a.env ? { env: a.env } : {}),
    ...(a.instructions !== undefined ? { instructions: a.instructions } : {}),
  };
}

/** The host's environment with `env` over it (`undefined` removes a variable). */
function childEnv(env: Readonly<Record<string, string | undefined>> | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

const preview = (v: unknown) => JSON.stringify(v)?.slice(0, 200);
