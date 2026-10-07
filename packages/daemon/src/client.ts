import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeFrame,
  type BindingTable,
  type ContentBlock,
  type InboundItem,
  type InboundRedispatchResult,
  type SessionLaunch,
  type SessionScope,
  type RenderedMessage,
  type ReplyRoute,
  type ResultFrame,
  type RouteExplanation,
  type RunEnded,
  type SessionEvent,
  type Tier,
  type Topic,
  type TopicSwitchResult,
  type Watch,
  type WatchDraft,
} from '@agents-io/protocol';
import { AsyncQueue } from '@agents-io/testkit';
import type { ClientCommand, ServerFrame, SessionInfo } from './frames.js';
import type { HelloResult } from './host.js';
import type { VerifyResult } from './records.js';
import type { RunStartResult } from './runs.js';

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message === code ? code : `${code}: ${message}`);
    this.name = 'CommandError';
  }
}

/** The daemon's socket is not there or refuses connections. */
export class DaemonUnavailable extends Error {
  override name = 'DaemonUnavailable';
}

/** A request the daemon sends a host (`inbound`, `policy`): answer with a value (ok) or throw (error result). */
export type DaemonRequestHandler = (frame: Record<string, unknown>) => Promise<unknown> | unknown;

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
  private readonly handlers = new Map<string, DaemonRequestHandler>();
  private readonly runEnded = new Map<string, RunEnded>();
  private readonly runWaiters = new Map<string, ((e: RunEnded) => void)[]>();

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
      s.once('error', (e) => reject(new DaemonUnavailable(`cannot connect to ${path}: ${(e as NodeJS.ErrnoException).code ?? e.message} (is \`aio serve\` running with this config? --socket / $AIO_SOCKET name another socket)`)));
    });
  }

  /** Answer requests the daemon sends this connection (`inbound` pushes, `policy` callouts). */
  onRequest(type: 'inbound' | 'policy', handler: DaemonRequestHandler): void {
    this.handlers.set(type, handler);
  }

  private async answer(f: Record<string, unknown>): Promise<void> {
    const id = f.id as string;
    const h = this.handlers.get(f.type as string);
    const reply = (r: Omit<ResultFrame, 'v' | 'type' | 'id'>) => {
      if (this.closedReason === undefined) this.socket.write(encodeFrame({ v: PROTOCOL_VERSION, type: 'result', id, ...r }));
    };
    if (!h) return reply({ ok: false, error: { code: 'unsupported', message: `no handler for ${String(f.type)}` } });
    try {
      reply({ ok: true, value: await h(f) });
    } catch (e) {
      reply({ ok: false, error: { code: (e as { code?: string }).code ?? 'error', message: (e as Error).message } });
    }
  }

  onClose(cb: (reason: string) => void): void {
    if (this.closedReason !== undefined) cb(this.closedReason);
    else this.closeCbs.push(cb);
  }

  private onFrame(raw: ServerFrame | { type: string; [k: string]: unknown }): void {
    if (raw.type === 'inbound' || raw.type === 'policy') {
      if (typeof raw.id === 'string') void this.answer(raw as Record<string, unknown>);
      return;
    }
    if (raw.type === 'run.ended') {
      const e = raw as unknown as RunEnded;
      this.runEnded.set(e.runId, e);
      for (const w of this.runWaiters.get(e.runId)?.splice(0) ?? []) w(e);
      return;
    }
    if (raw.type !== 'result' && raw.type !== 'event' && raw.type !== 'closed') return; // unknown frames are ignored
    const f = raw as ServerFrame;
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

  /** Topics of flat conversations (decision 6), newest activity first. */
  topicList(f: { conversation?: string; sessionKey?: string } = {}): Promise<Topic[]> {
    return this.value({ type: 'topic.list', ...f });
  }

  /** Make a topic current: an existing one (`topicId`) or a new one (`new`). */
  topicSwitch(f: { conversation: string; topicId: string } | { conversation: string; new: { title?: string } }): Promise<TopicSwitchResult> {
    return this.value({ type: 'topic.switch', ...f });
  }

  // ---- host protocol (docs/HOSTS.md §4) ------------------------------------

  /** Any request frame; resolves with its value, rejects with CommandError. */
  call<T>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    return this.value<T>({ type, ...fields });
  }

  /** Authenticate as a host. `consumer` / `callouts` make this connection THE host (at most one). */
  hello(o: { token: string; name: string; consumer?: string; callouts?: boolean | string[]; takeover?: boolean }): Promise<HelloResult> {
    return this.call('host.hello', o);
  }

  bindingsPut(table: BindingTable): Promise<{ version: string; previous?: string; changed: boolean; active: boolean; suspended?: string }> {
    return this.call('bindings.put', { table });
  }

  bindingsGet(): Promise<{ config: BindingTable | null; host: { table: BindingTable; putAt: number; active: boolean; suspended?: string } | null; hostConnected: boolean }> {
    return this.call('bindings.get');
  }

  runStart(o: { runId: string; agent: string; input: ContentBlock[]; cwd?: string; env?: Record<string, string>; observe?: { routes: ReplyRoute[] }; timeoutMs?: number }): Promise<RunStartResult> {
    return this.call('run.start', o);
  }

  runCancel(runId: string, reason?: string): Promise<{ runId: string; cancelled: boolean }> {
    return this.call('run.cancel', { runId, ...(reason !== undefined ? { reason } : {}) });
  }

  /** Resolves with the run's `run.ended` (sent to this connection once it started or attached to the run). */
  runEndedOf(runId: string): Promise<RunEnded> {
    const e = this.runEnded.get(runId);
    if (e) return Promise.resolve(e);
    if (this.closedReason !== undefined) return Promise.reject(new CommandError('disconnected', this.closedReason));
    return new Promise((resolve, reject) => {
      const list = this.runWaiters.get(runId) ?? [];
      list.push(resolve);
      this.runWaiters.set(runId, list);
      this.onClose((reason) => reject(new CommandError('disconnected', reason)));
    });
  }

  deliver(o: { operationId: string; route: ReplyRoute; message: RenderedMessage }): Promise<{ operationId: string; status: string; attempts: number; providerMessageId?: string; error?: string; duplicate: boolean }> {
    return this.call('deliver', o);
  }

  verify(channelRef: string): Promise<VerifyResult> {
    return this.call('input.verify', { channelRef });
  }

  inboundRead(o: { consumer: string; after?: number; limit?: number; waitMs?: number }): Promise<{ items: InboundItem[]; acked: number; head: number }> {
    return this.call('inbound.read', o);
  }

  inboundAck(consumer: string, cursor: number): Promise<{ consumer: string; acked: number }> {
    return this.call('inbound.ack', { consumer, cursor });
  }

  /** Deliver a queued host-inbound item to a session with its original origin (idempotent per cursor). */
  inboundRedispatch(o: { cursor: number; agent?: string; session?: SessionScope; launch?: SessionLaunch }): Promise<InboundRedispatchResult> {
    return this.call('inbound.redispatch', o);
  }

  explain(inputId: string): Promise<RouteExplanation> {
    return this.call('explain', { inputId });
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
