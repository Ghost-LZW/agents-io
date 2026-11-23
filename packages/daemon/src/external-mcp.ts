import { randomUUID } from 'node:crypto';
import { Type, type Static, type TObject } from '@sinclair/typebox';
import {
  formatAddress,
  routeKey,
  type ContentBlock,
  type ExternalSender,
  type InputRecord,
  type KernelContext,
  type KernelSettledSend,
  type ModuleManifest,
  type ModuleResolveContext,
  type Origin,
  type Principal,
  type ReplyRoute,
  type SessionEvent,
  type Tier,
  type TurnContext,
} from '@agents-io/protocol';
import { LaneUnavailableError, OWNER_LABEL, passes, project } from '@agents-io/session';
import { ExternalMcpServer, ToolError, isLoopback, parseScope, type ExternalBackend, type ExternalCaller, type ExternalClient, type ExternalScopes } from '@agents-io/host-mcp';
import { TokenError, loadOrCreateTokenFile } from './token.js';

/*
 * The external MCP endpoint (docs/design/external-mcp) as a built-in feature module
 * (core-slimming G6 step 1; `bundle.ts` registers it, nothing else in the daemon imports it):
 * its config section `externalMcp`, its feature `external.mcp`, its status, and what its
 * clients' tool calls do. Every write is stamped here with the client's own principal (kind
 * `peer`, never a person), asked of the host that declared the `external` hook, and recorded:
 * a send in the client's own log (`external:<client>`) and in the outbound records (`explain
 * <operationId>` names the client); an input with a cause, a routing record, and the lane's
 * loop guard like any agent's input. What it reaches of the daemon is its `KernelContext`: the
 * outbound check of a send (`outbound`) and who sends it (`send`'s `external`) stay the kernel's.
 */

/** Native event recording one send by an external client, in the log `external:<client>`. */
export const EXTERNAL_EVENT = 'agents-io.external';

/** Log (pseudo-session) key of a client's sends: like a host's `host:<name>` deliveries. */
export const externalLog = (client: string) => `external:${client}`;

/** `native` payload of an `agents-io.external` event. */
export interface ExternalSendRecord extends ExternalSender {
  tool: 'send_message';
  operationId: string;
  route: ReplyRoute;
  text: string;
}

/** The origin every action of a client is stamped with: kind `peer` (an agent outside this daemon), its own principal, evidence `device_only` (a loopback connection with its token). */
export function externalOrigin(c: Pick<ExternalClient, 'name' | 'principal'>, declared?: string): Origin {
  return {
    kind: 'peer',
    principal: { id: c.principal.id, labels: [...c.principal.labels] },
    evidence: 'device_only',
    ...(declared !== undefined ? { declared } : {}),
    via: externalLog(c.name),
    adapter: 'external-mcp',
  };
}

/** Who sent, as records and explain name it. */
export const senderOf = (caller: ExternalCaller): ExternalSender => ({ client: caller.client.name, principal: caller.client.principal.id, ...(caller.declared !== undefined ? { declared: caller.declared } : {}) });

// ---- config -----------------------------------------------------------------------------

const Closed = { additionalProperties: false } as const;

/**
 * The keys of the `externalMcp` section (the daemon adds `enabled` and closes it): agents outside
 * this daemon (a Claude Code or Codex on the owner's machine, a host's proxy) read sessions and
 * send through it, each as its own client. Off unless the section is present (and `enabled` is
 * not false). Loopback only. Every client has its own token (`token: "env:NAME"`, or `tokenFile`:
 * read, or generated 0600 like `host.tokenFile`) and the scopes it may use; nothing else is
 * allowed (`read`, `read:<session pattern>`, `send:<route pattern>`, `input:<session pattern>`;
 * `*` matches any run of characters).
 */
const ExternalMcpKeys = {
  /** `host:port` (default `127.0.0.1:7465`; port 0: any free port). Only loopback addresses. */
  listen: Type.Optional(Type.String()),
  clients: Type.Record(
    Type.String(),
    Type.Object(
      {
        /** `env:NAME`: the variable holding the token (never a literal). */
        token: Type.Optional(Type.String()),
        /** A token file (relative to the config file): read when it exists, else generated (0600). */
        tokenFile: Type.Optional(Type.String()),
        scopes: Type.Array(Type.String()),
        /** The principal it acts as (default `external:<name>`); always `external:…`, never a person. */
        principal: Type.Optional(Type.String()),
        /** Extra principal labels (`external` is always there; `owner` is refused). */
        labels: Type.Optional(Type.Array(Type.String())),
        /** It may say whom it acts for (`X-Agents-IO-Declared` header), recorded as `origin.declared`. */
        declare: Type.Optional(Type.Boolean()),
      },
      Closed,
    ),
  ),
  limits: Type.Optional(
    Type.Object(
      {
        /** Largest request body (default 256 KiB). */
        maxBodyBytes: Type.Optional(Type.Integer({ minimum: 1024 })),
        /** Longest `text` of a send or an input (default 16000 characters). */
        maxTextChars: Type.Optional(Type.Integer({ minimum: 1 })),
        /** Requests per client per minute (default 120); more answer 429. */
        requestsPerMinute: Type.Optional(Type.Integer({ minimum: 1 })),
        /** Sends and inputs per client per minute (default 20). */
        writesPerMinute: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      Closed,
    ),
  ),
};

/** The `externalMcp` section of the config file, as written. */
export type ExternalMcpSection = Static<TObject<typeof ExternalMcpKeys>> & { enabled?: boolean };

/** One client of the external MCP endpoint, resolved. */
export interface ExternalMcpClient {
  /** Its name in `externalMcp.clients` (`[A-Za-z0-9._-]`, at most 64). */
  name: string;
  /** From `token: "env:NAME"`. SECRET: never log it. */
  token?: string;
  /** Absolute; read or generated when the endpoint starts. */
  tokenFile?: string;
  /** `external:<name>` unless configured (always `external:…`); labels always include `external`, never `owner`. */
  principal: Principal;
  scopes: ExternalScopes;
  /** May declare whom it acts for (`X-Agents-IO-Declared`). */
  declare: boolean;
}

/** The external MCP endpoint's settings, resolved (the module's config; `Config.externalMcp` too, deprecated). */
export interface ExternalMcpConfig {
  host: string;
  port: number;
  clients: ExternalMcpClient[];
  limits: { maxBodyBytes: number; maxTextChars: number; requestsPerMinute: number; writesPerMinute: number };
}

export const DEFAULT_EXTERNAL_MCP_PORT = 7465;
const CLIENT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const EXTERNAL_PRINCIPAL = /^external:[^\s]{1,128}$/;

/** The section's value (without `enabled`) as the endpoint's settings; errors name keys, never values. */
export function resolveExternalMcp(c: Omit<ExternalMcpSection, 'enabled'>, ctx: Pick<ModuleResolveContext, 'substitute' | 'path' | 'valueAt' | 'fail'>): ExternalMcpConfig {
  const fail = (msg: string): never => ctx.fail(msg);
  const owners = (ctx.valueAt('policy.owners') as string[] | undefined) ?? [];
  const listen = c.listen ?? `127.0.0.1:${DEFAULT_EXTERNAL_MCP_PORT}`;
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(listen);
  if (!m || Number(m[2]) > 65535) fail(`externalMcp.listen ${JSON.stringify(listen)} is not host:port`);
  const host = m![1]!.replace(/^\[|\]$/g, '');
  // Tokens are bearer credentials in clear text: never reachable off this machine.
  if (!isLoopback(host)) fail(`externalMcp.listen ${JSON.stringify(listen)}: the external MCP endpoint listens on a loopback address only (127.0.0.1 or ::1)`);
  const clients = Object.entries(c.clients).map(([name, e]): ExternalMcpClient => {
    const at = `externalMcp.clients.${name}`;
    if (!CLIENT_NAME.test(name)) fail(`externalMcp.clients: ${JSON.stringify(name)} is not a client name (letters, digits, . _ -, at most 64)`);
    if ((e.token === undefined) === (e.tokenFile === undefined)) fail(`${at}: give exactly one of token ("env:NAME") or tokenFile`);
    let token: string | undefined;
    if (e.token !== undefined) {
      if (!e.token.startsWith('env:')) fail(`${at}.token must be "env:NAME" (a literal token does not belong in the config; or use tokenFile)`);
      token = ctx.substitute(e.token, `${at}.token`) as string;
      if (token.length < 16 || /\s/.test(token)) fail(`${at}.token: the variable ${e.token.slice(4)} must hold at least 16 characters and no whitespace`);
    }
    const scopes: ExternalScopes = { read: [], readAll: false, send: [], input: [] };
    e.scopes.forEach((x, i) => {
      const p = parseScope(x);
      if (!p) fail(`${at}.scopes[${i}]: ${JSON.stringify(x)} is not a scope (read, read:<session pattern>, send:<route pattern>, input:<session pattern>)`);
      scopes[p!.kind].push(p!.pattern);
      if (x === 'read') scopes.readAll = true;
    });
    const id = e.principal ?? `external:${name}`;
    if (!EXTERNAL_PRINCIPAL.test(id)) fail(`${at}.principal must be "external:<id>" (an external client is never a person, an agent or a host)`);
    if (owners.includes(id)) fail(`${at}.principal is an owner: an external client is never a person`);
    const labels = [...new Set(['external', ...(e.labels ?? [])])];
    if (labels.includes(OWNER_LABEL)) fail(`${at}.labels: an external client never carries the ${OWNER_LABEL} label`);
    return {
      name,
      ...(token !== undefined ? { token } : {}),
      ...(e.tokenFile !== undefined ? { tokenFile: ctx.path(e.tokenFile) } : {}),
      principal: { id, labels },
      scopes,
      declare: e.declare === true,
    };
  });
  const files = clients.map((x) => x.tokenFile).filter((f): f is string => f !== undefined);
  if (new Set(files).size !== files.length) fail('externalMcp.clients: two clients name the same tokenFile');
  const l = c.limits ?? {};
  return {
    host,
    port: Number(m![2]),
    clients,
    limits: { maxBodyBytes: l.maxBodyBytes ?? 256 * 1024, maxTextChars: l.maxTextChars ?? 16_000, requestsPerMinute: l.requestsPerMinute ?? 120, writesPerMinute: l.writesPerMinute ?? 20 },
  };
}

// ---- the module -------------------------------------------------------------------------

/** The `host.hello` feature it advertises while the endpoint listens. */
const FEATURE = 'external.mcp';

/**
 * The external MCP endpoint as a module: section `externalMcp` (off unless present, `enabled: false`
 * turns it off), feature `external.mcp` while it listens, status `{ url, clients }` while it listens
 * (`bundle.ts` keeps it at `GET /api/status` `externalMcp` too). It starts after the daemon's
 * channels, local socket and console; a bad client token or token file fails the start, a port that
 * is taken is logged, not fatal (as for the console). It stops before anything else (`bundle.ts`
 * registers it last): no new external writes while the daemon stops.
 */
export const externalMcpModule: ModuleManifest<ExternalMcpConfig> = {
  id: 'external-mcp',
  kind: 'feature',
  config: {
    section: 'externalMcp',
    schema: ExternalMcpKeys,
    defaultEnabled: false,
    resolve: (raw, ctx) => resolveExternalMcp(raw as Omit<ExternalMcpSection, 'enabled'>, ctx),
  },
  features: [FEATURE],
  setup: (kernel, cfg) => {
    let listening: { endpoint: ExternalMcp; url: string } | undefined;
    return {
      start: async () => {
        // The clients' tokens are read (or generated) here: a bad one fails the start.
        const endpoint = new ExternalMcp(kernel, cfg);
        let url: string;
        try {
          url = await endpoint.listen();
        } catch (e) {
          kernel.log('error', `external MCP endpoint not started: cannot listen on ${cfg.host}:${cfg.port}: ${(e as Error).message}`);
          return;
        }
        listening = { endpoint, url };
        kernel.log('info', `external MCP endpoint on ${url} (clients: ${cfg.clients.map((x) => x.name).join(', ') || 'none'})`);
      },
      features: () => (listening ? [FEATURE] : []),
      status: () => (listening ? { url: listening.url, clients: cfg.clients.map((x) => x.name) } : undefined),
      // No new external writes while stopping (the tools also answer "stopping").
      stop: async () => {
        await listening?.endpoint.close();
      },
    };
  },
};

/** The endpoint and what its tools do. */
export class ExternalMcp implements ExternalBackend {
  readonly server: ExternalMcpServer;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly k: KernelContext,
    config: ExternalMcpConfig,
  ) {
    const clients = config.clients.map((c): ExternalClient => {
      const token = c.token ?? tokenFromFile(c.name, c.tokenFile!, k);
      if (k.host.isToken(token)) throw new TokenError(`externalMcp.clients.${c.name}: its token is the host token; give every client its own`);
      return { name: c.name, token, principal: c.principal, scopes: c.scopes, declare: c.declare };
    });
    this.server = new ExternalMcpServer({
      clients,
      backend: this,
      host: config.host,
      port: config.port,
      limits: config.limits,
      log: (level: 'info' | 'warn', msg: string) => k.log(level, msg),
    });
  }

  listen(): Promise<string> {
    return this.server.listen();
  }

  close(): Promise<void> {
    return this.server.close();
  }

  // ---- reads ------------------------------------------------------------------------------

  sessions(): { sessionKey: string; [k: string]: unknown }[] {
    return this.k.sessions.list().map((s) => ({ ...s, ...(s.agent !== undefined ? { address: formatAddress({ agent: s.agent, sessionKey: s.sessionKey }) } : {}) }));
  }

  events(sessionKey: string, a: { fromSeq?: number; tier: Tier; limit: number }): { head: number; events: unknown[]; nextFromSeq?: number } | undefined {
    const head = this.k.head(sessionKey);
    if (head === 0 && !this.k.sessions.known(sessionKey)) return undefined;
    const all = this.k.events(sessionKey, a.fromSeq ?? 0).filter((e) => passes(e, a.tier));
    const picked = a.fromSeq === undefined ? all.slice(-a.limit) : all.slice(0, a.limit);
    const events = picked.map((e) => view(project(e, a.tier)));
    // Paging forward: the next call passes the last seq seen (or the same from_seq when nothing new came).
    const next = picked.at(-1)?.seq ?? a.fromSeq;
    return { head, events, ...(next !== undefined ? { nextFromSeq: next } : {}) };
  }

  explain(id: string, chain: boolean): unknown {
    const r = this.k.explain(id, chain);
    if (!r.ok) throw new ToolError(`${r.code}: ${r.message}`);
    return r.value;
  }

  status(): unknown {
    const st = this.k.status();
    return { channels: st.channels, host: st.host, agents: st.agents, sessions: st.sessions };
  }

  // ---- writes -----------------------------------------------------------------------------

  /** The host that declared the `external` hook decides every write; it being away, or failing, denies. */
  private async hostAllows(caller: ExternalCaller, a: { op: 'send' | 'input'; route?: ReplyRoute; sessionKey?: string; content: ContentBlock[]; id: string }): Promise<void> {
    const held = this.k.host.heldBy('external');
    if (held !== undefined) {
      this.k.log('warn', `external MCP: host ${held} decides external writes and is not connected: ${caller.client.name} ${a.op} denied`);
      throw new ToolError(`denied: the host that decides external writes (${held}) is not connected; try again later`);
    }
    if (!this.k.host.answers('external')) return;
    let v;
    try {
      v = await this.k.host.external({ ...senderOf(caller), op: a.op, ...(a.route ? { route: a.route } : {}), ...(a.sessionKey !== undefined ? { sessionKey: a.sessionKey } : {}), content: a.content, id: a.id });
    } catch (e) {
      this.k.log('warn', `external MCP: host external callout for ${caller.client.name} ${a.op} failed (${(e as Error).message}); denied`);
      throw new ToolError('denied: the host did not answer whether this is allowed; try again later');
    }
    if (v.verdict !== 'allow') throw new ToolError(`denied by the host${v.reason ? `: ${v.reason}` : ''}`);
  }

  async send(caller: ExternalCaller, a: { route: ReplyRoute; text: string; operationId?: string }): Promise<unknown> {
    if (this.k.stopping()) throw new ToolError('the daemon is stopping; try again later');
    const name = caller.client.name;
    const operationId = `${externalLog(name)}:${a.operationId ?? randomUUID()}`;
    const settled = this.k.settled(operationId);
    if (settled) return sent(operationId, settled, true);
    if (this.inFlight.has(operationId)) throw new ToolError(`operation ${operationId} is being sent now; explain it later to see how it ended`);
    const to = this.k.resolveRoute(a.route);
    if (!to.ok) throw new ToolError(to.message);
    // A single-entry fallback sends as that entry's account (as a host deliver does).
    const route = to.route;
    const content: ContentBlock[] = [{ type: 'text', text: a.text }];
    this.inFlight.add(operationId);
    try {
      await this.hostAllows(caller, { op: 'send', route, content, id: operationId });
      const origin = externalOrigin(caller.client, caller.declared);
      // The outbound check sees the request as a one-input turn of the client's own log: who asks, what, to where.
      const from: TurnContext = {
        sessionKey: externalLog(name),
        turnId: operationId,
        run: { harness: 'external', model: 'external', profile: 'restricted' },
        inputs: [{ inputId: operationId, origin, content, replyRoute: null, channelContext: { channel: 'external-mcp', client: name } }],
        replyRoute: null,
        deliveries: [],
      };
      let verdict: 'allow' | 'deny';
      try {
        verdict = await this.k.outbound(from, route);
      } catch {
        verdict = 'deny';
      }
      if (verdict !== 'allow') {
        this.k.log('warn', `external MCP: ${name} send to ${routeKey(route)} denied by the outbound policy`);
        throw new ToolError(`destination ${routeKey(route)} is not allowed by the outbound policy`);
      }
      const by = senderOf(caller);
      const rec: ExternalSendRecord = { ...by, tool: 'send_message', operationId, route, text: a.text };
      this.k.appendNative(externalLog(name), { name: EXTERNAL_EVENT, native: rec, level: 'primary', audience: 'answer', visibility: 'participants' });
      // The kernel keeps who sends it while the delivery runs (its outbound record names them, also when it settles after a restart).
      const d = await this.k.send(route, { text: a.text }, { operationId, sessionKey: externalLog(name), external: by });
      // The channel stopped since the route was resolved.
      if (!d) throw new ToolError(`delivery to ${routeKey(route)} rejected: no running channel sends it (operationId ${operationId})`);
      if (d.status !== 'delivered') throw new ToolError(`delivery to ${routeKey(route)} ${d.status}${d.error ? `: ${d.error}` : ''} (operationId ${operationId})`);
      return sent(operationId, { ...d, route }, false);
    } finally {
      this.inFlight.delete(operationId);
    }
  }

  async input(caller: ExternalCaller, a: { sessionKey: string; text: string }): Promise<unknown> {
    if (this.k.stopping()) throw new ToolError('the daemon is stopping; try again later');
    const key = a.sessionKey;
    if (key.startsWith('run:')) throw new ToolError(`${key} is a task run session: it takes no inputs from outside its run`);
    // Logs of deliveries (`host:<name>`, `external:<client>`) are not sessions; nor is a key nobody has used.
    if (key.startsWith('host:') || key.startsWith('external:') || !this.k.sessions.known(key)) throw new ToolError(`no session ${key} (sessions_list shows the keys)`);
    const name = caller.client.name;
    const inputId = `ext_${randomUUID()}`;
    const content: ContentBlock[] = [{ type: 'text', text: a.text }];
    await this.hostAllows(caller, { op: 'input', sessionKey: key, content, id: inputId });
    try {
      await this.k.lanes.open(key);
    } catch (e) {
      throw new ToolError(e instanceof LaneUnavailableError ? `${e.code}: ${e.message}` : (e as Error).message);
    }
    const origin = externalOrigin(caller.client, caller.declared);
    const input: InputRecord = {
      inputId,
      origin,
      content,
      // The answer stays in the session's log: the client reads it there (as a local end does).
      replyRoute: { channel: 'local', account: 'local', conversationId: key },
      // An agent outside this daemon: where it sits in a chain is unknown (the pair limit still counts it).
      cause: { peer: externalLog(name), basis: 'none' },
      channelContext: { channel: 'external-mcp', client: name },
    };
    const agent = this.k.sessions.agentOf(key);
    this.k.router.record({
      inputId,
      tableVersions: [],
      matched: [{ bindingId: externalLog(name), source: 'config', on: 'dispatch', ...(agent !== undefined ? { agent } : {}), sessionKey: key }],
      principal: origin.principal!.id,
      evidence: origin.evidence,
      at: Date.now(),
      cause: input.cause!,
    });
    const r = await this.k.lanes.input(key, input, 'queue');
    if (!r.ok) throw new ToolError(`the session refused the input: ${r.reason}`);
    return {
      ok: true,
      session: key,
      inputId,
      disposition: r.disposition,
      note: r.disposition === 'observe_only' ? 'kept as context only: the loop guard stopped it (too many turns started from outside without a person writing here)' : 'queued; read the answer with session_events (tier final)',
    };
  }
}

/** A client's token from its file (read, or generated 0600 like `host.tokenFile`). */
function tokenFromFile(client: string, file: string, k: KernelContext): string {
  try {
    const r = loadOrCreateTokenFile(file);
    k.log('info', r.created ? `external MCP: token of client ${client} generated and written to ${file}` : `external MCP: token of client ${client} read from ${file}`);
    return r.token;
  } catch (e) {
    throw new TokenError(`externalMcp.clients.${client}.tokenFile: ${(e as Error).message}`);
  }
}

/** What a send answers: where it went and the operationId to explain. */
function sent(operationId: string, r: KernelSettledSend, duplicate: boolean) {
  if (r.status !== 'delivered') throw new ToolError(`delivery to ${routeKey(r.route)} ${r.status}${r.error ? `: ${r.error}` : ''} (operationId ${operationId})`);
  return { ok: true, delivered: routeKey(r.route), operationId, ...(r.providerMessageId !== undefined ? { messageId: r.providerMessageId } : {}), ...(duplicate ? { duplicate: true } : {}) };
}

/** An event as session_events shows it. */
function view(e: SessionEvent): unknown {
  return { seq: e.seq, ts: e.ts, ...(e.turnId !== undefined ? { turnId: e.turnId } : {}), level: e.level, audience: e.audience, body: e.body, ...(e.native !== undefined ? { native: e.native } : {}) };
}
