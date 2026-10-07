import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { FrameDecoder, PROTOCOL_VERSION, encodeFrame, type Origin, type Watch, type WatchDraft } from '@agents-io/protocol';
import type { AddWatchResult, RemoveWatchResult } from '@agents-io/session';
import type { Hub, Subscription } from '@agents-io/session';
import { parseClientFrame, type ClientCommand, type ClientFrame, type ServerFrame, type SessionInfo } from './frames.js';
import type { Outcome } from './gateway.js';

/** What the socket server needs from the gateway. */
export interface LocalHost {
  readonly hub: Hub;
  localOrigin(sessionKey: string): Origin;
  command(cmd: ClientCommand, origin: Origin): Promise<Outcome>;
  sessions(): SessionInfo[];
  addWatch(by: Origin, watch: WatchDraft): Promise<AddWatchResult>;
  removeWatch(by: Origin, id: string): Promise<RemoveWatchResult>;
  listWatches(sessionKey?: string): Watch[];
}

/**
 * The local client endpoint: a Unix socket (0600, in a 0700 directory) speaking
 * JSONL frames (frames.ts). Anyone who can open it acts as the configured local
 * principal, so it must stay private to this user.
 */
export class LocalServer {
  private server: Server | undefined;
  private readonly conns = new Set<Conn>();

  constructor(
    private readonly host: LocalHost,
    readonly path: string,
  ) {}

  async listen(): Promise<void> {
    // sun_path is 104 bytes on macOS, 108 on Linux.
    if (Buffer.byteLength(this.path) > 103) throw new Error(`socket path is too long for a Unix socket (${Buffer.byteLength(this.path)} bytes): ${this.path}; set socketPath`);
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (existsSync(this.path)) {
      if (await canConnect(this.path)) throw new Error(`another gateway is listening on ${this.path}`);
      unlinkSync(this.path); // stale socket from a crashed process
    }
    const server = createServer((socket) => {
      const c = new Conn(socket, this.host, () => this.conns.delete(c));
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
  }

  close(reason: string): void {
    for (const c of [...this.conns]) c.end(reason);
    this.server?.close();
    this.server = undefined;
    try {
      unlinkSync(this.path);
    } catch {
      /* already gone */
    }
  }
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

class Conn {
  private readonly subs = new Map<string, Subscription>();
  private readonly decoder: FrameDecoder;
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly host: LocalHost,
    private readonly onGone: () => void,
  ) {
    this.decoder = new FrameDecoder(() => this.send({ v: PROTOCOL_VERSION, type: 'result', id: '', ok: false, error: { code: 'bad_json', message: 'line is not JSON' } }));
    socket.on('data', (chunk) => {
      for (const raw of this.decoder.push(chunk)) void this.onFrame(raw);
    });
    socket.on('close', () => this.gone());
    socket.on('error', () => this.gone());
  }

  private send(f: ServerFrame): boolean {
    if (this.closed || this.socket.destroyed) return false;
    return this.socket.write(encodeFrame(f));
  }

  private result(id: string, o: Outcome): void {
    this.send(o.ok ? { v: PROTOCOL_VERSION, type: 'result', id, ok: true, value: o.value } : { v: PROTOCOL_VERSION, type: 'result', id, ok: false, error: { code: o.code, message: o.message } });
  }

  private async onFrame(raw: unknown): Promise<void> {
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
        const r = await this.host.addWatch(this.host.localOrigin(f.watch.target.sessionKey), f.watch);
        return this.result(f.id, r.ok ? { ok: true, value: r.watch } : { ok: false, code: r.code, message: r.message });
      }
      if (f.type === 'watch.remove') {
        const r = await this.host.removeWatch(this.host.localOrigin(''), f.watchId);
        return this.result(f.id, r.ok ? { ok: true, value: { removed: r.removed } } : { ok: false, code: r.code, message: r.message });
      }
    } catch (e) {
      return this.result(f.id, { ok: false, code: 'internal', message: (e as Error).message });
    }
    const cmd = f.command;
    try {
      if (cmd.type === 'subscribe') return this.result(f.id, this.subscribe(cmd));
      if (cmd.type === 'unsubscribe') {
        this.subs.get(cmd.sessionKey)?.close();
        this.subs.delete(cmd.sessionKey);
        return this.result(f.id, { ok: true, value: {} });
      }
      this.result(f.id, await this.host.command(cmd, this.host.localOrigin(cmd.sessionKey)));
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
        if (this.closed || this.socket.destroyed) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            this.socket.off('drain', done);
            this.socket.off('close', done);
            resolve();
          };
          this.socket.on('drain', done);
          this.socket.on('close', done);
        });
      }
    }
  }

  end(reason: string): void {
    for (const key of this.subs.keys()) this.send({ v: PROTOCOL_VERSION, type: 'closed', sessionKey: key, reason });
    this.socket.end();
    this.gone();
  }

  private gone(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.subs.values()) s.close();
    this.subs.clear();
    this.onGone();
  }
}
