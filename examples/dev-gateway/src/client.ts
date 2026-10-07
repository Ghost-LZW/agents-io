import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { FrameDecoder, PROTOCOL_VERSION, encodeFrame, type ResultFrame, type SessionEvent, type Tier, type Watch, type WatchDraft } from '@agents-io/protocol';
import { AsyncQueue } from '@agents-io/testkit';
import type { ClientCommand, ServerFrame, SessionInfo } from './frames.js';

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message === code ? code : `${code}: ${message}`);
    this.name = 'CommandError';
  }
}

export interface ClientSubscription extends AsyncIterable<SessionEvent> {
  readonly sessionKey: string;
  /** Log head when the subscription started. */
  readonly head: number;
  /** Stop receiving (sends `unsubscribe`). */
  close(): Promise<void>;
}

/** A local end: connects to the gateway's Unix socket and speaks the client frames. */
export class LocalClient {
  private readonly pending = new Map<string, (r: ResultFrame) => void>();
  private readonly subs = new Map<string, AsyncQueue<SessionEvent>>();
  private closeCbs: ((reason: string) => void)[] = [];
  private closedReason: string | undefined;

  private constructor(private readonly socket: Socket) {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const f of decoder.push(chunk)) this.onFrame(f as ServerFrame);
    });
    const gone = (reason: string) => {
      if (this.closedReason !== undefined) return;
      this.closedReason = reason;
      for (const q of this.subs.values()) q.close();
      for (const [id, r] of this.pending) r({ v: PROTOCOL_VERSION, type: 'result', id, ok: false, error: { code: 'disconnected', message: reason } });
      this.pending.clear();
      for (const cb of this.closeCbs.splice(0)) cb(reason);
    };
    socket.on('close', () => gone('connection closed'));
    socket.on('error', (e) => gone(e.message));
  }

  static connect(path: string): Promise<LocalClient> {
    return new Promise((resolve, reject) => {
      const s = createConnection(path);
      s.once('connect', () => {
        s.off('error', reject);
        resolve(new LocalClient(s));
      });
      s.once('error', (e) => reject(new Error(`cannot connect to ${path}: ${e.message} (is \`aio-dev serve\` running?)`)));
    });
  }

  onClose(cb: (reason: string) => void): void {
    if (this.closedReason !== undefined) cb(this.closedReason);
    else this.closeCbs.push(cb);
  }

  private onFrame(f: ServerFrame): void {
    switch (f.type) {
      case 'result': {
        const r = this.pending.get(f.id);
        this.pending.delete(f.id);
        r?.(f);
        return;
      }
      case 'event':
        this.subs.get(f.event.sessionKey)?.push(f.event);
        return;
      case 'closed':
        this.subs.get(f.sessionKey)?.close();
        this.subs.delete(f.sessionKey);
        return;
    }
  }

  private request(frame: Record<string, unknown>): Promise<ResultFrame> {
    if (this.closedReason !== undefined) return Promise.reject(new CommandError('disconnected', this.closedReason));
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.write(encodeFrame({ v: PROTOCOL_VERSION, id, ...frame }));
    });
  }

  /** Send a command; resolves with the result value, rejects with CommandError when `ok` is false. */
  async command<T = Record<string, unknown>>(command: ClientCommand): Promise<T> {
    const r = await this.request({ type: 'command', command });
    if (!r.ok) throw new CommandError(r.error?.code ?? 'error', r.error?.message ?? 'error');
    return r.value as T;
  }

  input(sessionKey: string, text: string, mode: 'queue' | 'steer' | 'interrupt' | 'observe' = 'queue', inputId?: string) {
    return this.command<{ inputId: string; disposition: string }>({
      type: 'input',
      sessionKey,
      mode,
      input: { content: [{ type: 'text', text }], ...(inputId ? { inputId } : {}) },
    });
  }

  async sessions(): Promise<SessionInfo[]> {
    const r = await this.request({ type: 'sessions' });
    if (!r.ok) throw new CommandError(r.error?.code ?? 'error', r.error?.message ?? 'error');
    return r.value as SessionInfo[];
  }

  private async value<T>(frame: Record<string, unknown>): Promise<T> {
    const r = await this.request(frame);
    if (!r.ok) throw new CommandError(r.error?.code ?? 'error', r.error?.message ?? 'error');
    return r.value as T;
  }

  /** Create (or replace, same id) a watch as this connection's principal. */
  watchAdd(watch: WatchDraft): Promise<Watch> {
    return this.value({ type: 'watch.add', watch });
  }

  watchRemove(watchId: string): Promise<{ removed: boolean }> {
    return this.value({ type: 'watch.remove', watchId });
  }

  watchList(sessionKey?: string): Promise<Watch[]> {
    return this.value({ type: 'watch.list', ...(sessionKey !== undefined ? { sessionKey } : {}) });
  }

  /** One subscription per session per connection; subscribing again replaces it. */
  async subscribe(o: { sessionKey: string; tier: Tier; fromSeq?: number }): Promise<ClientSubscription> {
    const q = new AsyncQueue<SessionEvent>();
    this.subs.get(o.sessionKey)?.close();
    this.subs.set(o.sessionKey, q);
    const { head } = await this.command<{ head: number }>({ type: 'subscribe', sessionKey: o.sessionKey, tier: o.tier, ...(o.fromSeq !== undefined ? { fromSeq: o.fromSeq } : {}) });
    return {
      sessionKey: o.sessionKey,
      head,
      [Symbol.asyncIterator]: () => q[Symbol.asyncIterator](),
      close: async () => {
        if (this.subs.get(o.sessionKey) === q) this.subs.delete(o.sessionKey);
        q.close();
        if (this.closedReason === undefined) await this.command({ type: 'unsubscribe', sessionKey: o.sessionKey }).catch(() => undefined);
      },
    };
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}
