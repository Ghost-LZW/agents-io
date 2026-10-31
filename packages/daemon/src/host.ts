import { timingSafeEqual } from 'node:crypto';
import {
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
  deliver(hostName: string, f: Extract<HostRequestFrame, { type: 'deliver' }>): Promise<Outcome>;
  /** `deliver.update`: edit (or, `final`, finalize) a message a `deliver` sent. */
  deliverUpdate(hostName: string, f: Extract<HostRequestFrame, { type: 'deliver.update' }>): Promise<Outcome>;
  /** `history.read`: the channel's earlier messages around a queued item (CHANNELS §1c). */
  history(f: Extract<HostRequestFrame, { type: 'history.read' }>): Promise<Outcome>;
  /** `schedule.put` / `remove` / `list` (docs/design/schedules). */
  schedule(hostName: string, f: Extract<HostRequestFrame, { type: 'schedule.put' | 'schedule.remove' | 'schedule.list' }>): Promise<Outcome>;
  /** `message.ack`: the channel's mark on a message (a reaction). */
  ackMessage(f: Extract<HostRequestFrame, { type: 'message.ack' }>): Promise<Outcome>;
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
  /** The external MCP endpoint is on: `external.mcp` is advertised. */
  externalMcp?: () => boolean;
  /** `explain`: a routing record, a side effect by operationId, or (`chain`) an agent input's chain. */
  explain(inputId: string, chain: boolean): Outcome;
  /** Test hooks are on (`test.hooks` is advertised; HOSTS §4.3, SE-6). */
  testHooks?: () => boolean;
  /** `test.replay`: a channel message accepted earlier, to the gateway again (answers `test_hooks_off` when off). */
  testReplay?(hostName: string, f: Extract<HostRequestFrame, { type: 'test.replay' }>): Promise<Outcome>;
  /** `test.fault`: drop the responses of a channel's next sends; clear; list (answers `test_hooks_off` when off). */
  testFault?(hostName: string, f: Extract<HostRequestFrame, { type: 'test.fault' }>): Outcome;
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
  private host: { peer: Peer; name: string; consumer?: string; hooks: Set<CalloutHook>; push?: PushSubscription } | undefined;
  private scopeCache: { raw: string; scope: StoredScope } | undefined;
  /** When the last host takeover happened (repeated ones within TAKEOVER_FLAP_MS are logged as errors). */
  private lastTakeover: number | undefined;
  private readonly token: Buffer;

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

  async handle(peer: Peer, f: HostRequestFrame): Promise<Outcome> {
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
        return this.d.deliver(peer.auth!.name, f);
      case 'deliver.update':
        return this.d.deliverUpdate(peer.auth!.name, f);
      case 'message.ack':
        return this.d.ackMessage(f);
      case 'history.read':
        return this.d.history(f);
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
        const items = await this.d.queue.read(f.consumer, {
          ...(f.after !== undefined ? { after: f.after } : {}),
          ...(f.limit !== undefined ? { limit: f.limit } : {}),
          waitMs: Math.min(Math.max(0, f.waitMs ?? 0), 300_000),
          signal: peer.signal,
        });
        return ok<InboundReadResult>({ items, acked: this.d.queue.cursor(f.consumer), head: this.d.queue.head() });
      }
      case 'inbound.ack':
        if (!f.consumer) return fail('invalid_frame', 'consumer is empty');
        return ok({ consumer: f.consumer, acked: this.d.queue.ack(f.consumer, f.cursor) });
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
    }
  }

  private hello(peer: Peer, f: Extract<HostRequestFrame, { type: 'host.hello' }>): Outcome {
    if (peer.auth) return fail('already_authenticated', `this connection is already ${peer.auth.name}`);
    const given = Buffer.from(f.token);
    if (given.length !== this.token.length || !timingSafeEqual(given, this.token)) {
      this.d.log('warn', `host.hello from ${JSON.stringify(f.name)} with a wrong token`);
      return fail('unauthorized', 'wrong token (read it from the token file next to the socket)');
    }
    const name = f.name.trim();
    if (!name) return fail('invalid_frame', 'name is empty');
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
      this.host = { peer, name, hooks, ...(f.consumer !== undefined ? { consumer: f.consumer } : {}) };
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
      features: FEATURES.filter((x) => (x !== 'resolve.onBehalfOf' || this.d.answerOnBehalf) && (x !== 'external.mcp' || this.d.externalMcp?.() === true) && (x !== 'test.hooks' || this.d.testHooks?.() === true)),
      ...(f.callouts !== undefined ? { callouts: role ? [...hooks] : [] } : {}),
      ...(role && hooks.has('outbound.scoped') ? { outboundScope: { revision: this.outboundScope()!.revision, routes: this.outboundScope()!.routes.length } } : {}),
      ...(f.optIn !== undefined ? { optIn: role ? [...optIn] : [] } : {}),
    });
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
  }
}

/**
 * Capabilities `host.hello` advertises (a host must not rely on one this list lacks); `resolve.onBehalfOf` only with `policy.answerOnBehalf`.
 * `run.overrides`: `run.start.overrides` apply (or fail `bad_override`); `run.ended.usage`: `run.ended` carries `durationMs`,
 * `usage`, `turnId`, `inputId` and says `timeout`; `run.correlation`: `run.start.inputId` / `correlation`.
 * `callouts.external`: the `external` hook; `external.mcp` (only while the endpoint runs): the external MCP endpoint.
 * `callouts.review`: the `review` hook (a `model` resolver's review); `resolve.native`: `resolve` and `review` callouts carry
 * the harness's `native` request; `resolver.human.extras`: a human resolver's `timeoutMs`, `note` and `allowSessionAs`, and
 * a model resolver's `escalate`, apply. `session.compact`: the `session.compact` request (a quiet live session's harness
 * compacts its context as a turn of its own, CT-3). `session.prewarm`: the `session.prewarm` request (a known session's
 * harness opens without a turn, ahead of input the host expects). `test.hooks` (only when the daemon was started with
 * AIO_TEST_HOOKS=1): the `test.replay` and `test.fault` requests (fault injection, HOSTS §4.3, SE-6). `item.tool` (HC-7):
 * MCP tool items carry `tool { server, name }` while the host declared `outbound.scoped`, `outbound` + `outbound.content`,
 * or asked `optIn: ["item.tool"]` (granted in the result's `optIn`). `host-mcp.send_file.blob_scoped` (SE-7): `send_file`
 * sends a `blob` ref only when it appeared in the calling session (an input's content block, an attachment it sent);
 * any other ref is refused like a missing one.
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
  'external.mcp',
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
];

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
const OPT_INS = ['item.tool'] as const;

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
