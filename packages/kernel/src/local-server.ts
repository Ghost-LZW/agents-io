import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync, type Stats } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FrameDecoder, HOST_REQUEST_FRAME_TYPES, HostRequestFrame, PROTOCOL_VERSION, check, encodeFrame, errors, type ModuleConnection, type Origin, type ResultFrame, type Topic, type TopicSwitchFrame, type Watch, type WatchDraft } from '@agents-io/protocol';
import type { AddWatchResult, RemoveWatchResult } from '@agents-io/session';
import type { Hub, Subscription } from '@agents-io/session';
import type { OpFrame, OpOutcome } from './client-ops.js';
import { parseClientFrame, type ClientCommand, type ClientFrame, type ServerFrame, type SessionInfo } from './frames.js';
import type { Outcome } from './gateway.js';

/** One socket connection, as the host protocol sees it. */
export interface Peer {
  readonly id: string;
  /**
   * Set once `host.hello` succeeded: the connection's host name and the origin its client frames carry.
   * `backend` (PB-1): the hello was made with a backend's key, not the host token. Such a connection
   * speaks only the host frames the backend whitelist names, and no client frame.
   */
  auth?: { name: string; origin: (sessionKey: string) => Origin; backend?: { id: string; keyId: string } };
  /** Write a frame; false when the connection is gone. */
  send(frame: Record<string, unknown>): boolean;
  /** Send a request frame (an `id` is added) and wait for the peer's `result`; a closed connection or the timeout answers `ok: false`. */
  request(frame: Record<string, unknown>, timeoutMs?: number): Promise<ResultFrame>;
  /** Aborted when the connection is gone. */
  readonly signal: AbortSignal;
  /** Close the connection (a host taken over); reports it gone. */
  end?(reason: string): void;
  /**
   * Resolves once what was sent is written out, or the connection is gone; at once when nothing is
   * held back. For answers that are large and asked for one after another (`blob.get`, PR-2).
   */
  flushed?(): Promise<void>;
}

/** Host-protocol frames (docs/HOSTS.md §4), handled by the daemon. */
export interface HostFrames {
  handle(peer: Peer, frame: HostRequestFrame): Promise<Outcome>;
  gone(peer: Peer): void;
  /**
   * A connection admitted with backend `id`'s key before any `host.hello` (the console's `/ws`):
   * it is that backend's from now on, so its key going away closes it too (PB-3).
   */
  attachBackend?(peer: Peer, id: string): void;
}

/** What the socket server needs from the gateway. */
export interface LocalHost {
  readonly hub: Hub;
  localOrigin(sessionKey: string): Origin;
  command(cmd: ClientCommand, origin: Origin): Promise<Outcome>;
  sessions(): SessionInfo[];
  addWatch(by: Origin, watch: WatchDraft): Promise<AddWatchResult>;
  removeWatch(by: Origin, id: string): Promise<RemoveWatchResult>;
  listWatches(sessionKey?: string): Watch[];
  /** Host protocol; without it host frames are answered `unsupported`. */
  readonly hostFrames?: HostFrames;
  /** `tui.attach` (decision 15); without it the frame is answered `unsupported`. */
  tuiAttach?(sessionKey: string | undefined): Promise<Outcome>;
  /** Topic frames; without it they are answered `unsupported`. */
  readonly topicFrames?: {
    topicList(f: { conversation?: string; sessionKey?: string }): Topic[];
    topicSwitch(f: TopicSwitchFrame, origin: Origin): Promise<Outcome>;
  };
  /**
   * A frame with `opId` (feature `client.opId`, INVARIANTS PR-3): acts once per (principal, opId),
   * a retry gets the first answer. Without it `opId` is ignored like any unknown field.
   */
  clientOp?(f: OpFrame, origin: Origin): Promise<OpOutcome>;
  /**
   * `module.connect`: hand the connection to the running feature module `module`
   * (`ModuleInstance.connect`); accepted, every later value on it is the module's. Without it the
   * frame is answered `unsupported`.
   */
  moduleConnect?(module: string, hello: unknown, conn: ModuleConnection): Promise<Outcome>;
}

const HOST_TYPES = new Set<string>(HOST_REQUEST_FRAME_TYPES);

/**
 * The local endpoint: a Unix socket (0600, in a private directory: one it
 * creates 0700, or an existing one that is already ours and 0700) speaking
 * JSONL frames: client frames (frames.ts) and host frames (protocol host.ts).
 * Anyone who can open it acts as the configured local principal, so it must
 * stay private to this user; host frames additionally need `host.hello` with
 * the daemon's token, after which client frames carry the host's origin.
 */
export class LocalServer {
  private server: Server | undefined;
  private readonly conns = new Set<FrameConn>();
  /** Inode of the socket this server bound (close() removes only that). */
  private ino: number | undefined;

  constructor(
    private readonly host: LocalHost,
    readonly path: string,
  ) {}

  async listen(): Promise<void> {
    // sun_path is 104 bytes on macOS, 108 on Linux.
    if (Buffer.byteLength(this.path) > 103) throw new Error(`socket path is too long for a Unix socket (${Buffer.byteLength(this.path)} bytes): ${this.path}; set socketPath`);
    const dir = dirname(this.path);
    // Only a directory this server creates is made 0700; an existing one (a project dir, $HOME)
    // is never chmodded, but it must already be private, or anyone could reach the socket.
    if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(dir, 0o700);
    else assertPrivate(statSync(dir), `socket directory ${dir}`);
    const old = lstatOrUndefined(this.path);
    if (old) {
      if (!old.isSocket()) throw new Error(`${this.path} exists and is not a socket; refusing to remove it (set socketPath to a dedicated path)`);
      if (await canConnect(this.path)) throw new Error(`another gateway is listening on ${this.path}`);
      assertOwned(old, `stale socket ${this.path}`);
      unlinkSync(this.path); // stale socket from a crashed process
    }
    const server = createServer((socket) => {
      const c = new FrameConn(socketTransport(socket), this.host, () => this.conns.delete(c));
      const decoder = new FrameDecoder(() => c.badLine('line is not JSON'));
      socket.on('data', (chunk: Buffer) => {
        // Line by line (a newline byte is never inside a UTF-8 character): a bad line is answered
        // in its place, after the lines before it (a `module.connect` among them takes what follows).
        let start = 0;
        for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
          for (const raw of decoder.push(chunk.subarray(start, nl + 1))) c.receive(raw);
          start = nl + 1;
        }
        if (start < chunk.length) for (const raw of decoder.push(chunk.subarray(start))) c.receive(raw);
      });
      socket.on('close', () => c.drop());
      socket.on('error', () => c.drop());
      this.conns.add(c);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(this.path, 0o600);
    this.ino = lstatSync(this.path).ino;
  }

  close(reason: string): void {
    for (const c of [...this.conns]) c.end(reason);
    this.server?.close();
    this.server = undefined;
    // Only our own socket: the path may have been replaced since.
    const st = lstatOrUndefined(this.path);
    if (st?.isSocket() && st.ino === this.ino) unlinkSync(this.path);
    this.ino = undefined;
  }
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function assertOwned(st: Stats, what: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`${what} is owned by uid ${st.uid}, not ${uid}`);
}

/** Ours and not reachable by group/others. */
function assertPrivate(st: Stats, what: string): void {
  assertOwned(st, what);
  if (st.mode & 0o077) throw new Error(`${what} is accessible to other users (mode ${(st.mode & 0o777).toString(8)}); chmod 700 it or use a dedicated directory`);
}

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

/**
 * How a connection's frames travel: a Unix socket (JSONL) or a WebSocket (one
 * frame per text message). The connection decodes nothing itself; its owner
 * hands it decoded frames (`FrameConn.receive`) and reports the end (`drop`).
 */
export interface FrameTransport {
  /** Write one frame; false when it was not written (gone) or the buffer is full (then `drained` resolves). */
  write(frame: Record<string, unknown>): boolean;
  /** Resolves when writing may continue, or the transport is gone. */
  drained(): Promise<void>;
  /**
   * Resolves once every frame written so far has left this process (or the transport is gone); at
   * once when nothing is held. For a transport whose `write` reports the buffer full only far above
   * one large answer (`/ws`); without it a connection waits on `drained` after a `write` that said so.
   */
  flushed?(): Promise<void>;
  /** True once the transport cannot write any more. */
  readonly gone: boolean;
  /** Close after flushing. */
  end(): void;
}

/** How long an ended Unix-socket connection may flush before it is destroyed (as /ws terminates). */
const SOCKET_CLOSE_GRACE_MS = 1000;

function socketTransport(socket: Socket): FrameTransport {
  return {
    write: (f) => !socket.destroyed && socket.write(encodeFrame(f)),
    drained: () =>
      new Promise<void>((resolve) => {
        if (socket.destroyed) return resolve();
        const done = () => {
          socket.off('drain', done);
          socket.off('close', done);
          resolve();
        };
        socket.on('drain', done);
        socket.on('close', done);
      }),
    get gone() {
      return socket.destroyed;
    },
    end: () => {
      socket.end();
      // A half-closed socket can still be read: destroy it once the last frames had time to flush.
      setTimeout(() => socket.destroy(), SOCKET_CLOSE_GRACE_MS).unref();
    },
  };
}

export interface FrameConnOptions {
  /** Origin of client frames before `host.hello` (default: the host's local origin). */
  origin?: (sessionKey: string) => Origin;
  /**
   * The connection was admitted with this backend's key (the console's `/ws`, PB-1): it sends no
   * client frame, before `host.hello` or after it, and its `host.hello` must be that backend's key.
   */
  backend?: string;
}

let connSeq = 0;

/**
 * One connection speaking the client frames and the host frames over any
 * transport: the Unix socket here, `/ws` of the console server.
 */
export class FrameConn implements Peer {
  readonly id = `conn_${++connSeq}`;
  auth?: Peer['auth'];
  private readonly subs = new Map<string, Subscription>();
  private readonly ac = new AbortController();
  /** Requests this side sent (inbound pushes, callouts), by id. */
  private readonly pending = new Map<string, (r: ResultFrame) => void>();
  private closed = false;
  /** A write did not go out at once: resolves when the transport drained (or is gone). */
  private backlog: Promise<void> | undefined;
  /** Set once a feature module took the connection (`module.connect`): every value from the far end is its. */
  private taken: ((value: unknown) => void) | undefined;
  /** While a `module.connect` is being answered: what came meanwhile, in order (the module's if it takes the connection, else frames). */
  private connecting: unknown[] | undefined;

  constructor(
    private readonly transport: FrameTransport,
    private readonly host: LocalHost,
    private readonly onGone: () => void,
    private readonly opts: FrameConnOptions = {},
  ) {}

  /** One decoded frame from the peer. */
  receive(raw: unknown): void {
    // A connection ended (replaced by a host takeover, or closing) acts on nothing more:
    // a half-closed socket or a /ws in its close grace can still deliver frames.
    if (this.closed) return;
    if (this.taken) return this.taken(raw);
    if (this.connecting) return void this.connecting.push(raw);
    void this.onFrame(raw);
  }

  /** A line that is not JSON: answered `bad_json`, unless a module took the connection (its protocol has no such frame: dropped). */
  badLine(message: string): void {
    if (this.taken || this.connecting) return;
    this.send({ v: PROTOCOL_VERSION, type: 'result', id: '', ok: false, error: { code: 'bad_json', message } });
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  send(f: ServerFrame | Record<string, unknown>): boolean {
    if (this.closed || this.transport.gone) return false;
    const written = this.transport.write(f);
    if (!written && !this.transport.gone && !this.backlog) {
      const clear = () => {
        this.backlog = undefined;
      };
      this.backlog = this.transport.drained().then(clear, clear);
    }
    return written;
  }

  flushed(): Promise<void> {
    if (this.closed || this.transport.gone) return Promise.resolve();
    return this.transport.flushed?.() ?? this.backlog ?? Promise.resolve();
  }

  request(frame: Record<string, unknown>, timeoutMs = 60_000): Promise<ResultFrame> {
    const id = `d_${randomUUID()}`;
    const fail = (code: string, message: string): ResultFrame => ({ v: PROTOCOL_VERSION, type: 'result', id, ok: false, error: { code, message } });
    if (this.closed) return Promise.resolve(fail('disconnected', 'connection closed'));
    return new Promise((resolve) => {
      const t = setTimeout(() => done(fail('timeout', `no answer within ${timeoutMs} ms`)), timeoutMs);
      t.unref?.();
      const done = (r: ResultFrame) => {
        clearTimeout(t);
        this.pending.delete(id);
        resolve(r);
      };
      this.pending.set(id, done);
      if (!this.send({ v: PROTOCOL_VERSION, ...frame, id })) done(fail('disconnected', 'connection closed'));
    });
  }

  private result(id: string, o: Outcome & { opId?: string; seq?: number; replayed?: true }): void {
    // Only an answer to a frame whose opId was honoured says more than a plain result (client.opId).
    const op = { ...(o.opId !== undefined ? { opId: o.opId } : {}), ...(o.seq !== undefined ? { seq: o.seq } : {}), ...(o.replayed ? { replayed: true } : {}) };
    this.send(o.ok ? { v: PROTOCOL_VERSION, type: 'result', id, ok: true, value: o.value, ...op } : { v: PROTOCOL_VERSION, type: 'result', id, ok: false, error: { code: o.code, message: o.message }, ...op });
  }

  /** The frame, when its `opId` is one the server honours (input and interrupt commands, topic.switch, watch.add). */
  private opFrame(f: ClientFrame): OpFrame | undefined {
    if (!this.host.clientOp || !('opId' in f) || f.opId === undefined) return undefined;
    if (f.type === 'watch.add' || f.type === 'topic.switch') return f as OpFrame;
    if (f.type === 'command' && (f.command.type === 'input' || f.command.type === 'interrupt')) return f as OpFrame;
    return undefined;
  }

  private async onOp(f: OpFrame): Promise<void> {
    const key = f.type === 'command' ? f.command.sessionKey : f.type === 'watch.add' ? f.watch.target.sessionKey : f.conversation;
    try {
      this.result(f.id, { ...(await this.host.clientOp!(f, this.origin(key))), opId: f.opId });
    } catch (e) {
      this.result(f.id, { ok: false, code: 'internal', message: (e as Error).message, opId: f.opId });
    }
  }

  private async onFrame(raw: unknown): Promise<void> {
    const type = raw && typeof raw === 'object' ? (raw as { type?: unknown }).type : undefined;
    if (type === 'result') {
      // The answer to a request this side sent (an inbound push, a callout).
      const id = (raw as { id?: unknown }).id;
      if (typeof id === 'string') this.pending.get(id)?.(raw as ResultFrame);
      return;
    }
    if (typeof type === 'string' && HOST_TYPES.has(type)) return this.onHostFrame(raw);
    if (this.opts.backend !== undefined || this.auth?.backend) {
      // PB-1: a backend's key opens no client frame (input, subscribe, sessions, watches, topics, tui.attach).
      // Before hello too: a `/ws` connection admitted with a key would otherwise speak as the console's owner.
      const id = (raw as { id?: unknown }).id;
      if (typeof id === 'string') this.result(id, { ok: false, code: 'forbidden', message: 'a backend key cannot send client frames' });
      return;
    }
    const p = parseClientFrame(raw);
    if (!p.ok) {
      // Unknown frame types without an id are ignored, as on the adapter bridges.
      if (p.id !== undefined) this.result(p.id, { ok: false, code: 'invalid_frame', message: p.error });
      return;
    }
    const f: ClientFrame = p.frame;
    if (f.type === 'sessions') return this.result(f.id, { ok: true, value: this.host.sessions() });
    if (f.type === 'module.connect') return this.onModuleConnect(f);
    const op = this.opFrame(f);
    if (op) return this.onOp(op);
    try {
      // The local client is the owner: its origin goes to Policy.watch like any other creator's.
      if (f.type === 'watch.list') return this.result(f.id, { ok: true, value: this.host.listWatches(f.sessionKey) });
      if (f.type === 'watch.add') {
        const r = await this.host.addWatch(this.origin(f.watch.target.sessionKey), f.watch);
        return this.result(f.id, r.ok ? { ok: true, value: r.watch } : { ok: false, code: r.code, message: r.message });
      }
      if (f.type === 'watch.remove') {
        const r = await this.host.removeWatch(this.origin(''), f.watchId);
        return this.result(f.id, r.ok ? { ok: true, value: { removed: r.removed } } : { ok: false, code: r.code, message: r.message });
      }
    } catch (e) {
      return this.result(f.id, { ok: false, code: 'internal', message: (e as Error).message });
    }
    if (f.type === 'tui.attach') {
      // The owner at this machine only: a host connection (token) does not open terminals.
      if (this.auth || !(this.origin('').principal?.labels ?? []).includes('owner')) return this.result(f.id, { ok: false, code: 'forbidden', message: 'tui.attach is for the local owner' });
      if (!this.host.tuiAttach) return this.result(f.id, { ok: false, code: 'unsupported', message: 'tui.attach is not supported by this server' });
      try {
        return this.result(f.id, await this.host.tuiAttach(f.sessionKey));
      } catch (e) {
        return this.result(f.id, { ok: false, code: 'internal', message: (e as Error).message });
      }
    }
    // Topics (decision 6): a switch is checked by Policy.control against this connection's origin.
    if (f.type === 'topic.list' || f.type === 'topic.switch') {
      const t = this.host.topicFrames;
      if (!t) return this.result(f.id, { ok: false, code: 'unsupported', message: `${f.type} is not supported by this server` });
      try {
        if (f.type === 'topic.list') return this.result(f.id, { ok: true, value: t.topicList(f) });
        return this.result(f.id, await t.topicSwitch(f, this.origin(f.conversation)));
      } catch (e) {
        return this.result(f.id, { ok: false, code: 'internal', message: (e as Error).message });
      }
    }
    const cmd = f.command;
    try {
      if (cmd.type === 'subscribe') return this.result(f.id, this.subscribe(cmd));
      if (cmd.type === 'unsubscribe') {
        this.subs.get(cmd.sessionKey)?.close();
        this.subs.delete(cmd.sessionKey);
        return this.result(f.id, { ok: true, value: {} });
      }
      this.result(f.id, await this.host.command(cmd, this.origin(cmd.sessionKey)));
    } catch (e) {
      this.result(f.id, { ok: false, code: 'internal', message: (e as Error).message });
    }
  }

  /**
   * `module.connect`: the running module answers; accepted, the connection is its from here on (its
   * values both ways, no frames). What the module writes before the answer is sent after it; what the
   * far end writes before it is the module's once it took the connection, else read as frames.
   */
  private async onModuleConnect(f: Extract<ClientFrame, { type: 'module.connect' }>): Promise<void> {
    if (!this.host.moduleConnect) return this.result(f.id, { ok: false, code: 'unsupported', message: 'module.connect is not supported by this server' });
    if (this.auth || this.subs.size || this.connecting) return this.result(f.id, { ok: false, code: 'forbidden', message: 'module.connect is for a connection that has not said host.hello, has no subscription and is not connecting already' });
    const early: unknown[] = [];
    this.connecting = early;
    let listener: ((value: unknown) => void) | undefined;
    const kept: unknown[] = [];
    /** Writes before the answer went out (the result frame comes first). */
    let held: unknown[] | undefined = [];
    const conn: ModuleConnection = {
      send: (v) => {
        if (this.closed || this.transport.gone) return false;
        if (held) return held.push(v), true;
        return this.transport.write(v as Record<string, unknown>);
      },
      drained: () => (this.closed || this.transport.gone ? Promise.resolve() : this.transport.drained()),
      onValue: (fn) => {
        listener = fn;
        for (const v of kept.splice(0)) fn(v);
      },
      signal: this.ac.signal,
      close: () => this.end('closed by the module'),
    };
    let o: Outcome;
    try {
      o = await this.host.moduleConnect(f.module, f.hello, conn);
    } catch (e) {
      o = { ok: false, code: 'internal', message: (e as Error).message };
    }
    this.connecting = undefined;
    if (o.ok && !this.closed) {
      this.taken = (v) => (listener ? listener(v) : void kept.push(v));
      this.result(f.id, o);
      for (const v of held) this.transport.write(v as Record<string, unknown>);
      held = undefined;
      for (const v of early) this.taken(v);
      return;
    }
    held = undefined;
    this.result(f.id, o);
    for (const v of early) void this.onFrame(v);
  }

  private subscribe(cmd: Extract<ClientCommand, { type: 'subscribe' }>): Outcome {
    this.subs.get(cmd.sessionKey)?.close();
    const sub = this.host.hub.subscribe({
      sessionKey: cmd.sessionKey,
      tier: cmd.tier,
      ...(cmd.fromSeq !== undefined ? { fromSeq: cmd.fromSeq } : {}),
      ...(cmd.filter ? { filter: cmd.filter } : {}),
    });
    this.subs.set(cmd.sessionKey, sub);
    // The result is written before the pump starts, so it always precedes the replay.
    queueMicrotask(() => void this.pump(sub));
    return { ok: true, value: { head: this.host.hub.log.head(cmd.sessionKey) } };
  }

  private async pump(sub: Subscription): Promise<void> {
    for await (const event of sub) {
      if (!this.send({ v: PROTOCOL_VERSION, type: 'event', event })) {
        if (this.closed || this.transport.gone) return;
        await this.transport.drained();
      }
    }
  }

  end(reason: string): void {
    for (const key of this.subs.keys()) this.send({ v: PROTOCOL_VERSION, type: 'closed', sessionKey: key, reason });
    this.transport.end();
    this.drop();
  }

  /** Origin of this connection's client frames: the host's once it said hello, else the connection's own (default the local principal). */
  private origin(sessionKey: string): Origin {
    if (this.auth) return this.auth.origin(sessionKey);
    return this.opts.origin ? this.opts.origin(sessionKey) : this.host.localOrigin(sessionKey);
  }

  private async onHostFrame(raw: unknown): Promise<void> {
    const id = typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : undefined;
    if (!check(HostRequestFrame, raw)) {
      if (id !== undefined) this.result(id, { ok: false, code: 'invalid_frame', message: errors(HostRequestFrame, raw).slice(0, 3).join('; ') || 'invalid frame' });
      return;
    }
    const f = raw as HostRequestFrame;
    const hf = this.host.hostFrames;
    if (!hf) return this.result(f.id, { ok: false, code: 'unsupported', message: 'this server does not speak the host protocol' });
    if (f.type !== 'host.hello' && !this.auth) return this.result(f.id, { ok: false, code: 'unauthorized', message: `${f.type} needs host.hello with the daemon's token first` });
    try {
      this.result(f.id, await hf.handle(this, f));
    } catch (e) {
      this.result(f.id, { ok: false, code: 'internal', message: (e as Error).message });
    }
  }

  /** The transport is gone: end subscriptions, fail pending requests, tell the host side. */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    delete this.auth;
    this.ac.abort();
    for (const s of this.subs.values()) s.close();
    this.subs.clear();
    for (const [id, r] of [...this.pending]) r({ v: PROTOCOL_VERSION, type: 'result', id, ok: false, error: { code: 'disconnected', message: 'connection closed' } });
    this.pending.clear();
    this.host.hostFrames?.gone(this);
    this.onGone();
  }
}
