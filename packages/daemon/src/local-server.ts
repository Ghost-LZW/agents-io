import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync, type Stats } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FrameDecoder, HOST_REQUEST_FRAME_TYPES, HostRequestFrame, PROTOCOL_VERSION, check, encodeFrame, errors, type Origin, type ResultFrame, type Watch, type WatchDraft } from '@agents-io/protocol';
import type { AddWatchResult, RemoveWatchResult } from '@agents-io/session';
import type { Hub, Subscription } from '@agents-io/session';
import { parseClientFrame, type ClientCommand, type ClientFrame, type ServerFrame, type SessionInfo } from './frames.js';
import type { Outcome } from './gateway.js';

/** One socket connection, as the host protocol sees it. */
export interface Peer {
  readonly id: string;
  /** Set once `host.hello` succeeded: the connection's host name and the origin its client frames carry. */
  auth?: { name: string; origin: (sessionKey: string) => Origin };
  /** Write a frame; false when the connection is gone. */
  send(frame: Record<string, unknown>): boolean;
  /** Send a request frame (an `id` is added) and wait for the peer's `result`; a closed connection or the timeout answers `ok: false`. */
  request(frame: Record<string, unknown>, timeoutMs?: number): Promise<ResultFrame>;
  /** Aborted when the connection is gone. */
  readonly signal: AbortSignal;
}

/** Host-protocol frames (docs/HOSTS.md §4), handled by the daemon. */
export interface HostFrames {
  handle(peer: Peer, frame: HostRequestFrame): Promise<Outcome>;
  gone(peer: Peer): void;
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
      const decoder = new FrameDecoder(() => c.send({ v: PROTOCOL_VERSION, type: 'result', id: '', ok: false, error: { code: 'bad_json', message: 'line is not JSON' } }));
      socket.on('data', (chunk) => {
        for (const raw of decoder.push(chunk)) c.receive(raw);
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
  /** True once the transport cannot write any more. */
  readonly gone: boolean;
  /** Close after flushing. */
  end(): void;
}

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
    end: () => socket.end(),
  };
}

export interface FrameConnOptions {
  /** Origin of client frames before `host.hello` (default: the host's local origin). */
  origin?: (sessionKey: string) => Origin;
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

  constructor(
    private readonly transport: FrameTransport,
    private readonly host: LocalHost,
    private readonly onGone: () => void,
    private readonly opts: FrameConnOptions = {},
  ) {}

  /** One decoded frame from the peer. */
  receive(raw: unknown): void {
    void this.onFrame(raw);
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  send(f: ServerFrame | Record<string, unknown>): boolean {
    if (this.closed || this.transport.gone) return false;
    return this.transport.write(f);
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

  private result(id: string, o: Outcome): void {
    this.send(o.ok ? { v: PROTOCOL_VERSION, type: 'result', id, ok: true, value: o.value } : { v: PROTOCOL_VERSION, type: 'result', id, ok: false, error: { code: o.code, message: o.message } });
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
    const p = parseClientFrame(raw);
    if (!p.ok) {
      // Unknown frame types without an id are ignored, as on the adapter bridges.
      if (p.id !== undefined) this.result(p.id, { ok: false, code: 'invalid_frame', message: p.error });
      return;
    }
    const f: ClientFrame = p.frame;
    if (f.type === 'sessions') return this.result(f.id, { ok: true, value: this.host.sessions() });
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
    // Topics (decision 6) are in the protocol; this daemon does not keep a topic table yet.
    if (f.type === 'topic.list' || f.type === 'topic.switch') return this.result(f.id, { ok: false, code: 'unsupported', message: `${f.type} is not supported by this daemon yet` });
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
    this.ac.abort();
    for (const s of this.subs.values()) s.close();
    this.subs.clear();
    for (const [id, r] of [...this.pending]) r({ v: PROTOCOL_VERSION, type: 'result', id, ok: false, error: { code: 'disconnected', message: 'connection closed' } });
    this.pending.clear();
    this.host.hostFrames?.gone(this);
    this.onGone();
  }
}
