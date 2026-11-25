import { timingSafeEqual } from 'node:crypto';
import {
  type Attention,
  type BackendAccess,
  type AttentionChanged,
  ContactCalloutAnswer,
  ExternalCalloutAnswer,
  OutboundCalloutAnswer,
  OutboundContentCalloutAnswer,
  PROTOCOL_VERSION,
  Resolver,
  ReviewCalloutAnswer,
  check,
  errors,
  type BodyOf,
  type ContactArgs,
  type ContentBlock,
  type Decision,
  type HostHelloResult,
  type HostRequestFrame,
  type InboundReadResult,
  type InboundEnvelope,
  type InputRecord,
  type Origin,
  type OutboundKind,
  type OutboundScopeRoute,
  type RenderedMessage,
  type ReplyRoute,
  type TurnContext,
} from '@agents-io/protocol';
import { RouterError, type CalloutAnswer, type HostQueue, type PushSubscription, type Router } from '@agents-io/session';
import type { LogFn, Outcome } from './gateway.js';
import type { HostFrames, Peer } from './local-server.js';
import type { DaemonRecords } from './records.js';
import type { Runs } from './runs.js';

/*
 * The host side of the local socket (docs/HOSTS.md §4). Every host frame needs
 * `host.hello` with the daemon's token first. Any number of authenticated
 * connections may use the request frames (the CLI's `aio run`, `aio tail`,
 * `aio send` are such connections); a connection becomes THE host — at most one
 * at a time — when its hello asks to push-consume the inbound queue (`consumer`)
 * or to answer callouts (`callouts: true`). While the host is connected the
 * router's host table is active even with `onHostDown: "suspend"`, callouts go to
 * it, and runs whose own connection is gone report `run.ended` to it.
 */

/** `host.hello` answer (protocol `HostHelloResult`). */
export type HelloResult = HostHelloResult;

/** `inbound.read` answer (protocol `InboundReadResult`). */
export type { InboundReadResult };

export interface HostServiceDeps {
  token: string;
  router: Router;
  queue: HostQueue;
  records: DaemonRecords;
  runs: Runs;
  deliver(hostName: string, f: Extract<HostRequestFrame, { type: 'deliver' }>, backend?: string): Promise<Outcome>;
  /** `deliver.update`: edit (or, `final`, finalize) a message a `deliver` sent. */
  deliverUpdate(hostName: string, f: Extract<HostRequestFrame, { type: 'deliver.update' }>, backend?: string): Promise<Outcome>;
  /** `history.read`: the channel's earlier messages around a queued item (CHANNELS §1c). `backend`: only for an item routed to it (PB-1). */
  history(f: Extract<HostRequestFrame, { type: 'history.read' }>, backend?: string): Promise<Outcome>;
  /** `schedule.put` / `remove` / `list` (docs/design/schedules). */
  schedule(hostName: string, f: Extract<HostRequestFrame, { type: 'schedule.put' | 'schedule.remove' | 'schedule.list' }>): Promise<Outcome>;
  /** `message.ack`: the channel's mark on a message (a reaction). */
  ackMessage(f: Extract<HostRequestFrame, { type: 'message.ack' }>, backend?: string): Promise<Outcome>;
  /** `conversation.create`: a conversation the channel makes (a Lark group). */
  createConversation(f: Extract<HostRequestFrame, { type: 'conversation.create' }>): Promise<Outcome>;
  /** `session.prepare`: pin an agent and a launch to a session key (decision 7). */
  prepareSession(f: Extract<HostRequestFrame, { type: 'session.prepare' }>): Outcome;
  /** `inbound.redispatch`: deliver a queued host-inbound item to a session with its original origin. */
  redispatch(hostName: string, f: Extract<HostRequestFrame, { type: 'inbound.redispatch' }>): Promise<Outcome>;
  /** `session.compact`: compact a quiet live session's harness context as a turn of its own (CT-3). */
  compactSession(f: Extract<HostRequestFrame, { type: 'session.compact' }>, origin: Origin): Promise<Outcome>;
  /** `session.prewarm`: open a known session's harness without a turn. */
  prewarmSession(f: Extract<HostRequestFrame, { type: 'session.prewarm' }>): Promise<Outcome>;
  /** `policy.answerOnBehalf`: the `resolve.onBehalfOf` feature is advertised only when it is on. */
  answerOnBehalf?: boolean;
  /** Per-hook timeouts of the `resolve` / `review` / `outbound` / `contact` / `external` callouts (config `hostCallouts`). */
  calloutTimeouts?: { resolve?: number; review?: number; outbound?: number; contact?: number; external?: number };
  /** The features of the modules that run (`ModuleManifest.features`; the external MCP module's `external.mcp`), advertised after the kernel's own. */
  moduleFeatures?: () => readonly string[];
  /** `explain`: a routing record, a side effect by operationId, or (`chain`) an agent input's chain. */
  explain(inputId: string, chain: boolean): Outcome;
  /** Test hooks are on (`test.hooks` is advertised; HOSTS §4.3, SE-6). */
  testHooks?: () => boolean;
  /** `test.replay`: a channel message accepted earlier, to the gateway again (answers `test_hooks_off` when off). */
  testReplay?(hostName: string, f: Extract<HostRequestFrame, { type: 'test.replay' }>): Promise<Outcome>;
  /** `test.fault`: drop the responses of a channel's next sends; clear; list (answers `test_hooks_off` when off). */
  testFault?(hostName: string, f: Extract<HostRequestFrame, { type: 'test.fault' }>): Outcome;
  /**
   * `backends.list` / `backends.key` / `backends.forget` (PB-3): keys and state of the configured
   * backends. Absent (an embedder without backends): the frames answer `unknown_backend` / an empty list.
   */
  backendsAdmin?: {
    list(): Outcome;
    key(id: string, op: 'issue' | 'rotate' | 'revoke', access?: BackendAccess): Outcome;
    forget(id: string): Outcome;
  };
  /**
   * The configured backends and their keys (PB-1, PB-3). Absent, or with no ids: only the host
   * token says hello and nothing below changes.
   */
  backends?: {
    ids(): readonly string[];
    /** The backend whose key this token is, and the key's level (PB-7). */
    verify(token: string): { id: string; keyId: string; access: BackendAccess } | undefined;
    /** `keyId` is still that backend's key of that level. */
    current(id: string, keyId: string, access: BackendAccess): boolean;
    /** `backends.<id>.history`: the backend may use `history.read`. */
    history(id: string): boolean;
  };
  /**
   * `blob.stat` / `blob.get` / `blob.put` (feature `blobs`, PB-6). `backend`: the frame came with that
   * backend's key and sees only its own blobs; without it, the shared store. Absent (an embedder
   * without a blob store): the frames answer `unsupported` and the feature is not advertised.
   */
  blobs?: {
    stat(ref: string, backend?: string): Promise<Outcome>;
    get(f: Extract<HostRequestFrame, { type: 'blob.get' }>, backend?: string): Promise<Outcome>;
    put(f: Extract<HostRequestFrame, { type: 'blob.put' }>, backend?: string): Promise<Outcome>;
  };
  log: LogFn;
  /** How long a pushed `inbound` waits for the host's result before it is retried (default 30 s). */
  pushTimeoutMs?: number;
  /** Delay before a refused push is retried (default 1 s). */
  pushRetryMs?: number;
  /** U20: an `outbound.scoped` host declared or replaced its scope (lives in scope now are left). */
  onScope?: () => void;
}

/** Origin of what a host connection sends (client frames, run inputs). */
export function hostOrigin(name: string): Origin {
  return { kind: 'system', principal: { id: `host:${name}`, labels: ['host'] }, evidence: 'device_only', via: `host:${name}`, adapter: 'host' };
}

export const isHostOrigin = (o: Origin) => o.kind === 'system' && o.adapter === 'host';

/** Two takeovers closer than this suggest two live hosts replacing each other. */
const TAKEOVER_FLAP_MS = 60_000;

export class HostService implements HostFrames {
  private host: { peer: Peer; name: string; consumer?: string; hooks: Set<CalloutHook>; push?: PushSubscription; attention?: true } | undefined;
  private scopeCache: { raw: string; scope: StoredScope } | undefined;
  /** When the last host takeover happened (repeated ones within TAKEOVER_FLAP_MS are logged as errors). */
  private lastTakeover: number | undefined;
  private readonly token: Buffer;
  /**
   * PB-1: a backend's connections (by connection: `peer.auth` is gone when `gone` runs). One that said
   * hello with its key, or (`admitted`) one the console let in on `/ws` with its key and that may not
   * have said hello yet. `access`: the level of that key (PB-7).
   */
  private readonly backendPeers = new Map<Peer, { id: string; access: BackendAccess; admitted?: true }>();
  /** PB-1: per backend, the one connection its items are pushed to. Always a read-write one. */
  private readonly backendPush = new Map<string, { peer: Peer; push: PushSubscription }>();
  /** PR-2: per connection, the last `blob.get` and its answer being written out: the next one waits for it. */
  private readonly blobGets = new WeakMap<Peer, Promise<void>>();
  /** PB-7: per read connection, how many of its `inbound.read` long-polls are waiting now (at most `MAX_OBSERVER_WAITS`). */
  private readonly observerWaits = new WeakMap<Peer, number>();

  constructor(private readonly d: HostServiceDeps) {
    this.token = Buffer.from(d.token);
  }

  /** The connected host, if any. */
  hostPeer(): Peer | undefined {
    return this.host?.peer;
  }

  hostName(): string | undefined {
    return this.host?.name;
  }

  /** The connected host's name and role, if any. */
  info(): { name: string; consumer?: string; callouts: boolean; hooks: CalloutHook[] } | undefined {
    const h = this.host;
    return h ? { name: h.name, callouts: h.hooks.size > 0, hooks: [...h.hooks], ...(h.consumer !== undefined ? { consumer: h.consumer } : {}) } : undefined;
  }

  /**
   * The host that last connected with the `outbound` hook, while it is not answering
   * (disconnected, also across a daemon restart): sends only it could allow fail closed
   * (DL-5). Cleared when a host connects without the hook.
   */
  outboundHeldBy(): string | undefined {
    return this.answers('outbound') ? undefined : this.d.records.flag(OUTBOUND_FLAG);
  }

  /**
   * The host that last connected with the `external` hook, while it is not answering: every
   * write of an external MCP client is denied until it (or a host without the hook) connects.
   */
  externalHeldBy(): string | undefined {
    return this.answers('external') ? undefined : this.d.records.flag(EXTERNAL_FLAG);
  }

  /**
   * The last host to take the role declared `outbound` with `outbound.content` (U20 item 1, feature
   * `callouts.outbound.content`): its `outbound` callouts carry the content and may answer `hold`, and
   * every settlement says what it was (`kind`). Kept while it is away, like `host.outbound`.
   */
  outboundContentDeclared(): boolean {
    return this.d.records.flag(CONTENT_FLAG) !== undefined;
  }

  /**
   * HC-7: the last host to take the role asked for `optIn: ["item.tool"]` (MCP tool items keep
   * `tool { server, name }`, nothing else changes). Kept while it is away, like `host.outbound.content`.
   */
  itemToolDeclared(): boolean {
    return this.d.records.flag(ITEM_TOOL_FLAG) !== undefined;
  }

  /** The connected host answers `outbound` with the content (`outbound` + `outbound.content`). */
  answersContent(): boolean {
    return this.answers('outbound') && this.answers('outbound.content');
  }

  /**
   * The scope an `outbound.scoped` host declared (U20), kept across restarts and while that host is
   * away; cleared only by a hello that takes the host role without `outbound.scoped`.
   */
  outboundScope(): StoredScope | undefined {
    const raw = this.d.records.flag(SCOPE_FLAG);
    if (raw === undefined) return undefined;
    if (this.scopeCache?.raw === raw) return this.scopeCache.scope;
    let scope: StoredScope | undefined;
    try {
      const v = JSON.parse(raw) as StoredScope;
      if (typeof v?.host === 'string' && typeof v.revision === 'number' && Array.isArray(v.routes)) scope = v;
    } catch {
      scope = undefined;
    }
    // A record that does not parse still says a scope was declared: fail closed, every route is in it
    // (checked, held while no host answers) until a scoped host declares or replaces its scope.
    if (!scope) {
      scope = { host: '?', revision: 0, routes: [], all: true };
      this.d.log('error', `the outbound scope record does not parse: every route is checked until the scoped host declares its scope again`);
    }
    this.scopeCache = { raw, scope };
    return scope;
  }

  /** The route is in the declared scope (its conversation, any thread). */
  inScope(route: { channel: string; account: string; conversationId: string }): boolean {
    const s = this.outboundScope();
    if (s?.all) return true;
    return !!s && s.routes.some((r) => r.channel === route.channel && r.account === route.account && r.conversationId === route.conversationId);
  }

  private putScope(host: string, routes: OutboundScopeRoute[]): number {
    const revision = (this.outboundScope()?.revision ?? 0) + 1;
    const clean = routes.map((r) => ({ channel: r.channel, account: r.account, conversationId: r.conversationId }));
    this.d.records.setFlag(SCOPE_FLAG, JSON.stringify({ host, revision, routes: clean } satisfies StoredScope));
    try {
      this.d.onScope?.();
    } catch {
      // best effort: a live in scope is also refused at live_say
    }
    return revision;
  }

  /** The connected host answers this `policy` hook. */
  answers(hook: CalloutHook): boolean {
    const h = this.host;
    return !!h && h.hooks.has(hook) && !h.peer.signal.aborted;
  }

  private backendIds(): readonly string[] {
    return this.d.backends?.ids() ?? [];
  }

  async handle(peer: Peer, f: HostRequestFrame): Promise<Outcome> {
    const backend = peer.auth?.backend;
    if (backend) {
      // PB-3: the key is checked on every frame (rotate / revoke close the connection; this is the second lock).
      if (!this.d.backends?.current(backend.id, backend.keyId, backend.access)) {
        // After end() nothing is written: the answer goes first, the close after it.
        setImmediate(() => this.endBackendPeer(peer, 'its key is no longer valid'));
        return fail('unauthorized', 'this key is no longer valid');
      }
      if (backend.access === 'read') {
        // PB-7: a read key observes. Default deny, and one answer for everything it may not do.
        if (!(READ_FRAMES.has(f.type) || (f.type === 'history.read' && this.d.backends.history(backend.id)))) return READ_ONLY;
      } else {
        // PB-1: default deny. A frame added later is not a backend's until it is listed here.
        const allowed = BACKEND_FRAMES.has(f.type) || (f.type === 'history.read' && this.d.backends.history(backend.id));
        if (!allowed) return fail('forbidden', `${f.type} is not open to a backend key`);
      }
    }
    const own = backend ? `backend:${backend.id}` : undefined;
    switch (f.type) {
      case 'host.hello':
        return this.hello(peer, f);
      case 'bindings.put':
        try {
          const r = this.d.router.putHostTable(f.table);
          const st = this.d.router.hostTable();
          return ok({ ...r, active: st?.active ?? false, ...(st?.suspended ? { suspended: st.suspended } : {}) });
        } catch (e) {
          if (e instanceof RouterError) return fail(e.code, e.message);
          throw e;
        }
      case 'bindings.get':
        return ok({ config: this.d.router.configTable() ?? null, host: this.d.router.hostTable() ?? null, hostConnected: this.d.router.hostConnected });
      case 'run.start':
        return this.d.runs.start(peer, f, peer.auth!.origin(`run:${f.runId}`));
      case 'run.cancel':
        return this.d.runs.cancel(f.runId, f.reason);
      case 'deliver':
        // With a backend's key (`backend`): within what it was routed or the admin registered (PB-2).
        return backend ? this.d.deliver(peer.auth!.name, f, backend.id) : this.d.deliver(peer.auth!.name, f);
      case 'deliver.update':
        return backend ? this.d.deliverUpdate(peer.auth!.name, f, backend.id) : this.d.deliverUpdate(peer.auth!.name, f);
      case 'message.ack':
        return backend ? this.d.ackMessage(f, backend.id) : this.d.ackMessage(f);
      case 'history.read':
        return this.d.history(f, backend?.id);
      case 'schedule.put':
      case 'schedule.remove':
      case 'schedule.list':
        return this.d.schedule(peer.auth!.name, f);
      case 'conversation.create':
        return this.d.createConversation(f);
      case 'input.verify':
        return ok(this.d.records.verify(f.channelRef));
      case 'inbound.read': {
        if (!f.consumer) return fail('invalid_frame', 'consumer is empty');
        if (own !== undefined && !isOwnConsumer(backend!.id, f.consumer)) return fail('forbidden', 'a backend key reads only its own cursor');
        // PB-7: a read key looks, it does not read as the consumer (that would touch the consumer's row).
        if (backend?.access === 'read') return this.observe(peer, backend.id, f);
        const consumer = own ?? f.consumer;
        const stray = own === undefined ? this.strayBackendConsumer(consumer) : undefined;
        if (stray) return stray;
        const items = await this.d.queue.read(consumer, {
          ...(f.after !== undefined ? { after: f.after } : {}),
          ...(f.limit !== undefined ? { limit: f.limit } : {}),
          waitMs: Math.min(Math.max(0, f.waitMs ?? 0), 300_000),
          signal: peer.signal,
        });
        // The head is the consumer's own: a backend's is the last of its items (a consumer without a target: the queue's).
        return ok<InboundReadResult>({ items, acked: this.d.queue.cursor(consumer), head: this.d.queue.headOf(consumer) });
      }
      case 'inbound.ack': {
        if (!f.consumer) return fail('invalid_frame', 'consumer is empty');
        if (own !== undefined && !isOwnConsumer(backend!.id, f.consumer)) return fail('forbidden', 'a backend key acks only its own cursor');
        const consumer = own ?? f.consumer;
        const stray = own === undefined ? this.strayBackendConsumer(consumer) : undefined;
        if (stray) return stray;
        return ok({ consumer, acked: this.d.queue.ack(consumer, f.cursor) });
      }
      case 'explain':
        return this.d.explain(f.inputId, f.chain === true);
      case 'session.prepare':
        return this.d.prepareSession(f);
      case 'inbound.redispatch':
        return this.d.redispatch(peer.auth!.name, f);
      case 'session.compact':
        return this.d.compactSession(f, peer.auth!.origin(f.sessionKey));
      case 'session.prewarm':
        return this.d.prewarmSession(f);
      // Test hooks: the host token (checked by hello) and AIO_TEST_HOOKS=1 at daemon start.
      case 'test.replay':
        return this.d.testReplay ? this.d.testReplay(peer.auth!.name, f) : fail('test_hooks_off', 'test hooks are off');
      case 'test.fault':
        return this.d.testFault ? this.d.testFault(peer.auth!.name, f) : fail('test_hooks_off', 'test hooks are off');
      case 'host.outboundScope': {
        const h = this.host;
        if (!h || h.peer !== peer || !h.hooks.has('outbound.scoped')) return fail('not_scoped', 'only the connected host that declared outbound.scoped may replace its scope');
        const revision = this.putScope(h.name, f.routes);
        this.d.log('info', `host ${h.name} replaced its outbound scope (revision ${revision}, ${f.routes.length} conversation(s))`);
        return ok({ revision });
      }
      // PB-3: every authenticated connection here holds the host token (the admin credential).
      case 'backends.list':
        return this.d.backendsAdmin?.list() ?? ok({ backends: [] });
      case 'backends.key':
        return this.d.backendsAdmin?.key(f.backend, f.op, f.access) ?? fail('unknown_backend', `no backend ${JSON.stringify(f.backend)} in the config (backends)`);
      case 'backends.forget':
        return this.d.backendsAdmin?.forget(f.backend) ?? ok({ backend: f.backend, items: 0, routes: 0, closed: 0 });
      // PB-6: with a backend's key, only its own blobs (`backend.id`); with the host token, the shared store.
      case 'blob.stat':
        return this.d.blobs ? this.d.blobs.stat(f.ref, backend?.id) : NO_BLOBS;
      case 'blob.get':
        return this.d.blobs ? this.blobGet(peer, f, backend?.id) : NO_BLOBS;
      case 'blob.put':
        return this.d.blobs ? this.d.blobs.put(f, backend?.id) : NO_BLOBS;
    }
  }

  /**
   * `blob.get`, one at a time per connection (PR-2): the next range is read only once the answer
   * before it was handed to the connection and written out by it (`Peer.flushed`: the local
   * socket's drain, the WebSocket's own count of unwritten frames). A peer that asks without
   * reading holds one answer in memory, not one per request.
   */
  private blobGet(peer: Peer, f: Extract<HostRequestFrame, { type: 'blob.get' }>, backend: string | undefined): Promise<Outcome> {
    const before = this.blobGets.get(peer) ?? Promise.resolve();
    const run = before.then(() => (peer.signal.aborted ? fail('disconnected', 'connection closed') : this.d.blobs!.get(f, backend)));
    this.blobGets.set(
      peer,
      run
        // The answer is written by the connection after this resolves: give it that turn, then wait for the write.
        .then(() => new Promise<void>((r) => setImmediate(r)))
        .then(() => peer.flushed?.())
        .catch(() => undefined),
    );
    return run;
  }

  /**
   * `inbound.read` with a read key (PB-7): the backend's items after `after` (default: after what
   * the backend acked, so what it has not handled yet), with the same long-poll. Nothing is
   * written: no consumer is registered or touched, no cursor moves, retention does not know of it.
   * The observer keeps its own place and asks again with `after`.
   *
   * Bounded: every long-poll that waits is woken by every append, whoever the item is for, so one
   * connection holds at most `MAX_OBSERVER_WAITS` of them and a further one is `busy`. A read
   * without `waitMs` never waits and is not counted.
   */
  private async observe(peer: Peer, id: string, f: Extract<HostRequestFrame, { type: 'inbound.read' }>): Promise<Outcome> {
    const own = `backend:${id}`;
    const waitMs = Math.min(Math.max(0, f.waitMs ?? 0), 300_000);
    if (waitMs > 0) {
      const waiting = this.observerWaits.get(peer) ?? 0;
      if (waiting >= MAX_OBSERVER_WAITS) return OBSERVER_BUSY;
      this.observerWaits.set(peer, waiting + 1);
    }
    try {
      const acked = this.d.queue.ackedOf(own);
      const items = await this.d.queue.peek(id, {
        after: f.after ?? acked,
        ...(f.limit !== undefined ? { limit: f.limit } : {}),
        waitMs,
        signal: peer.signal,
      });
      const now = this.d.queue.ackedOf(own);
      return ok<InboundReadResult>({ items, acked: now, head: Math.max(now, this.d.queue.targetHead(id)) });
    } finally {
      if (waitMs > 0) this.observerWaits.set(peer, (this.observerWaits.get(peer) ?? 1) - 1);
    }
  }

  /**
   * Close every connection authenticated with backend `id`'s key (its key was rotated or revoked,
   * or the backend forgotten); how many were closed. `access`: only those made with the key of
   * that level (PB-7: each level's key closes its own connections).
   */
  dropBackend(id: string, reason: string, access?: BackendAccess): number {
    let n = 0;
    for (const [peer, b] of [...this.backendPeers]) {
      if (b.id !== id || (access !== undefined && b.access !== access)) continue;
      this.endBackendPeer(peer, reason);
      n++;
    }
    return n;
  }

  /**
   * A connection the console admitted on `/ws` with backend `id`'s key, before any hello (PB-3):
   * `dropBackend` closes it like one that said hello, and its `host.hello` must be that backend's key
   * of the same level (`access`, PB-7).
   */
  attachBackend(peer: Peer, id: string, access: BackendAccess = 'readwrite'): void {
    if (peer.signal.aborted || this.backendPeers.has(peer)) return;
    this.backendPeers.set(peer, { id, access, admitted: true });
  }

  private endBackendPeer(peer: Peer, reason: string): void {
    if (!this.backendPeers.has(peer)) return;
    peer.end?.(reason);
    // end() reports the connection gone; make sure it is forgotten even if it did not.
    if (this.backendPeers.has(peer)) this.gone(peer);
  }

  /** Backend `id` has a live connection its items are pushed to. */
  backendPushing(id: string): boolean {
    const p = this.backendPush.get(id);
    return !!p && !p.peer.signal.aborted;
  }

  /** Backend `id`'s read-write connections now, and whether one of them is pushed its items. */
  backendConnections(id: string): { connections: number; push: boolean } {
    let connections = 0;
    for (const b of this.backendPeers.values()) if (b.id === id && b.access === 'readwrite') connections++;
    return { connections, push: this.backendPushing(id) };
  }

  /** How many connections made with backend `id`'s read key there are now (PB-7). */
  backendReadConnections(id: string): number {
    let n = 0;
    for (const b of this.backendPeers.values()) if (b.id === id && b.access === 'read') n++;
    return n;
  }

  /**
   * `host.hello` with a backend's read key (PB-7): an observer of that backend. It is named like
   * the backend and is neither the host nor the backend's consumer: asking to consume, with or
   * without `takeover`, is refused before anything is looked at, so the push connection is never
   * weighed against it; nothing is registered in the queue and no push starts. Several of them at
   * once, at most `MAX_OBSERVERS` per backend that said hello (a further hello is `busy`): each may
   * hold long-polls, and those are woken by every append.
   */
  private observerHello(peer: Peer, f: Extract<HostRequestFrame, { type: 'host.hello' }>, b: { id: string; keyId: string }): Outcome {
    if (f.consumer !== undefined) return READ_ONLY;
    let observers = 0;
    for (const [p, x] of this.backendPeers) if (p !== peer && x.id === b.id && x.access === 'read' && p.auth?.backend !== undefined) observers++;
    if (observers >= MAX_OBSERVERS) return OBSERVERS_FULL;
    const name = `backend:${b.id}`;
    peer.auth = {
      name,
      origin: () => {
        throw new Error('a backend connection sends no client frames');
      },
      backend: { id: b.id, keyId: b.keyId, access: 'read' },
    };
    this.backendPeers.set(peer, { id: b.id, access: 'read', ...(this.backendPeers.get(peer)?.admitted ? { admitted: true as const } : {}) });
    this.d.log('info', `backend ${b.id}: a read-only connection (key id ${b.keyId})`);
    return ok<HelloResult>({
      name,
      protocol: PROTOCOL_VERSION,
      host: false,
      backend: { id: b.id, access: 'read' },
      bindings: { version: null, active: false },
      // Only what a read key can use (READ_FRAMES): not `blobs`, which says blob.put too.
      features: [BACKENDS_FEATURE, 'binding.tag', ...(this.d.blobs ? [BLOBS_READ_FEATURE] : []), ...(this.d.backends?.history(b.id) ? ['history'] : [])],
      ...(f.callouts !== undefined ? { callouts: [] } : {}),
      ...(f.optIn !== undefined ? { optIn: [] } : {}),
    });
  }

  /**
   * `host.hello` with a backend's key (PB-1): the key is the identity. The connection is
   * `backend:<id>` whatever name it claims, answers no callouts, gets no opt-ins, and is not the
   * host: the host slot, `router.hostConnected` and the host's flags are untouched (HQ-5, HQ-6).
   * With `consumer` its own items are pushed to it; one push connection per backend.
   */
  private backendHello(peer: Peer, f: Extract<HostRequestFrame, { type: 'host.hello' }>, b: { id: string; keyId: string; access: BackendAccess }): Outcome {
    if (b.access === 'read') return this.observerHello(peer, f, b);
    const name = `backend:${b.id}`;
    if (f.consumer !== undefined && !isOwnConsumer(b.id, f.consumer)) return fail('forbidden', 'a backend key consumes only its own cursor');
    let replaced: string | undefined;
    if (f.consumer !== undefined) {
      const old = this.backendPush.get(b.id);
      if (old && !old.peer.signal.aborted) {
        if (f.takeover !== true || !old.peer.end) return fail('host_connected', `backend ${b.id} already has a push connection; at most one per backend (host.hello takeover: true replaces it)`);
        replaced = name;
        this.d.log('warn', `backend ${b.id} takes over its push connection (connection ${old.peer.id}); closing the old connection`);
        this.endBackendPeer(old.peer, `replaced by another connection of backend ${b.id} (takeover)`);
      }
    }
    peer.auth = {
      name,
      // Not hostOrigin: a backend connection has no origin. A frame that needs one must fail, not act as the host.
      origin: () => {
        throw new Error('a backend connection sends no client frames');
      },
      backend: { id: b.id, keyId: b.keyId, access: 'readwrite' },
    };
    this.backendPeers.set(peer, { id: b.id, access: 'readwrite', ...(this.backendPeers.get(peer)?.admitted ? { admitted: true as const } : {}) });
    // The backend's consumer walks its own items only (known since the daemon started; again here in case it was forgotten).
    this.d.queue.register(name, b.id);
    if (f.consumer !== undefined) this.backendPush.set(b.id, { peer, push: this.startPush(peer, name) });
    this.d.log('info', `backend ${b.id} connected (key id ${b.keyId})${f.consumer !== undefined ? ', pushed its items' : ''}`);
    return ok<HelloResult>({
      name,
      protocol: PROTOCOL_VERSION,
      host: false,
      backend: { id: b.id, access: 'readwrite' },
      bindings: { version: null, active: false },
      ...(f.consumer !== undefined ? { inbound: { consumer: name, acked: this.d.queue.cursor(name), head: this.d.queue.headOf(name) } } : {}),
      ...(replaced !== undefined ? { replaced: { name: replaced } } : {}),
      // Only what a backend key can use now (the frames in BACKEND_FRAMES).
      features: ['backends', 'deliver.update', 'message.ack', 'host.takeover', 'binding.tag', ...(this.d.blobs ? ['blobs'] : []), ...(this.d.backends?.history(b.id) ? ['history'] : [])],
      ...(f.callouts !== undefined ? { callouts: [] } : {}),
      ...(f.optIn !== undefined ? { optIn: [] } : {}),
    });
  }

  /**
   * PB-1: with backends configured, a consumer named `backend:…` with the host token is a backend's
   * cursor or nothing. One that is no backend's (a mistyped id, an id never configured) is refused
   * before the queue registers it: registered, it would be one more consumer of the items without a
   * target, under a backend's name (it would show the host's own backlog and hold back its pruning).
   * Undefined when the name is fine; always undefined without backends (names are plain strings then).
   */
  private strayBackendConsumer(consumer: string): Outcome | undefined {
    if (!consumer.startsWith('backend:') || this.backendIds().length === 0) return undefined;
    if (this.d.queue.consumerTarget(consumer) !== undefined) return undefined;
    return fail('unknown_backend', `consumer ${JSON.stringify(consumer)} is no backend's cursor (a backend's is backend:<id>; see backends.list); choose a name that does not start with "backend:"`);
  }

  private hello(peer: Peer, f: Extract<HostRequestFrame, { type: 'host.hello' }>): Outcome {
    if (peer.auth) return fail('already_authenticated', `this connection is already ${peer.auth.name}`);
    const given = Buffer.from(f.token);
    const isHost = given.length === this.token.length && timingSafeEqual(given, this.token);
    // PB-1: a connection the console admitted with a backend's key is that backend's and nobody else's:
    // not the host (whoever holds the host token as well), not another backend, and (PB-7) not the same
    // backend's key of the other level: admitted to observe, it never becomes the backend.
    const admitted = this.backendPeers.get(peer);
    if (admitted) {
      const b = isHost ? undefined : this.d.backends?.verify(f.token);
      if (b && b.id === admitted.id && b.access === admitted.access) return this.backendHello(peer, f, b);
      this.d.log('warn', `host.hello on a connection admitted with backend ${admitted.id}'s ${admitted.access === 'read' ? 'read key' : 'key'}, with ${isHost ? 'the host token' : b ? `backend ${b.id}'s ${b.access === 'read' ? 'read key' : 'key'}` : 'a wrong token'}`);
      return fail('unauthorized', `this connection was opened with backend ${admitted.id}'s key: host.hello takes that key only`);
    }
    if (!isHost) {
      // Not the host token: a backend's key (PB-1, PB-3)? The key decides who this is.
      const b = this.d.backends?.verify(f.token);
      if (b) return this.backendHello(peer, f, b);
      this.d.log('warn', `host.hello from ${JSON.stringify(f.name)} with a wrong token`);
      return fail('unauthorized', 'wrong token (read it from the token file next to the socket)');
    }
    const name = f.name.trim();
    if (!name) return fail('invalid_frame', 'name is empty');
    const backends = this.backendIds().length > 0;
    if (backends) {
      // PB-1 / ID-3: `backend:<id>` names a connection made with that backend's key, and a backend's
      // cursor is pushed only to it. (The host token may still pull and ack it: inbound.read / inbound.ack.)
      if (name.startsWith('backend:')) return fail('invalid_frame', 'a name starting "backend:" is a backend key\'s; choose another name');
      if (f.consumer && this.d.queue.consumerTarget(f.consumer) !== undefined) return fail('invalid_frame', `consumer ${JSON.stringify(f.consumer)} is a backend's cursor: only its key is pushed its items (inbound.read / inbound.ack work with the host token)`);
      const stray = f.consumer ? this.strayBackendConsumer(f.consumer) : undefined;
      if (stray) return stray;
    }
    const hooks = calloutHooks(f.callouts);
    const optIn = new Set(OPT_INS.filter((x) => Array.isArray(f.optIn) && f.optIn.includes(x)));
    // `outbound.content` adds to `outbound` (`outbound.scoped` has the content anyway): alone it names nothing.
    if (hooks.has('outbound.content') && !hooks.has('outbound') && !hooks.has('outbound.scoped')) hooks.delete('outbound.content');
    const role = f.consumer !== undefined || hooks.size > 0;
    if (f.consumer !== undefined && !f.consumer) return fail('invalid_frame', 'consumer is empty');
    if (hooks.has('outbound') && hooks.has('outbound.scoped')) return fail('invalid_frame', 'callouts name both outbound and outbound.scoped: one or the other');
    if (hooks.has('outbound.scoped') && !f.outboundScope) return fail('invalid_frame', 'outbound.scoped needs outboundScope { routes }');
    let replaced: string | undefined;
    if (role && this.host && !this.host.peer.signal.aborted) {
      if (f.takeover !== true || !this.host.peer.end) return fail('host_connected', `host ${this.host.name} is connected; at most one host (consumer / callouts) at a time (host.hello takeover: true replaces it)`);
      // The token proves the same authority: the old connection is most likely half-open.
      const old = this.host;
      replaced = old.name;
      // Any token holder may take over, whatever its name, and the old host's runs are interrupted
      // (gone → runs.peerGone). Two live hosts both reconnecting with takeover would flap:
      // say so loudly when takeovers come close together.
      const now = Date.now();
      const flapping = this.lastTakeover !== undefined && now - this.lastTakeover < TAKEOVER_FLAP_MS;
      this.lastTakeover = now;
      this.d.log(flapping ? 'error' : 'warn', `host ${name} takes over from host ${old.name} (connection ${old.peer.id}); closing the old connection${flapping ? `; another takeover came within ${TAKEOVER_FLAP_MS / 1000} s: are two hosts running with the same token?` : ''}`);
      old.peer.end!(`replaced by host ${name} (takeover)`);
      // end() reports the connection gone; make sure the slot is free even if it did not.
      if (this.host === old) this.gone(old.peer);
    }
    peer.auth = { name, origin: () => hostOrigin(name) };
    if (role) {
      this.host = { peer, name, hooks, ...(f.consumer !== undefined ? { consumer: f.consumer } : {}), ...(optIn.has('attention') ? { attention: true as const } : {}) };
      this.d.records.setFlag(OUTBOUND_FLAG, hooks.has('outbound') ? name : undefined);
      this.d.records.setFlag(CONTENT_FLAG, hooks.has('outbound') && hooks.has('outbound.content') ? name : undefined);
      this.d.records.setFlag(EXTERNAL_FLAG, hooks.has('external') ? name : undefined);
      this.d.records.setFlag(ITEM_TOOL_FLAG, optIn.has('item.tool') ? name : undefined);
      // U20: a scope stays across restarts and while its host is away; a host taking the role without it ends it.
      if (hooks.has('outbound.scoped')) this.putScope(name, f.outboundScope!.routes);
      else this.d.records.setFlag(SCOPE_FLAG, undefined);
      this.d.router.setHostConnected(true);
      if (f.consumer !== undefined) this.host.push = this.startPush(peer, f.consumer);
      this.d.log('info', `host ${name} connected${f.consumer !== undefined ? `, consuming as ${f.consumer}` : ''}${hooks.size ? `, answering callouts (${[...hooks].join(', ')})` : ''}`);
    }
    const st = this.d.router.hostTable();
    return ok<HelloResult>({
      name,
      protocol: PROTOCOL_VERSION,
      host: role,
      bindings: { version: st?.table.version ?? null, active: st?.active ?? false, ...(st?.suspended ? { suspended: st.suspended } : {}) },
      ...(f.consumer !== undefined ? { inbound: { consumer: f.consumer, acked: this.d.queue.cursor(f.consumer), head: this.d.queue.head() } } : {}),
      ...(replaced !== undefined ? { replaced: { name: replaced } } : {}),
      features: [...FEATURES.filter((x) => (x !== 'resolve.onBehalfOf' || this.d.answerOnBehalf) && (x !== 'test.hooks' || this.d.testHooks?.() === true) && (x !== 'blobs' || this.d.blobs !== undefined)), ...(backends ? [BACKENDS_FEATURE, BACKEND_ACCESS_FEATURE] : []), ...(this.d.moduleFeatures?.() ?? [])],
      ...(f.callouts !== undefined ? { callouts: role ? [...hooks] : [] } : {}),
      ...(role && hooks.has('outbound.scoped') ? { outboundScope: { revision: this.outboundScope()!.revision, routes: this.outboundScope()!.routes.length } } : {}),
      ...(f.optIn !== undefined ? { optIn: role ? [...optIn] : [] } : {}),
    });
  }

  /**
   * A session's attention changed (`Hub.onAttention`, LN-11): an `attention.changed` frame to the
   * host, when its hello asked `optIn: ["attention"]`. No answer; nothing kept while no host listens.
   */
  attentionChanged(sessionKey: string, attention: Attention): void {
    const h = this.host;
    if (!h?.attention || h.peer.signal.aborted) return;
    h.peer.send({ v: PROTOCOL_VERSION, type: 'attention.changed', sessionKey, attention } satisfies AttentionChanged);
  }

  /** Push-consume: one `inbound` at a time; the cursor moves when the host answers `{ accepted: true }`. */
  private startPush(peer: Peer, consumer: string): PushSubscription {
    return this.d.queue.subscribe(
      consumer,
      async (item) => {
        const r = await peer.request({ type: 'inbound', item }, this.d.pushTimeoutMs ?? 30_000);
        return r.ok && (r.value as { accepted?: unknown } | undefined)?.accepted === true;
      },
      { retryMs: this.d.pushRetryMs ?? 1000 },
    );
  }

  gone(peer: Peer): void {
    this.d.runs.peerGone(peer);
    // A backend's connection (looked up by the connection: its `auth` is already cleared). Never the host.
    const b = this.backendPeers.get(peer);
    if (b) {
      this.backendPeers.delete(peer);
      const p = this.backendPush.get(b.id);
      if (p?.peer === peer) {
        p.push.close();
        this.backendPush.delete(b.id);
      }
      this.d.log('info', b.access === 'read' ? `backend ${b.id}: a read-only connection closed` : `backend ${b.id} disconnected`);
      return;
    }
    if (this.host?.peer !== peer) return;
    this.host.push?.close();
    this.d.log('info', `host ${this.host.name} disconnected`);
    this.host = undefined;
    this.d.router.setHostConnected(false);
  }

  /** The router's `routeCallout`: ask the connected host (the router applies the rule's timeout). */
  async routeCallout(bindingId: string, input: InputRecord, envelope: InboundEnvelope): Promise<CalloutAnswer> {
    const h = this.host;
    if (!h) throw new Error('no host connected');
    if (!h.hooks.has('route')) throw new Error(`host ${h.name} does not answer route callouts`);
    const r = await h.peer.request({ type: 'policy', hook: 'route', args: { bindingId, input, envelope } }, 60_000);
    if (!r.ok) throw new Error(`${r.error?.code ?? 'error'}: ${r.error?.message ?? ''}`);
    return r.value as CalloutAnswer;
  }

  /**
   * `Policy.resolve` asked of the host (hook `resolve`). Throws when the host does
   * not answer it, times out, fails or answers something that is not a Resolver:
   * the caller falls back to its own policy.
   */
  async resolveCallout(request: BodyOf<'request.opened'>, ctx: TurnContext, native?: unknown): Promise<Resolver> {
    const { resolver: _r, ...req } = request;
    const args = { request: req, ctx: ctxView(ctx), ...(native !== undefined ? { native } : {}) };
    const v = await this.callout('resolve', args, this.d.calloutTimeouts?.resolve ?? 3000);
    if (!check(Resolver, v)) throw new Error(`bad resolve answer: ${errors(Resolver, v).slice(0, 2).join('; ')}`);
    return v;
  }

  /**
   * The `model` resolver's review asked of the host (hook `review`, the lanes' `modelReviewer`).
   * Throws when no host answers it, it times out, fails or answers something else: the lane
   * escalates.
   */
  async reviewCallout(a: {
    request: BodyOf<'request.opened'>;
    ctx: TurnContext;
    model: string;
    prompt?: string;
    native?: unknown;
  }): Promise<Decision | { escalate: true; reason?: string; resolver?: Resolver }> {
    const { resolver: _r, ...req } = a.request;
    const args = {
      request: req,
      ctx: ctxView(a.ctx),
      model: a.model,
      ...(a.prompt !== undefined ? { prompt: a.prompt } : {}),
      ...(a.native !== undefined ? { native: a.native } : {}),
    };
    const v = await this.callout('review', args, this.d.calloutTimeouts?.review ?? 15_000);
    if (!check(ReviewCalloutAnswer, v)) throw new Error(`bad review answer: ${errors(ReviewCalloutAnswer, v).slice(0, 2).join('; ')}`);
    return v;
  }

  /** `Policy.outbound` asked of the host (hook `outbound`). Throws on no answer or a bad one: the caller denies. */
  async outboundCallout(from: TurnContext | null, to: ReplyRoute): Promise<'allow' | 'deny'> {
    const v = await this.callout('outbound', { from: from ? ctxView(from) : null, to }, this.d.calloutTimeouts?.outbound ?? 2000);
    // An `outbound.content` host may answer `hold` here too (a check with no content, e.g. where a live opens): not sent.
    if (this.answersContent() && check(OutboundContentCalloutAnswer, v)) return v.verdict === 'allow' ? 'allow' : 'deny';
    if (!check(OutboundCalloutAnswer, v)) throw new Error(`bad outbound answer: ${errors(OutboundCalloutAnswer, v).slice(0, 2).join('; ')}`);
    return v.verdict;
  }

  /**
   * The `outbound` callout with the content and what it is (U20), asked of an `outbound.scoped` host or
   * an `outbound` + `outbound.content` one. Throws on no answer or a bad one: the caller holds
   * (`host_unavailable`, scoped) or denies (DL-5, unscoped).
   */
  async outboundContentCallout(a: { from: TurnContext | null; to: ReplyRoute; content?: RenderedMessage; attachmentText?: Record<string, string>; turnId?: string; kind: OutboundKind; requestId?: string }): Promise<OutboundContentCalloutAnswer> {
    const args = {
      from: a.from ? ctxView(a.from) : null,
      to: a.to,
      kind: a.kind,
      ...(a.content !== undefined ? { content: a.content } : {}),
      ...(a.attachmentText && Object.keys(a.attachmentText).length ? { attachmentText: a.attachmentText } : {}),
      ...(a.turnId !== undefined ? { turnId: a.turnId } : {}),
      ...(a.requestId !== undefined ? { requestId: a.requestId } : {}),
    };
    const hook: CalloutHook = this.host?.hooks.has('outbound.scoped') ? 'outbound.scoped' : 'outbound.content';
    const v = await this.callout(hook, args, this.d.calloutTimeouts?.outbound ?? 2000, 'outbound');
    if (!check(OutboundContentCalloutAnswer, v)) throw new Error(`bad outbound answer: ${errors(OutboundContentCalloutAnswer, v).slice(0, 2).join('; ')}`);
    return v;
  }

  /** `Policy.contact` asked of the host (hook `contact`). Throws on no answer or a bad one: the caller's own policy decides. */
  async contactCallout(a: ContactArgs): Promise<'allow' | 'deny'> {
    const v = await this.callout('contact', { from: a.from, to: a.to, op: a.op, turn: a.turn ? ctxView(a.turn) : null }, this.d.calloutTimeouts?.contact ?? 2000);
    if (!check(ContactCalloutAnswer, v)) throw new Error(`bad contact answer: ${errors(ContactCalloutAnswer, v).slice(0, 2).join('; ')}`);
    return v.verdict;
  }

  /**
   * The `external` hook: may an external MCP client do this write. Throws on no answer or a
   * bad one: the caller denies.
   */
  async externalCallout(a: { client: string; principal: string; declared?: string; op: 'send' | 'input'; route?: ReplyRoute; sessionKey?: string; content: ContentBlock[]; id: string }): Promise<ExternalCalloutAnswer> {
    const v = await this.callout('external', a, this.d.calloutTimeouts?.external ?? 2000);
    if (!check(ExternalCalloutAnswer, v)) throw new Error(`bad external answer: ${errors(ExternalCalloutAnswer, v).slice(0, 2).join('; ')}`);
    return v;
  }

  /** `wire`: the hook name on the `policy` frame when it differs (`outbound.scoped` asks `outbound`). */
  private async callout(hook: CalloutHook, args: unknown, timeoutMs: number, wire: string = hook): Promise<unknown> {
    const h = this.host;
    if (!h || !h.hooks.has(hook)) throw new Error(`no host answers ${hook}`);
    const r = await h.peer.request({ type: 'policy', hook: wire, args } as never, timeoutMs);
    if (!r.ok) throw new Error(`${r.error?.code ?? 'error'}: ${r.error?.message ?? ''}`);
    return r.value;
  }

  /** Close the host connection's push loop (daemon stop). */
  close(): void {
    this.host?.push?.close();
    for (const p of this.backendPush.values()) p.push.close();
  }
}

/**
 * Capabilities `host.hello` advertises (a host must not rely on one this list lacks); `resolve.onBehalfOf` only with `policy.answerOnBehalf`.
 * `run.overrides`: `run.start.overrides` apply (or fail `bad_override`); `run.ended.usage`: `run.ended` carries `durationMs`,
 * `usage`, `turnId`, `inputId` and says `timeout`; `run.correlation`: `run.start.inputId` / `correlation`.
 * `callouts.external`: the `external` hook (always: the external MCP endpoint's feature `external.mcp` is its module's, while it listens).
 * `callouts.review`: the `review` hook (a `model` resolver's review); `resolve.native`: `resolve` and `review` callouts carry
 * the harness's `native` request; `resolver.human.extras`: a human resolver's `timeoutMs`, `note` and `allowSessionAs`, and
 * a model resolver's `escalate`, apply. `session.compact`: the `session.compact` request (a quiet live session's harness
 * compacts its context as a turn of its own, CT-3). `session.prewarm`: the `session.prewarm` request (a known session's
 * harness opens without a turn, ahead of input the host expects). `test.hooks` (only when the daemon was started with
 * AIO_TEST_HOOKS=1): the `test.replay` and `test.fault` requests (fault injection, HOSTS §4.3, SE-6). `item.tool` (HC-7):
 * MCP tool items carry `tool { server, name }` while the host declared `outbound.scoped`, `outbound` + `outbound.content`,
 * or asked `optIn: ["item.tool"]` (granted in the result's `optIn`). `host-mcp.send_file.blob_scoped` (SE-7): `send_file`
 * sends a `blob` ref only when it appeared in the calling session (an input's content block, an attachment it sent);
 * any other ref is refused like a missing one. `client.opId` (PR-3): client frames (input and interrupt commands,
 * `topic.switch`, `watch.add`) may carry `opId`; the answer is kept with the event that decided it and a retry gets it
 * back (`replayed: true`, `seq`), an op id reused for another frame type or session is `op_id_conflict`. `attention` (LN-11):
 * `SessionInfo` (the `sessions` answer, the console's sessions) and the snapshot carry `attention`, what is pending in the
 * session now; a host asking `optIn: ["attention"]` gets an `attention.changed` frame on each change. `binding.tag` (RT-1):
 * a host rule's `tag` is checked, copied to the items it queues (`InboundItem.tag`) and shown by `explain`. `blobs` (PB-6):
 * the `blob.stat`, `blob.get` and `blob.put` requests (only with a blob store). `backends` and, after it,
 * `backends.access` (PB-1, PB-7; only while a backend is configured): backend keys, and their two levels
 * (`backends.key` takes `access`, key answers and `host.hello` say it). `blobs.read` is never in this
 * list: it is what a read key's hello says instead of `blobs` (`blob.stat` and `blob.get`, no `blob.put`). These are the
 * kernel's own; `host.hello` adds the features of the modules that run (`ModuleManifest.features`) after them.
 */
export const FEATURES = [
  'session.launch',
  'callouts.resolve',
  'callouts.review',
  'resolve.native',
  'resolver.human.extras',
  'callouts.outbound',
  'callouts.contact',
  'resolve.onBehalfOf',
  'inbound.redispatch',
  'host.takeover',
  'explain.chain',
  'run.overrides',
  'run.ended.usage',
  'run.correlation',
  'callouts.external',
  'session.compact',
  'session.prewarm',
  'test.hooks',
  'callouts.outbound.content',
  'callouts.outbound.scope',
  'reply.check',
  'callout.history',
  'item.tool',
  'deliver.update',
  'conversation.create',
  'message.ack',
  'schedules',
  'history',
  'host-mcp.send_file.blob_scoped',
  'client.opId',
  'attention',
  'binding.tag',
  'blobs',
];

/** The kernel's too, advertised after `FEATURES` while a backend is configured (PB-1): no module's feature may be it. */
export const BACKENDS_FEATURE = 'backends';

/**
 * The kernel's too, after `backends` (PB-7): this daemon knows the two key levels. `backends.key`
 * takes `access` and answers it, `host.hello` with a key says `backend.access`. A daemon without it
 * ignores `access` and acts on the read-write key, so a client asks for a read key only when it is here.
 */
export const BACKEND_ACCESS_FEATURE = 'backends.access';

/** In a read key's hello where a read-write key's says `blobs` (PB-7): `blob.stat` and `blob.get`, no `blob.put`. No module's feature may be it. */
export const BLOBS_READ_FEATURE = 'blobs.read';

/**
 * PB-7: the host frames a backend's READ key may use, besides `history.read` when
 * `backends.<id>.history` is on. Default deny: a frame added later is not a read key's until it is
 * listed here, and nothing that changes anything ever is.
 */
const READ_FRAMES: ReadonlySet<HostRequestFrame['type']> = new Set(['host.hello', 'inbound.read', 'blob.stat', 'blob.get']);

/** PB-7: the one answer to everything a read key may not do. It says nothing but that. */
const READ_ONLY: Outcome = { ok: false, code: 'forbidden', message: 'this key is read-only' };

/**
 * PB-7: how many `inbound.read` long-polls one read connection may have waiting, and how many read
 * connections that said hello a backend may have. Each waiting long-poll is woken, and reads the
 * queue again, on every append (any backend's item, the host's): without a bound a read key could
 * make every append as slow as it liked for everybody. A push connection waits once.
 */
export const MAX_OBSERVER_WAITS = 4;
export const MAX_OBSERVERS = 32;

const OBSERVER_BUSY: Outcome = { ok: false, code: 'busy', message: `at most ${MAX_OBSERVER_WAITS} inbound.read may wait on one read-only connection: wait for one to answer` };
const OBSERVERS_FULL: Outcome = { ok: false, code: 'busy', message: `at most ${MAX_OBSERVERS} read-only connections per backend: close one first` };

/**
 * PB-1: the host frames a backend's key may use, besides `history.read` when `backends.<id>.history`
 * is on. Every other host frame answers `forbidden` on such a connection. The `blob.*` frames see
 * only the backend's own blobs (PB-6).
 */
const BACKEND_FRAMES: ReadonlySet<HostRequestFrame['type']> = new Set(['host.hello', 'inbound.read', 'inbound.ack', 'deliver', 'deliver.update', 'message.ack', 'blob.stat', 'blob.get', 'blob.put']);

const NO_BLOBS: Outcome = { ok: false, code: 'unsupported', message: 'this server has no blob store' };

/** The two ways a backend may name its own cursor. */
const isOwnConsumer = (id: string, consumer: string) => consumer === id || consumer === `backend:${id}`;

/** `DaemonRecords` flag: the name of the host that declared the `outbound` hook. */
const OUTBOUND_FLAG = 'host.outbound';
/** `DaemonRecords` flag: the name of the host that declared the `external` hook. */
const EXTERNAL_FLAG = 'host.external';
/**
 * `DaemonRecords` flag (U20): the `outbound.scoped` host's scope as JSON `{ host, revision, routes }`.
 * A new name, so a daemon downgraded to one without scopes never reads it (and holds nothing back).
 */
const SCOPE_FLAG = 'host.outbound.scope';
/** `DaemonRecords` flag (U20): the name of the host that declared `outbound` with `outbound.content`. */
const CONTENT_FLAG = 'host.outbound.content';
/** `DaemonRecords` flag (HC-7): the name of the host whose hello had `optIn: ["item.tool"]`. */
const ITEM_TOOL_FLAG = 'host.item.tool';

/** `host.hello.optIn` names a host may ask for. */
const OPT_INS = ['item.tool', 'attention'] as const;

/** The stored scope of an `outbound.scoped` host. */
export interface StoredScope {
  host: string;
  revision: number;
  routes: OutboundScopeRoute[];
  /** The record did not parse: every route is in scope (fail closed), never written. */
  all?: true;
}

/** The `policy` hooks a host may answer. */
export type CalloutHook = 'route' | 'resolve' | 'review' | 'outbound' | 'outbound.content' | 'outbound.scoped' | 'contact' | 'external';
const HOOKS: readonly CalloutHook[] = ['route', 'resolve', 'review', 'outbound', 'outbound.content', 'outbound.scoped', 'contact', 'external'];

/** `host.hello.callouts`: `true` = route only; a list names the hooks (unknown names ignored). */
export function calloutHooks(c: boolean | string[] | undefined): Set<CalloutHook> {
  if (c === true) return new Set(['route']);
  if (!Array.isArray(c)) return new Set();
  return new Set(HOOKS.filter((h) => c.includes(h)));
}

/** A TurnContext as plain JSON (no undefined fields). */
function ctxView(c: TurnContext): TurnContext {
  return {
    sessionKey: c.sessionKey,
    turnId: c.turnId,
    run: c.run,
    inputs: c.inputs,
    replyRoute: c.replyRoute,
    ...(c.owner !== undefined ? { owner: c.owner } : {}),
    deliveries: c.deliveries,
    ...(c.provenance ? { provenance: c.provenance } : {}),
    ...(c.live ? { live: c.live } : {}),
  };
}

function ok<T>(value: T): Outcome {
  return { ok: true, value };
}

function fail(code: string, message = code): Outcome {
  return { ok: false, code, message };
}
