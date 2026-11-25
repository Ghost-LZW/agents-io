import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { Type, type Static, type TObject } from '@sinclair/typebox';
import {
  PROTOCOL_VERSION as AIO_PROTOCOL_VERSION,
  encodeFrame,
  type BodyOf,
  type ContentBlock as AioBlock,
  type Decision,
  type KernelContext,
  type ModuleCliArgs,
  type ModuleConnection,
  type ModuleManifest,
  type ModuleResolveContext,
  type Resolver,
  type SessionEvent,
  type TurnContext,
} from '@agents-io/protocol';
import { PROTOCOL_VERSION, RequestError, agent, methods, type AgentContext, type ClientCapabilities, type ContentBlock, type SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpProjection, permissionDecision, questionDecision, type AcpOut } from './acp-projection.js';
import { ExternalView, replay } from './external-view.js';
import {
  PeerRefusal,
  PeerTokens,
  RateWindow,
  checkText,
  inlineImage,
  mayInput,
  mayRead,
  newOwnSession,
  peerClientSchema,
  peerInput,
  peerOrigin,
  resolvePeerClients,
  sessionFor,
  type PeerClient,
} from './peers.js';

/*
 * The ACP server (core-slimming G9, north; POSITIONING §9.3): a session of this daemon as an Agent
 * Client Protocol agent, for an editor (Zed, JetBrains) or t3code's generic ACP provider. The editor
 * starts `aio acp` (this module's CLI command), which connects to the daemon's local socket, says
 * which configured client it is with that client's token (`module.connect`), and from then on pipes
 * ACP's JSON-RPC between the editor's stdio and this module. Off unless the section `acpServer` is
 * in the config. What a client does is stamped by the daemon as the client (`peer`, never a person,
 * ID-10); a prompt is a lane input like an external MCP client's (`peers.ts`), the session's events
 * are `session/update` notifications (`acp-projection.ts`, through the U20 gate of
 * `external-view.ts`), a request is asked of the client only when its resolver names the client
 * (RQ-1: the lane checks again; the client never answers on someone's behalf, RQ-3), and
 * `session/cancel` interrupts the client's own turn.
 */

/** The endpoint's name: its module's id (as the external MCP endpoint's `external-mcp`): `origin.adapter`, `via` and its clients' own sessions. */
const ENDPOINT = 'acp-server' as const;
/** The `host.hello` feature while the module runs. */
const FEATURE = 'acp.server';
/** How many of a session's last durable events `session/load` replays. */
const REPLAY_MAX_EVENTS = 5000;

const Closed = { additionalProperties: false } as const;

/**
 * The keys of the `acpServer` section (the daemon adds `enabled`): the configured clients (as the
 * external MCP endpoint's, with `read` / `input` scopes, an optional `agent` for sessions of their
 * own, and `approvals`), and limits.
 */
const AcpServerKeys = {
  clients: peerClientSchema({
    /**
     * Ask this client the approvals of the turns it started (its inputs only, not a bypass turn): it
     * answers them in the editor, as itself (default false: the policy decides, which denies a peer's
     * restricted turn's tools). Questions are not approvals: the default policy asks a turn's question
     * of the turn's person, which in a turn the client started is the client, with or without this.
     */
    approvals: Type.Optional(Type.Boolean()),
  }),
  limits: Type.Optional(
    Type.Object(
      {
        /** Longest prompt text (default 16000 characters). */
        maxTextChars: Type.Optional(Type.Integer({ minimum: 1 })),
        /** Prompts per client per minute (default 20). */
        promptsPerMinute: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      Closed,
    ),
  ),
};

/** The `acpServer` section of the config file, as written. */
export type AcpServerSection = Static<TObject<typeof AcpServerKeys>> & { enabled?: boolean };

/** One client of the ACP server, resolved. */
export interface AcpServerClient extends PeerClient {
  /** The approvals of its own turns are asked of it. */
  approvals: boolean;
}

/** The ACP server's settings, resolved. */
export interface AcpServerConfig {
  clients: AcpServerClient[];
  limits: { maxTextChars: number; promptsPerMinute: number };
}

/** The section's value as the server's settings; errors name keys, never values. */
export function resolveAcpServer(c: Omit<AcpServerSection, 'enabled'>, ctx: Pick<ModuleResolveContext, 'substitute' | 'path' | 'valueAt' | 'fail'>): AcpServerConfig {
  const clients = resolvePeerClients('acpServer', c.clients, ctx).map((x): AcpServerClient => ({ ...x, approvals: c.clients[x.name]?.approvals === true }));
  const l = c.limits ?? {};
  return { clients, limits: { maxTextChars: l.maxTextChars ?? 16_000, promptsPerMinute: l.promptsPerMinute ?? 20 } };
}

/** What `aio acp` says when it connects (`module.connect`'s `hello`). */
interface AcpHello {
  client: string;
  /** SECRET. */
  token: string;
  /** The session `session/new` binds (`aio acp --session <key>`); else each `session/new` opens one of the client's own. */
  session?: string;
}

/**
 * The ACP server as a module: section `acpServer` (off unless present; `enabled: false` turns it
 * off), feature `acp.server` while it runs, status `{ clients, connections }`, the CLI command `aio
 * acp`. The clients' tokens are read (or generated) at its start: a bad one fails the start.
 */
export const acpServerModule: ModuleManifest<AcpServerConfig> = {
  id: 'acp-server',
  kind: 'feature',
  config: {
    section: 'acpServer',
    schema: AcpServerKeys,
    defaultEnabled: false,
    resolve: (raw, ctx) => resolveAcpServer(raw as Omit<AcpServerSection, 'enabled'>, ctx),
  },
  features: [FEATURE],
  cli: {
    acp: {
      usage: '--client <name> [--token-file <path>] [--session <key>]   (speak ACP on stdio as a session of this daemon: for an editor or t3code; token: --token-file or $AIO_ACP_TOKEN)',
      options: { client: 'string', 'token-file': 'string', session: 'string' },
      run: (a) => acpCli(a),
    },
  },
  setup: (kernel, cfg) => {
    let tokens: PeerTokens | undefined;
    const links = new Set<AcpLink>();
    const prompts = new RateWindow();
    let lastRefusedLog = 0;
    const approvers = cfg.clients.filter((c) => c.approvals);
    return {
      start: async () => {
        tokens = new PeerTokens('acpServer', cfg.clients, kernel);
        kernel.log('info', `ACP server ready for aio acp (clients: ${cfg.clients.map((x) => x.name).join(', ') || 'none'})`);
      },
      status: () => ({ clients: cfg.clients.map((x) => x.name), connections: links.size }),
      connect: (raw, conn) => {
        if (!tokens || kernel.stopping()) return { ok: false, code: 'unavailable', message: 'the ACP server is not running' };
        const h = (raw && typeof raw === 'object' ? raw : {}) as Partial<AcpHello>;
        const c = tokens.match(typeof h.token === 'string' ? h.token : undefined);
        if (!c || c.name !== h.client) {
          // One line per 10 s at most: a client with a wrong token retries in a loop.
          if (Date.now() - lastRefusedLog > 10_000) kernel.log('warn', `ACP client refused: unknown client or wrong token${typeof h.client === 'string' ? ` (client ${JSON.stringify(h.client.slice(0, 64))})` : ''}`);
          lastRefusedLog = Date.now();
          return { ok: false, code: 'unauthorized', message: 'unknown client, or not its token' };
        }
        if (h.session !== undefined && (typeof h.session !== 'string' || !h.session)) return { ok: false, code: 'invalid', message: 'session must be a session key' };
        const client = cfg.clients.find((x) => x.name === c.name)!;
        const link = new AcpLink(kernel, cfg, client, conn, prompts, h.session);
        links.add(link);
        conn.signal.addEventListener('abort', () => {
          link.close();
          links.delete(link);
        });
        kernel.log('info', `ACP client ${client.name} connected${h.session ? ` (session ${h.session})` : ''}`);
        return { ok: true, value: { client: client.name, principal: client.principal.id } };
      },
      hooks: approvers.length
        ? {
            // A client with `approvals` is asked the requests of the turns it alone started (never a bypass turn's: the policy allows those).
            resolver: (ctx: TurnContext): Resolver | undefined => {
              if (ctx.run.profile === 'bypass' || !ctx.inputs.length) return undefined;
              const first = ctx.inputs[0]!.origin;
              const c = approvers.find((x) => first.kind === 'peer' && first.adapter === ENDPOINT && first.principal?.id === x.principal.id);
              if (!c || !ctx.inputs.every((i) => i.origin.kind === 'peer' && i.origin.adapter === ENDPOINT && i.origin.principal?.id === c.principal.id)) return undefined;
              return { kind: 'human', principals: [c.principal.id], routes: [] };
            },
          }
        : {},
      stop: async () => {
        for (const l of [...links]) l.close();
        links.clear();
      },
    };
  },
};

// ---- one connection -------------------------------------------------------------------

/** A prompt waiting for the turn that takes its input. */
interface Pending {
  resolve(r: { stopReason: 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens' | 'max_turn_requests' }): void;
  reject(e: Error): void;
  turnId?: string;
  /** `session/cancel` came before its turn started: answered `cancelled`, and its turn is interrupted when it starts. */
  cancelled?: boolean;
}

/** A session this connection bound (`session/new`, `session/load`): its projection and live view. */
interface Bound {
  key: string;
  /** The agent it opens with (a session of the client's own). */
  agent?: string;
  projection: AcpProjection;
  view?: ExternalView;
  /** Prompts waiting, by input id. */
  prompts: Map<string, Pending>;
  /** Requests being asked of the client, by request id (aborted when someone answers first). */
  asking: Map<string, AbortController>;
  /** While `session/load` replays: requests to ask once it is done (those the log has not settled by then). */
  deferred?: Map<string, Extract<AcpOut, { permission: unknown } | { question: unknown }>>;
}

/** The SDK's stream over a module connection: JSON-RPC messages are its JSON values. */
function streamOf(conn: ModuleConnection) {
  const readable = new ReadableStream({
    start(c) {
      conn.onValue((v) => c.enqueue(v as never));
      conn.signal.addEventListener('abort', () => {
        try {
          c.close();
        } catch {
          // already closed
        }
      });
    },
  });
  const writable = new WritableStream({
    async write(m) {
      if (!conn.send(m)) await conn.drained();
    },
    close() {
      conn.close();
    },
  });
  return { readable, writable };
}

const rpcError = (e: unknown): Error => {
  if (e instanceof RequestError) return e;
  if (e instanceof PeerRefusal) {
    if (e.code === 'not_found') return new RequestError(-32002, e.message);
    if (e.code === 'invalid') return new RequestError(-32602, e.message, { code: e.code });
    return new RequestError(-32603, e.message, { code: e.code });
  }
  return new RequestError(-32603, (e as Error).message);
};

/** One `aio acp` connection: an ACP agent over the module connection, as `client`. */
class AcpLink {
  private readonly sessions = new Map<string, Bound>();
  /** The inputs this connection sent: their user messages are the client's own (it shows them). */
  private readonly own = new Set<string>();
  private caps: ClientCapabilities = {};
  private closed = false;
  private readonly origin;

  constructor(
    private readonly k: KernelContext,
    private readonly cfg: AcpServerConfig,
    private readonly c: AcpServerClient,
    conn: ModuleConnection,
    private readonly prompts: RateWindow,
    private readonly pinned: string | undefined,
  ) {
    this.origin = peerOrigin(c, ENDPOINT);
    const app = agent({ name: 'agents-io' })
      .onRequest(methods.agent.initialize, ({ params }) => {
        this.caps = (params.clientCapabilities ?? {}) as ClientCapabilities;
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            // A session's log is what resumes it: session/load replays it.
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { list: {} },
          },
          agentInfo: { name: 'agents-io', title: 'agents-io', version: '0.1.0' },
          authMethods: [],
        };
      })
      .onRequest(methods.agent.session.new, ({ client }) => this.newSession(client))
      .onRequest(methods.agent.session.load, ({ params, client }) => this.load(params.sessionId, client))
      .onRequest(methods.agent.session.list, ({ params }) => this.list(params.cwd ?? undefined))
      .onRequest(methods.agent.session.prompt, ({ params }) => this.prompt(params.sessionId, params.prompt))
      .onNotification(methods.agent.session.cancel, ({ params }) => this.cancel(params.sessionId));
    app.connect(streamOf(conn));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const b of this.sessions.values()) this.unbind(b, new RequestError(-32603, 'the connection closed'));
    this.sessions.clear();
  }

  // ---- sessions -------------------------------------------------------------------------

  private async newSession(cx: AgentContext): Promise<{ sessionId: string }> {
    try {
      const s = this.pinned !== undefined ? sessionFor(this.k, this.c, ENDPOINT, this.pinned, 'read') : newOwnSession(this.c, ENDPOINT);
      if (!this.sessions.has(s.key)) void this.pump(this.bind(s.key, s.agent, this.k.head(s.key)), cx);
      return { sessionId: s.key };
    } catch (e) {
      throw rpcError(e);
    }
  }

  private async load(sessionId: string, cx: AgentContext): Promise<Record<string, never>> {
    if (!this.k.sessions.known(sessionId) || !mayRead(this.c, ENDPOINT, sessionId)) throw RequestError.sessionNotFound(sessionId);
    const had = this.sessions.get(sessionId);
    if (had) this.unbind(had, new RequestError(-32603, 'the session was loaded again'));
    const head = this.k.head(sessionId);
    const from = Math.max(0, head - REPLAY_MAX_EVENTS);
    // Read and subscribe with nothing in between: no event falls between the replay and the live view.
    const r = replay(this.k, sessionId, from);
    const b = this.bind(sessionId, undefined, r.head, r.waiting);
    b.deferred = new Map();
    /** The turn each replayed request was opened in. */
    const turnOf = new Map<string, string>();
    for (const e of r.shown) {
      // What the log settled is not asked: answered or cancelled (`watch` drops it), or ended with its
      // turn (RQ-2; a turn a stopped daemon left is settled at the next start without its requests' resolutions).
      this.watch(b, e);
      if (e.body.t === 'request.opened' && e.turnId !== undefined) turnOf.set(e.body.requestId, e.turnId);
      else if (e.body.t === 'turn.completed') for (const [id, t] of turnOf) if (t === e.body.turnId) b.deferred.delete(id);
      for (const out of b.projection.push(e)) await this.emit(b, out, cx, true);
    }
    // Asked now: the requests still open after the replay. Then what came meanwhile, and on.
    const ask = [...b.deferred.values()];
    delete b.deferred;
    for (const out of ask) this.ask(b, out, cx);
    void this.pump(b, cx);
    return {};
  }

  private list(cwd: string | undefined): { sessions: { sessionId: string; cwd: string; title?: string; updatedAt?: string }[] } {
    const sessions = this.k.sessions
      .list()
      .filter((s) => mayRead(this.c, ENDPOINT, s.sessionKey))
      .map((s) => ({
        sessionId: s.sessionKey,
        // agents-io sessions do not belong to an editor's directory: their own, else the one asked about.
        cwd: s.launch?.cwd ?? cwd ?? '/',
        ...(s.topic?.title ? { title: s.topic.title } : {}),
        ...(s.lastEventAt !== undefined ? { updatedAt: new Date(s.lastEventAt).toISOString() } : {}),
      }));
    return { sessions };
  }

  /** Bind a session to this connection, its live view from `fromSeq` (the caller starts its pump). */
  private bind(key: string, agentName: string | undefined, fromSeq: number, waiting: SessionEvent[] = []): Bound {
    const b: Bound = { key, ...(agentName !== undefined ? { agent: agentName } : {}), projection: new AcpProjection({ principal: this.c.principal.id }), prompts: new Map(), asking: new Map() };
    b.view = new ExternalView(this.k, key, { fromSeq, waiting });
    this.sessions.set(key, b);
    return b;
  }

  private unbind(b: Bound, why: Error): void {
    b.view?.close();
    for (const p of b.prompts.values()) p.reject(why);
    b.prompts.clear();
    for (const a of b.asking.values()) a.abort();
    b.asking.clear();
    if (this.sessions.get(b.key) === b) this.sessions.delete(b.key);
  }

  /** The session's live events, in order: what they mean for the waiting prompts, then their projection. */
  private async pump(b: Bound, cx: AgentContext): Promise<void> {
    try {
      for await (const e of b.view!) {
        if (this.closed || this.sessions.get(b.key) !== b) return;
        this.watch(b, e);
        for (const out of b.projection.push(e)) await this.emit(b, out, cx, false);
      }
    } catch (err) {
      this.k.log('warn', `ACP client ${this.c.name}: session ${b.key}: ${(err as Error).message}`);
    }
  }

  /** What an event means for the prompts waiting in the session. */
  private watch(b: Bound, e: SessionEvent): void {
    const body = e.body;
    if (body.t === 'turn.started') {
      for (const id of body.inputIds) {
        const p = b.prompts.get(id);
        if (!p) continue;
        p.turnId = body.turnId;
        if (p.cancelled) void this.interrupt(b, body.turnId);
      }
    } else if (body.t === 'input.rejected' || body.t === 'input.cancelled') {
      for (const id of body.inputIds) {
        const p = b.prompts.get(id);
        if (!p) continue;
        b.prompts.delete(id);
        if (body.t === 'input.cancelled') p.resolve({ stopReason: 'cancelled' });
        else p.reject(new RequestError(-32603, `the session did not take the prompt: ${body.reason}`, { code: 'rejected' }));
      }
    } else if (body.t === 'request.resolved') {
      // Answered first elsewhere (RQ-1): the client's own ask is withdrawn.
      b.asking.get(body.requestId)?.abort();
      b.deferred?.delete(body.requestId);
    }
  }

  private async emit(b: Bound, out: AcpOut, cx: AgentContext, replaying: boolean): Promise<void> {
    if ('update' in out) {
      // The client shows its own prompts already.
      if (!replaying && out.inputId !== undefined && this.own.has(out.inputId)) return;
      await this.notify(cx, b.key, out.update);
      return;
    }
    if ('turnEnd' in out) {
      const end = out.turnEnd;
      for (const [id, p] of [...b.prompts]) {
        if (p.turnId !== end.turnId) continue;
        b.prompts.delete(id);
        if ('stopReason' in end) p.resolve({ stopReason: end.stopReason as Parameters<Pending['resolve']>[0]['stopReason'] });
        else p.reject(new RequestError(-32603, `the turn ended without an answer: ${end.error.message}`, { code: end.error.code }));
      }
      return;
    }
    if (b.deferred) {
      b.deferred.set('permission' in out ? out.permission.requestId : out.question.requestId, out);
      return;
    }
    this.ask(b, out, cx);
  }

  private async notify(cx: AgentContext, sessionId: string, update: SessionUpdate): Promise<void> {
    try {
      await cx.notify(methods.client.session.update, { sessionId, update });
    } catch {
      // The connection is going: nothing more to say.
    }
  }

  /** Ask the client a request its resolver names it for; its answer resolves it as the client (the lane checks, RQ-1). */
  private ask(b: Bound, out: Extract<AcpOut, { permission: unknown } | { question: unknown }>, cx: AgentContext): void {
    if ('question' in out && !(this.caps.elicitation as { form?: unknown } | null | undefined)?.form) return;
    const requestId = 'permission' in out ? out.permission.requestId : out.question.requestId;
    if (b.asking.has(requestId)) return;
    const ac = new AbortController();
    b.asking.set(requestId, ac);
    const opts = { cancellationSignal: ac.signal, stopWaitingOnCancel: true };
    void (async () => {
      try {
        let decision: Decision | undefined;
        if ('permission' in out) {
          const r = await cx.request(methods.client.session.requestPermission, { sessionId: b.key, toolCall: out.permission.toolCall, options: out.permission.options }, opts);
          // Cancelled: the editor's prompt was cancelled (its turn is interrupted, which cancels the request, RQ-2).
          if (r.outcome.outcome === 'selected') decision = permissionDecision(r.outcome.optionId);
        } else {
          const body = { questions: Object.keys(out.question.requestedSchema.properties).map((id) => ({ id, text: '' })) } as BodyOf<'request.opened'>;
          const r = (await cx.request(methods.client.elicitation.create, { sessionId: b.key, mode: 'form', message: out.question.message, requestedSchema: out.question.requestedSchema } as never, opts)) as { action: string; content?: Record<string, unknown> | null };
          if (r.action === 'accept') decision = questionDecision(body, r.content);
          else if (r.action === 'decline') decision = { kind: 'deny', message: 'declined in the editor' };
        }
        if (!decision || ac.signal.aborted) return;
        const res = await this.k.lanes.command({ type: 'resolve', sessionKey: b.key, requestId, decision }, this.origin);
        if (!res.ok) this.k.log('info', `ACP client ${this.c.name}: its answer to ${requestId} was not taken: ${res.code}`);
      } catch {
        // Withdrawn (someone answered first), or the connection went.
      } finally {
        b.asking.delete(requestId);
      }
    })();
  }

  // ---- prompts --------------------------------------------------------------------------

  private bound(sessionId: string): Bound {
    const b = this.sessions.get(sessionId);
    if (!b) throw RequestError.sessionNotFound(sessionId);
    return b;
  }

  private async prompt(sessionId: string, blocks: ContentBlock[]): Promise<{ stopReason: 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens' | 'max_turn_requests' }> {
    const b = this.bound(sessionId);
    try {
      if (!mayInput(this.c, ENDPOINT, b.key)) throw new PeerRefusal('forbidden', `session ${b.key} is not in your input scope`);
      const rate = this.prompts.take(this.c.name, this.cfg.limits.promptsPerMinute);
      if (!rate.ok) throw new PeerRefusal('rate_limited', `rate limited: at most ${this.cfg.limits.promptsPerMinute} prompts per minute; retry in ${Math.ceil(rate.retryMs / 1000)} s`);
      const content = await this.content(blocks);
      checkText(content, this.cfg.limits.maxTextChars);
      const inputId = `acp_${randomUUID()}`;
      // Waiting before the input goes in: its turn may start (and end) before the lane answers.
      const done = new Promise<Parameters<Pending['resolve']>[0]>((resolve, reject) => b.prompts.set(inputId, { resolve, reject }));
      this.own.add(inputId);
      try {
        const r = await peerInput(this.k, this.c, ENDPOINT, { sessionKey: b.key, ...(b.agent !== undefined ? { agent: b.agent } : {}), inputId, content });
        if (r.disposition === 'observe_only') {
          b.prompts.delete(inputId);
          throw new PeerRefusal('denied', 'kept as context only: the loop guard stopped it (too many turns started from outside without a person writing in this session; policy.loopGuard.pair)');
        }
      } catch (e) {
        b.prompts.delete(inputId);
        throw e;
      }
      return await done;
    } catch (e) {
      throw rpcError(e);
    }
  }

  /** A prompt's blocks as an input's content: text, images (put in the blob store), links and embedded text resources as text. */
  private async content(blocks: ContentBlock[]): Promise<AioBlock[]> {
    const out: AioBlock[] = [];
    for (const x of blocks) {
      switch (x.type) {
        case 'text':
          out.push({ type: 'text', text: x.text });
          break;
        case 'image':
          out.push(await inlineImage(this.k, x.data, x.mimeType));
          break;
        case 'resource_link':
          out.push({ type: 'text', text: `[${x.title ?? x.name}](${x.uri})` });
          break;
        case 'resource': {
          const r = x.resource as { uri: string; text?: string };
          if (typeof r.text !== 'string') throw new PeerRefusal('invalid', `embedded resource ${r.uri}: only text resources are taken`);
          out.push({ type: 'text', text: `[resource ${r.uri}]\n${r.text}` });
          break;
        }
        default:
          throw new PeerRefusal('invalid', `a ${(x as { type: string }).type} block is not taken (text, image, resource_link, text resource)`);
      }
    }
    return out;
  }

  /** `session/cancel`: the client's own prompts in the session stop; a turn someone else started is not touched (CT-1). */
  private async cancel(sessionId: string): Promise<void> {
    const b = this.sessions.get(sessionId);
    if (!b) return;
    for (const [id, p] of [...b.prompts]) {
      if (p.turnId !== undefined) {
        await this.interrupt(b, p.turnId);
        continue;
      }
      // Still queued: answered now; its turn is interrupted when it starts.
      p.cancelled = true;
      p.resolve({ stopReason: 'cancelled' });
      b.prompts.set(id, { ...p, resolve: () => {}, reject: () => {} });
    }
  }

  private async interrupt(b: Bound, turnId: string): Promise<void> {
    try {
      const r = await this.k.lanes.command({ type: 'interrupt', sessionKey: b.key, turnId }, this.origin);
      if (!r.ok) this.k.log('info', `ACP client ${this.c.name}: interrupt of ${turnId} in ${b.key} refused: ${r.code}`);
    } catch (e) {
      this.k.log('warn', `ACP client ${this.c.name}: interrupt of ${turnId} in ${b.key} failed: ${(e as Error).message}`);
    }
  }
}

// ---- aio acp ----------------------------------------------------------------------------

/** A usage or configuration error of `aio acp` (exit 2), not authorized (77), the daemon not there (69). */
class AcpCliError extends Error {
  constructor(
    readonly exit: number,
    message: string,
  ) {
    super(message);
  }
}

/** A client token from a file only its owner can read. */
function readClientToken(path: string): string {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new AcpCliError(2, `no token file at ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new AcpCliError(2, `${path} is owned by uid ${st.uid}, not ${uid}`);
  if (st.mode & 0o077) throw new AcpCliError(2, `${path} is accessible to other users (mode ${(st.mode & 0o777).toString(8)}); refusing to use it`);
  return readFileSync(path, 'utf8').trim();
}

/** `aio acp`: ACP on stdio, piped to the daemon's ACP server over its local socket. */
async function acpCli(a: ModuleCliArgs): Promise<number> {
  try {
    const client = typeof a.options.client === 'string' ? a.options.client : a.env.AIO_ACP_CLIENT;
    if (!client) throw new AcpCliError(2, 'acp: --client <name> is required (a client of acpServer.clients; or $AIO_ACP_CLIENT)');
    const file = typeof a.options['token-file'] === 'string' ? a.options['token-file'] : undefined;
    const token = file !== undefined ? readClientToken(file) : a.env.AIO_ACP_TOKEN;
    if (!token) throw new AcpCliError(2, 'acp: the client token: --token-file <path> (its acpServer.clients.<name>.tokenFile) or $AIO_ACP_TOKEN');
    const session = typeof a.options.session === 'string' ? a.options.session : undefined;
    return await acpPipe({ socket: a.socket(), client, token, ...(session !== undefined ? { session } : {}), input: process.stdin, output: process.stdout });
  } catch (e) {
    if (e instanceof AcpCliError) {
      process.stderr.write(`aio acp: ${e.message}\n`);
      return e.exit;
    }
    throw e;
  }
}

/**
 * Connect to the daemon's socket as an ACP client of `acpServer` and pipe `input` to it and what it
 * answers to `output`, until either side ends: 0 when `input` ended (the editor closed it), 69 when
 * the daemon closed the connection or is not there, 77 when the client or its token is refused, 2
 * for a daemon without the ACP server (the section off).
 */
export function acpPipe(o: { socket: string; client: string; token: string; session?: string; input: NodeJS.ReadableStream; output: NodeJS.WritableStream; error?: (msg: string) => void }): Promise<number> {
  const say = o.error ?? ((m: string) => void process.stderr.write(`aio acp: ${m}\n`));
  return new Promise((resolve) => {
    const sock = createConnection(o.socket);
    // The editor going away (its end of stdout closed) ends the connection, not the process with an unhandled error.
    o.output.on('error', () => sock.destroy());
    let accepted = false;
    let inputEnded = false;
    let buf = Buffer.alloc(0);
    const done = (code: number) => {
      resolve(code);
    };
    sock.once('error', (e) => {
      if (!accepted) {
        say(`cannot reach the daemon at ${o.socket}: ${(e as NodeJS.ErrnoException).code ?? e.message} (is aio serve running?)`);
        done(69);
      }
    });
    sock.once('connect', () => {
      const hello: AcpHello = { client: o.client, token: o.token, ...(o.session !== undefined ? { session: o.session } : {}) };
      sock.write(encodeFrame({ v: AIO_PROTOCOL_VERSION, type: 'module.connect', id: 'connect', module: acpServerModule.id, hello }));
    });
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      sock.off('data', onData);
      const line = buf.subarray(0, nl).toString('utf8');
      const rest = buf.subarray(nl + 1);
      let r: { ok?: boolean; error?: { code?: string; message?: string } };
      try {
        r = JSON.parse(line);
      } catch {
        r = { ok: false, error: { code: 'bad_answer', message: 'the daemon answered something that is not JSON' } };
      }
      if (r.ok !== true) {
        const code = r.error?.code;
        say(code === 'unsupported' ? 'this daemon does not run the ACP server (acpServer in its config)' : `refused: ${code ?? 'error'}: ${r.error?.message ?? ''}`);
        sock.destroy();
        return done(code === 'unauthorized' ? 77 : code === 'unsupported' ? 2 : 1);
      }
      accepted = true;
      sock.on('error', () => {});
      if (rest.length) o.output.write(rest);
      sock.pipe(o.output, { end: false });
      o.input.pipe(sock);
      o.input.once('end', () => {
        inputEnded = true;
        sock.end();
      });
      sock.once('close', () => {
        o.input.unpipe(sock);
        done(inputEnded ? 0 : 69);
      });
    };
    sock.on('data', onData);
    sock.once('close', () => {
      if (!accepted) done(69);
    });
  });
}
