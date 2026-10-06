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

/**
 * A scripted codex app-server peer speaking JSONL. Tests register method handlers,
 * push notifications and server requests, and inspect what the client sent.
 */
export class FakeAppServer {
  /** Every message the client wrote, parsed. */
  readonly received: Msg[] = [];
  readonly handlers: Record<string, Handler> = {};
  userAgent = 'agents_io/0.160.1 (Mac OS 26.5.0; arm64) test';
  spawned = 0;
  closedByClient = 0;
  private lineCb: ((l: string) => void) | undefined;
  private closeCbs: ((r: string) => void)[] = [];
  private nextServerId = 0;
  private serverRequests = new Map<number, (m: Msg) => void>();
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private threadSeq = 0;
  private turnSeq = 0;
  /** Active codex turn per thread. */
  readonly activeTurn = new Map<string, string>();

  constructor() {
    this.handlers['initialize'] = () => ({ userAgent: this.userAgent, codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' });
    this.handlers['thread/start'] = (p) => this.threadResponse(`thr-${++this.threadSeq}`, p);
    this.handlers['thread/resume'] = (p) => this.threadResponse(p.threadId, p);
    this.handlers['thread/unsubscribe'] = () => ({ status: 'unsubscribed' });
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

  transport = (): Transport => {
    this.spawned++;
    return {
      write: (line) => this.fromClient(JSON.parse(line)),
      onLine: (cb) => {
        this.lineCb = cb;
      },
      onClose: (cb) => {
        this.closeCbs.push(cb);
      },
      close: () => {
        this.closedByClient++;
        this.kill('closed by client');
      },
    };
  };

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  /** Server→client request; resolves with the client's response message. */
  request(method: string, params: unknown): Promise<Msg> {
    const id = this.nextServerId++;
    return new Promise((resolve) => {
      this.serverRequests.set(id, resolve);
      this.send({ id, method, params });
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
    this.notify('thread/status/changed', { threadId, status: { type: 'idle' } });
    this.notify('turn/completed', { threadId, turn: { ...turn(turnId, status), error } });
  }

  /** userMessage item echo, as Codex does for every consumed input. */
  echoUser(threadId: string, turnId: string, clientId: string | null, text = 'hi', id = `um-${clientId}`): void {
    const item = { type: 'userMessage', id, clientId, content: [{ type: 'text', text, text_elements: [] }] };
    this.notify('item/started', { item, threadId, turnId, startedAtMs: 1 });
    this.notify('item/completed', { item, threadId, turnId, completedAtMs: 1 });
  }

  kill(reason = 'killed'): void {
    for (const cb of this.closeCbs.splice(0)) cb(reason);
  }

  private send(m: Msg): void {
    this.lineCb?.(JSON.stringify(m));
  }

  private fromClient(m: Msg): void {
    this.received.push(m);
    for (const w of [...this.waiters]) {
      if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
    if (m.method === undefined && typeof m.id === 'number' && this.serverRequests.has(m.id)) {
      const r = this.serverRequests.get(m.id)!;
      this.serverRequests.delete(m.id);
      r(m);
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
        (result) => this.send({ id, result }),
        (e: unknown) => {
          const err = e instanceof FakeRpcError ? { code: e.code, message: e.message, data: e.data } : { code: -32000, message: String(e) };
          this.send({ id, error: err });
        },
      );
  }

  private threadResponse(id: string, p: any) {
    return {
      thread: { id, sessionId: id, status: { type: 'idle' }, turns: [], cwd: p.cwd ?? '/tmp', preview: '' },
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
