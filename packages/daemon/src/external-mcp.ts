import { randomUUID } from 'node:crypto';
import {
  formatAddress,
  routeKey,
  type AdminSession,
  type ChannelAdapter,
  type ContentBlock,
  type ExternalSender,
  type InputRecord,
  type Origin,
  type ReplyRoute,
  type RouteExplanation,
  type SessionEvent,
  type Tier,
  type TurnContext,
} from '@agents-io/protocol';
import { LaneUnavailableError, passes, project, type DeliveryRecord, type Hub, type Lane, type Outbox } from '@agents-io/session';
import { ExternalMcpServer, ToolError, type ExternalBackend, type ExternalCaller, type ExternalClient } from '@agents-io/host-mcp';
import type { ExternalMcpConfig } from './config.js';
import type { LogFn, Outcome } from './gateway.js';
import type { HostService } from './host.js';
import { TokenError, loadOrCreateTokenFile } from './token.js';

/*
 * The daemon side of the external MCP endpoint (docs/design/external-mcp): what its
 * clients' tool calls do. Every write is stamped by the daemon with the client's own
 * principal (kind `peer`, never a person), asked of the host that declared the `external`
 * hook, and recorded: a send in the client's own log (`external:<client>`) and in the
 * outbound records (`explain <operationId>` names the client); an input with a cause, a
 * routing record, and the lane's loop guard like any agent's input.
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

export interface ExternalMcpDeps {
  config: ExternalMcpConfig;
  /** The host token: no client may use it. */
  hostToken: string;
  hub: Hub;
  outbox: Outbox;
  host: Pick<HostService, 'externalHeldBy' | 'answers' | 'externalCallout'>;
  /** The outbound check of an external send (gateway: a host answering `outbound` decides; else the client's scope is the local allowance). */
  outbound(from: TurnContext, to: ReplyRoute): Promise<'allow' | 'deny'>;
  sessions(): AdminSession[];
  explain(id: string, chain: boolean): Outcome;
  status(): unknown;
  channelFor(route: ReplyRoute): { adapter: ChannelAdapter; account: string } | undefined;
  noChannelMessage(route: ReplyRoute): string;
  /** A session this daemon has run or registered (not a log of deliveries). */
  isSession(key: string): boolean;
  /** The session's lane (opened if closed); throws LaneUnavailableError. */
  lane(key: string): Promise<Lane>;
  agentOf(key: string): string | undefined;
  /** The routing record of an input (explain). */
  record(e: RouteExplanation & { at: number }): void;
  /** Remember who sends `operationId` until its delivery settles (the outbound record names them). */
  sending(operationId: string, by: ExternalSender | undefined): void;
  stopped(): boolean;
  log: LogFn;
  /** Tests: an ephemeral port. */
  port?: number;
}

/** The endpoint and what its tools do. */
export class ExternalMcp implements ExternalBackend {
  readonly server: ExternalMcpServer;
  private readonly inFlight = new Set<string>();

  constructor(private readonly d: ExternalMcpDeps) {
    const clients = d.config.clients.map((c): ExternalClient => {
      const token = c.token ?? tokenFromFile(c.name, c.tokenFile!, d.log);
      if (token === d.hostToken) throw new TokenError(`externalMcp.clients.${c.name}: its token is the host token; give every client its own`);
      return { name: c.name, token, principal: c.principal, scopes: c.scopes, declare: c.declare };
    });
    this.server = new ExternalMcpServer({
      clients,
      backend: this,
      host: d.config.host,
      port: d.port ?? d.config.port,
      limits: d.config.limits,
      log: (level: 'info' | 'warn', msg: string) => d.log(level, msg),
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
    return this.d.sessions().map((s) => ({ ...s, ...(s.agent !== undefined ? { address: formatAddress({ agent: s.agent, sessionKey: s.sessionKey }) } : {}) }));
  }

  events(sessionKey: string, a: { fromSeq?: number; tier: Tier; limit: number }): { head: number; events: unknown[]; nextFromSeq?: number } | undefined {
    const log = this.d.hub.log;
    const head = log.head(sessionKey);
    if (head === 0 && !this.d.isSession(sessionKey)) return undefined;
    const all = log.read(sessionKey, a.fromSeq ?? 0).filter((e) => passes(e, a.tier));
    const picked = a.fromSeq === undefined ? all.slice(-a.limit) : all.slice(0, a.limit);
    const events = picked.map((e) => view(project(e, a.tier)));
    // Paging forward: the next call passes the last seq seen (or the same from_seq when nothing new came).
    const next = picked.at(-1)?.seq ?? a.fromSeq;
    return { head, events, ...(next !== undefined ? { nextFromSeq: next } : {}) };
  }

  explain(id: string, chain: boolean): unknown {
    const r = this.d.explain(id, chain);
    if (!r.ok) throw new ToolError(`${r.code}: ${r.message}`);
    return r.value;
  }

  status(): unknown {
    return this.d.status();
  }

  // ---- writes -----------------------------------------------------------------------------

  /** The host that declared the `external` hook decides every write; it being away, or failing, denies. */
  private async hostAllows(caller: ExternalCaller, a: { op: 'send' | 'input'; route?: ReplyRoute; sessionKey?: string; content: ContentBlock[]; id: string }): Promise<void> {
    const held = this.d.host.externalHeldBy();
    if (held !== undefined) {
      this.d.log('warn', `external MCP: host ${held} decides external writes and is not connected: ${caller.client.name} ${a.op} denied`);
      throw new ToolError(`denied: the host that decides external writes (${held}) is not connected; try again later`);
    }
    if (!this.d.host.answers('external')) return;
    let v;
    try {
      v = await this.d.host.externalCallout({ ...senderOf(caller), op: a.op, ...(a.route ? { route: a.route } : {}), ...(a.sessionKey !== undefined ? { sessionKey: a.sessionKey } : {}), content: a.content, id: a.id });
    } catch (e) {
      this.d.log('warn', `external MCP: host external callout for ${caller.client.name} ${a.op} failed (${(e as Error).message}); denied`);
      throw new ToolError('denied: the host did not answer whether this is allowed; try again later');
    }
    if (v.verdict !== 'allow') throw new ToolError(`denied by the host${v.reason ? `: ${v.reason}` : ''}`);
  }

  async send(caller: ExternalCaller, a: { route: ReplyRoute; text: string; operationId?: string }): Promise<unknown> {
    if (this.d.stopped()) throw new ToolError('the daemon is stopping; try again later');
    const name = caller.client.name;
    const operationId = `${externalLog(name)}:${a.operationId ?? randomUUID()}`;
    const settled = this.d.outbox.get(operationId);
    if (settled) return sent(settled, true);
    if (this.inFlight.has(operationId)) throw new ToolError(`operation ${operationId} is being sent now; explain it later to see how it ended`);
    const ch = this.d.channelFor(a.route);
    if (!ch) throw new ToolError(this.d.noChannelMessage(a.route));
    // A single-entry fallback sends as that entry's account (as a host deliver does).
    const route: ReplyRoute = { ...a.route, account: ch.account };
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
        verdict = await this.d.outbound(from, route);
      } catch {
        verdict = 'deny';
      }
      if (verdict !== 'allow') {
        this.d.log('warn', `external MCP: ${name} send to ${routeKey(route)} denied by the outbound policy`);
        throw new ToolError(`destination ${routeKey(route)} is not allowed by the outbound policy`);
      }
      const by = senderOf(caller);
      const rec: ExternalSendRecord = { ...by, tool: 'send_message', operationId, route, text: a.text };
      this.d.hub.append(externalLog(name), {
        ts: Date.now(),
        level: 'primary',
        audience: 'answer',
        durability: 'durable',
        visibility: 'participants',
        body: { t: 'native', name: EXTERNAL_EVENT },
        native: rec,
      });
      this.d.sending(operationId, by);
      let d: DeliveryRecord;
      try {
        d = await this.d.outbox.send(ch.adapter, { operationId, sessionKey: externalLog(name), route, msg: { text: a.text } });
      } finally {
        this.d.sending(operationId, undefined);
      }
      if (d.status !== 'delivered') throw new ToolError(`delivery to ${routeKey(route)} ${d.status}${d.error ? `: ${d.error}` : ''} (operationId ${operationId})`);
      return sent(d, false);
    } finally {
      this.inFlight.delete(operationId);
    }
  }

  async input(caller: ExternalCaller, a: { sessionKey: string; text: string }): Promise<unknown> {
    if (this.d.stopped()) throw new ToolError('the daemon is stopping; try again later');
    const key = a.sessionKey;
    if (key.startsWith('run:')) throw new ToolError(`${key} is a task run session: it takes no inputs from outside its run`);
    // Logs of deliveries (`host:<name>`, `external:<client>`) are not sessions; nor is a key nobody has used.
    if (key.startsWith('host:') || key.startsWith('external:') || !this.d.isSession(key)) throw new ToolError(`no session ${key} (sessions_list shows the keys)`);
    const name = caller.client.name;
    const inputId = `ext_${randomUUID()}`;
    const content: ContentBlock[] = [{ type: 'text', text: a.text }];
    await this.hostAllows(caller, { op: 'input', sessionKey: key, content, id: inputId });
    let lane: Lane;
    try {
      lane = await this.d.lane(key);
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
    const agent = this.d.agentOf(key);
    this.d.record({
      inputId,
      tableVersions: [],
      matched: [{ bindingId: externalLog(name), source: 'config', on: 'dispatch', ...(agent !== undefined ? { agent } : {}), sessionKey: key }],
      principal: origin.principal!.id,
      evidence: origin.evidence,
      at: Date.now(),
      cause: input.cause!,
    });
    const r = await lane.command({ type: 'input', sessionKey: key, input, mode: 'queue' });
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
function tokenFromFile(client: string, file: string, log: LogFn): string {
  try {
    const r = loadOrCreateTokenFile(file);
    log('info', r.created ? `external MCP: token of client ${client} generated and written to ${file}` : `external MCP: token of client ${client} read from ${file}`);
    return r.token;
  } catch (e) {
    throw new TokenError(`externalMcp.clients.${client}.tokenFile: ${(e as Error).message}`);
  }
}

/** What a send answers: where it went and the operationId to explain. */
function sent(r: DeliveryRecord, duplicate: boolean) {
  if (r.status !== 'delivered') throw new ToolError(`delivery to ${routeKey(r.route)} ${r.status}${r.error ? `: ${r.error}` : ''} (operationId ${r.operationId})`);
  return { ok: true, delivered: routeKey(r.route), operationId: r.operationId, ...(r.providerMessageId !== undefined ? { messageId: r.providerMessageId } : {}), ...(duplicate ? { duplicate: true } : {}) };
}

/** An event as session_events shows it. */
function view(e: SessionEvent): unknown {
  return { seq: e.seq, ts: e.ts, ...(e.turnId !== undefined ? { turnId: e.turnId } : {}), level: e.level, audience: e.audience, body: e.body, ...(e.native !== undefined ? { native: e.native } : {}) };
}
