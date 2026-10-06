import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RequestId } from './generated/RequestId.js';

/**
 * A line-oriented duplex to an app-server: one JSON message per line. The stdio
 * transport spawns `codex app-server`; tests plug in a scripted peer.
 */
export interface Transport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  /** Called once when the peer goes away (process exit, stream end). */
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

export interface SpawnOptions {
  bin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Spawns `codex app-server` and speaks JSONL over its stdio. stderr is kept as a short tail for diagnostics. */
export function spawnTransport(opts: SpawnOptions): Transport & { stderrTail(): string } {
  const child = spawn(opts.bin, opts.args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env, cwd: opts.cwd });
  const closeCbs: ((reason: string) => void)[] = [];
  let closed: string | undefined;
  let tail = '';
  const fire = (reason: string) => {
    if (closed !== undefined) return;
    closed = reason;
    for (const cb of closeCbs) cb(reason);
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    tail = (tail + d).slice(-4000);
  });
  child.on('error', (err) => fire(`spawn ${opts.bin} failed: ${err.message}`));
  child.on('exit', (code, signal) => fire(`codex app-server exited (${signal ?? `code ${code}`})`));
  child.stdin.on('error', () => {
    /* surfaced through exit */
  });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return {
    write(line) {
      if (closed === undefined) child.stdin.write(line + '\n');
    },
    onLine(cb) {
      rl.on('line', cb);
    },
    onClose(cb) {
      if (closed !== undefined) cb(closed);
      else closeCbs.push(cb);
    },
    close() {
      if (closed !== undefined) return;
      child.stdin.end();
      const t = setTimeout(() => child.kill('SIGTERM'), 2000);
      t.unref();
      child.once('exit', () => clearTimeout(t));
    },
    stderrTail: () => tail,
  };
}

/** A JSON-RPC error returned by the app-server. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly method?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** The connection closed before a response arrived; the request's outcome is unknown. */
export class RpcClosedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RpcClosedError';
  }
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type ServerRequestHandler = (id: RequestId, method: string, params: unknown) => void;

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Minimal JSON-RPC 2.0 peer as codex app-server speaks it: no `jsonrpc` header on
 * the wire, client request ids are ours, server requests (approvals) carry the
 * server's ids and expect a response.
 */
export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationHandlers: NotificationHandler[] = [];
  private requestHandler: ServerRequestHandler | undefined;
  private closeHandlers: ((reason: string) => void)[] = [];
  private closedReason: string | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly defaultTimeoutMs = 120_000,
  ) {
    transport.onLine((line) => this.onLine(line));
    transport.onClose((reason) => this.onClosed(reason));
  }

  get closed(): string | undefined {
    return this.closedReason;
  }

  onNotification(h: NotificationHandler): void {
    this.notificationHandlers.push(h);
  }

  onServerRequest(h: ServerRequestHandler): void {
    this.requestHandler = h;
  }

  onClose(h: (reason: string) => void): void {
    if (this.closedReason !== undefined) h(this.closedReason);
    else this.closeHandlers.push(h);
  }

  request<R = unknown>(method: string, params: unknown, timeoutMs = this.defaultTimeoutMs): Promise<R> {
    if (this.closedReason !== undefined) return Promise.reject(new RpcClosedError(this.closedReason));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const p: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcClosedError(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        p.timer.unref();
      }
      this.pending.set(id, p);
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  close(): void {
    this.transport.close();
  }

  private send(msg: object): void {
    this.transport.write(JSON.stringify(msg));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours to interpret (e.g. stray log line)
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      if (this.requestHandler) this.requestHandler(msg.id, msg.method, msg.params);
      else this.respondError(msg.id, -32601, `unsupported server request: ${msg.method}`);
      return;
    }
    if (msg.method !== undefined) {
      for (const h of this.notificationHandlers) h(msg.method, msg.params);
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data, p.method));
    else p.resolve(msg.result);
  }

  private onClosed(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcClosedError(reason));
    }
    this.pending.clear();
    for (const h of this.closeHandlers.splice(0)) h(reason);
  }
}
