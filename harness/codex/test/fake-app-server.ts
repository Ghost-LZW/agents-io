import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Transport } from '../src/rpc.js';

export class FakeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Handler = (params: any, fake: FakeAppServer) => unknown;

interface Msg {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

interface Conn {
  send(line: string): void;
  /** Server side drop. */
  drop(reason: string): void;
}

/**
 * A scripted codex app-server peer. Tests register method handlers, push
 * notifications and server requests, and inspect what clients sent. Clients
 * connect in-process (`transport`) or, like the real server's `unix://`
 * listener, as WebSocket over a Unix socket (`listen`). Notifications and
 * server requests go to every connection; `thread/resume` replays pending
 * server requests to the resuming connection, as Codex does.
 */
export class FakeAppServer {
  /** Every message a client wrote, parsed. */
  readonly received: Msg[] = [];
  readonly handlers: Record<string, Handler> = {};
  userAgent = 'agents_io/0.160.1 (Mac OS 26.5.0; arm64) test';
  spawned = 0;
  closedByClient = 0;
  connections = 0;
  private conns = new Set<Conn>();
  private nextServerId = 0;
  private serverRequests = new Map<number, { msg: Msg; resolve: (m: Msg) => void }>();
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private threadSeq = 0;
  private turnSeq = 0;
  private http: Server | undefined;
  private wss: WebSocketServer | undefined;
  /** Active codex turn per thread. */
  readonly activeTurn = new Map<string, string>();
  /** thread → status reported by thread/resume. */
  readonly threadStatus = new Map<string, unknown>();
  /** Finished turns, for thread/turns/list. */
  readonly turns = new Map<string, any[]>();

  constructor() {
    this.handlers['initialize'] = () => ({ userAgent: this.userAgent, codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' });
    this.handlers['thread/start'] = (p) => this.threadResponse(`thr-${++this.threadSeq}`, p);
    this.handlers['thread/resume'] = (p) => this.threadResponse(p.threadId, p);
    this.handlers['thread/unsubscribe'] = () => ({ status: 'unsubscribed' });
    this.handlers['thread/turns/list'] = (p) => ({ data: [...(this.turns.get(p.threadId) ?? [])].reverse(), nextCursor: null, backwardsCursor: null });
    this.handlers['turn/start'] = (p) => {
      const id = `turn-${++this.turnSeq}`;
      this.activeTurn.set(p.threadId, id);
      queueMicrotask(() => {
        this.notify('turn/started', { threadId: p.threadId, turn: turn(id, 'inProgress') });
        this.onTurnStart?.(p, id);
      });
      return { turn: turn(id, 'inProgress') };
    };
    this.handlers['turn/steer'] = (p) => {
      const active = this.activeTurn.get(p.threadId);
      if (!active) throw new FakeRpcError(-32600, 'no active turn to steer');
      if (active !== p.expectedTurnId) throw new FakeRpcError(-32600, `expected active turn id \`${p.expectedTurnId}\` but found \`${active}\``);
      queueMicrotask(() => this.onSteer?.(p, active));
      return { turnId: active };
    };
    this.handlers['turn/interrupt'] = (p) => {
      if (this.activeTurn.get(p.threadId) !== p.turnId) throw new FakeRpcError(-32600, 'no active turn to interrupt');
      queueMicrotask(() => this.completeTurn(p.threadId, p.turnId, 'interrupted'));
      return {};
    };
  }

  /** Called after turn/started is sent for a new turn. */
  onTurnStart?: (params: any, turnId: string) => void;
  onSteer?: (params: any, turnId: string) => void;

  /** In-process connection. Closing it (either side) ends this connection only. */
  transport = (): Transport => {
    this.spawned++;
    let lineCb: ((l: string) => void) | undefined;
    const closeCbs: ((r: string) => void)[] = [];
    const conn: Conn = {
      send: (line) => lineCb?.(line),
      drop: (reason) => {
        this.conns.delete(conn);
        for (const cb of closeCbs.splice(0)) cb(reason);
      },
    };
    this.addConn(conn);
    return {
      write: (line) => this.fromClient(JSON.parse(line), conn),
      onLine: (cb) => {
        lineCb = cb;
      },
      onClose: (cb) => {
        closeCbs.push(cb);
      },
      close: () => {
        this.closedByClient++;
        conn.drop('closed by client');
      },
    };
  };

  /** Accept WebSocket-over-Unix-socket connections at `path`, like `codex app-server --listen unix://PATH`. */
  listen(path: string): Promise<void> {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http, perMessageDeflate: false });
    this.wss.on('connection', (ws: WebSocket) => {
      const conn: Conn = {
        send: (line) => ws.send(line),
        drop: () => ws.terminate(),
      };
      this.addConn(conn);
      ws.on('message', (d) => this.fromClient(JSON.parse(d.toString()), conn));
      ws.on('close', () => {
        if (this.conns.delete(conn)) this.closedByClient++;
      });
    });
    return new Promise((resolve) => this.http!.listen(path, resolve));
  }

  async stopListening(): Promise<void> {
    this.dropClients();
    await new Promise<void>((r) => this.wss?.close(() => r()) ?? r());
    await new Promise<void>((r) => this.http?.close(() => r()) ?? r());
  }

  /** Drop every client connection; the "server" (threads, turns, pending requests) lives on. */
  dropClients(reason = 'dropped'): void {
    for (const c of [...this.conns]) {
      this.conns.delete(c);
      c.drop(reason);
    }
  }

  notify(method: string, params: unknown): void {
    this.broadcast({ method, params });
  }

  /** Server→client request to every connection; resolves with the first response. */
  request(method: string, params: unknown): Promise<Msg> {
    const id = this.nextServerId++;
    const msg = { id, method, params };
    return new Promise((resolve) => {
      this.serverRequests.set(id, { msg, resolve });
      this.broadcast(msg);
    });
  }

  /** Resolves with the next (or an already received) client message matching `method`. */
  waitFor(method: string, pred: (m: Msg) => boolean = () => true): Promise<Msg> {
    const hit = this.received.find((m) => m.method === method && pred(m));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => this.waiters.push({ pred: (m) => m.method === method && pred(m), resolve }));
  }

  sent(method: string): Msg[] {
    return this.received.filter((m) => m.method === method);
  }

  completeTurn(threadId: string, turnId: string, status: string, error: unknown = null): void {
    if (this.activeTurn.get(threadId) === turnId) this.activeTurn.delete(threadId);
    const list = this.turns.get(threadId) ?? [];
    list.push({ ...turn(turnId, status), error });
    this.turns.set(threadId, list);
    this.notify('thread/status/changed', { threadId, status: { type: 'idle' } });
    this.notify('turn/completed', { threadId, turn: { ...turn(turnId, status), error } });
  }

  /** userMessage item echo, as Codex does for every consumed input. */
  echoUser(threadId: string, turnId: string, clientId: string | null, text = 'hi', id = `um-${clientId}`): void {
    const item = { type: 'userMessage', id, clientId, content: [{ type: 'text', text, text_elements: [] }] };
    this.notify('item/started', { item, threadId, turnId, startedAtMs: 1 });
    this.notify('item/completed', { item, threadId, turnId, completedAtMs: 1 });
  }

  /** The whole server dies: every connection closes. */
  kill(reason = 'killed'): void {
    this.dropClients(reason);
  }

  private addConn(c: Conn): void {
    this.conns.add(c);
    this.connections++;
  }

  private broadcast(m: Msg): void {
    const line = JSON.stringify(m);
    for (const c of this.conns) c.send(line);
  }

  private fromClient(m: Msg, conn: Conn): void {
    this.received.push(m);
    for (const w of [...this.waiters]) {
      if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
    if (m.method === undefined && typeof m.id === 'number' && this.serverRequests.has(m.id)) {
      const r = this.serverRequests.get(m.id)!;
      this.serverRequests.delete(m.id); // first answer wins
      r.resolve(m);
      return;
    }
    if (m.method === undefined || m.id === undefined) return;
    const h = this.handlers[m.method];
    const id = m.id;
    // Responses go out asynchronously, like a real process.
    void Promise.resolve()
      .then(() => {
        if (!h) throw new FakeRpcError(-32601, `method not found: ${m.method}`);
        return h(m.params, this);
      })
      .then(
        (result) => {
          conn.send(JSON.stringify({ id, result }));
          if (m.method === 'thread/resume') {
            for (const { msg } of this.serverRequests.values()) if (msg.params?.threadId === m.params.threadId) conn.send(JSON.stringify(msg));
          }
        },
        (e: unknown) => {
          const err = e instanceof FakeRpcError ? { code: e.code, message: e.message, data: e.data } : { code: -32000, message: String(e) };
          conn.send(JSON.stringify({ id, error: err }));
        },
      );
  }

  private threadResponse(id: string, p: any) {
    const active = this.activeTurn.get(id);
    return {
      thread: { id, sessionId: id, status: this.threadStatus.get(id) ?? (active ? { type: 'active', activeFlags: [] } : { type: 'idle' }), turns: [], cwd: p.cwd ?? '/tmp', preview: '' },
      model: p.model ?? 'gpt-default',
      modelProvider: 'openai',
      serviceTier: null,
      disabledPluginIds: [],
      cwd: p.cwd ?? '/tmp',
      instructionSources: [],
      approvalPolicy: p.approvalPolicy ?? 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      reasoningEffort: 'medium',
    };
  }
}

export function turn(id: string, status: string) {
  return { id, items: [], itemsView: 'notLoaded', status, error: null, startedAt: null, completedAt: null, durationMs: null };
}
