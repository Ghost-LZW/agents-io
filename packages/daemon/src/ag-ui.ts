import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Type, type Static, type TObject } from '@sinclair/typebox';
import type { ContentBlock, KernelContext, ModuleManifest, ModuleResolveContext } from '@agents-io/protocol';
import { isLoopback } from '@agents-io/host-mcp';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { AgUiProjection, type AgUiEvent } from './ag-ui-projection.js';
import { ExternalView } from './external-view.js';
import { PeerRefusal, PeerTokens, RateWindow, checkText, inlineImage, mayRead, peerClientSchema, peerInput, resolveListen, resolvePeerClients, sessionFor, type PeerClient } from './peers.js';

/*
 * The AG-UI endpoint (core-slimming G9, north; POSITIONING §9.3): a session of this daemon as an
 * AG-UI agent over HTTP and server-sent events (docs.ag-ui.com; `@ag-ui/core`), for a web UI
 * (CopilotKit and others: `HttpAgent` from `@ag-ui/client`). Off unless the section `agUi` is in the
 * config; loopback only; every client has its own token (`Authorization: Bearer`) and scopes, as the
 * external MCP endpoint's (`peers.ts`). `POST /ag-ui` with a `RunAgentInput`: the thread is a session
 * (`threadId`: a session key in the client's scopes, else one of the client's own), the last user
 * message is an input stamped as the client (`peer`, never a person, ID-10), and the answer is an
 * SSE stream of the turn that takes it (`ag-ui-projection.ts`, through the U20 gate of
 * `external-view.ts`). `GET /ag-ui/threads/<threadId>/events?fromSeq=<seq>` (or `Last-Event-ID`):
 * every turn of the session from that seq on, each a run of its own; each event's SSE `id` is the
 * seq of the session event it shows. A browser's request (an `Origin` header) only from `origins`.
 * No approvals: an AG-UI client answers no request (requests show as `CUSTOM` events).
 */

const ENDPOINT = 'ag-ui' as const;
const FEATURE = 'ag-ui';
const PATH = '/ag-ui';
export const DEFAULT_AG_UI_PORT = 7466;
/** A comment line this often, so proxies and clients keep an idle stream open. */
const KEEPALIVE_MS = 15_000;

const Closed = { additionalProperties: false } as const;

/** The keys of the `agUi` section (the daemon adds `enabled`). */
const AgUiKeys = {
  /** `host:port` (default `127.0.0.1:7466`; port 0: any free port). Only loopback addresses. */
  listen: Type.Optional(Type.String()),
  /** Browser origins whose requests are taken (`http://localhost:3000`), with CORS; any other request with an `Origin` header answers 403. */
  origins: Type.Optional(Type.Array(Type.String())),
  clients: peerClientSchema(),
  limits: Type.Optional(
    Type.Object(
      {
        /** Largest request body (default 1 MiB: images come inline). */
        maxBodyBytes: Type.Optional(Type.Integer({ minimum: 1024 })),
        /** Longest input text (default 16000 characters). */
        maxTextChars: Type.Optional(Type.Integer({ minimum: 1 })),
        /** Requests per client per minute (default 120); more answer 429. */
        requestsPerMinute: Type.Optional(Type.Integer({ minimum: 1 })),
        /** Runs (inputs) per client per minute (default 20). */
        runsPerMinute: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      Closed,
    ),
  ),
};

/** The `agUi` section of the config file, as written. */
export type AgUiSection = Static<TObject<typeof AgUiKeys>> & { enabled?: boolean };

/** The AG-UI endpoint's settings, resolved. */
export interface AgUiConfig {
  host: string;
  port: number;
  origins: string[];
  clients: PeerClient[];
  limits: { maxBodyBytes: number; maxTextChars: number; requestsPerMinute: number; runsPerMinute: number };
}

const ORIGIN = /^https?:\/\/[^/\s]+$/;

/** The section's value as the endpoint's settings; errors name keys, never values. */
export function resolveAgUi(c: Omit<AgUiSection, 'enabled'>, ctx: Pick<ModuleResolveContext, 'substitute' | 'path' | 'valueAt' | 'fail'>): AgUiConfig {
  const { host, port } = resolveListen('agUi', c.listen ?? `127.0.0.1:${DEFAULT_AG_UI_PORT}`, ctx);
  const origins = c.origins ?? [];
  origins.forEach((o, i) => {
    if (!ORIGIN.test(o)) ctx.fail(`agUi.origins[${i}]: ${JSON.stringify(o)} is not an origin (scheme://host[:port], no path)`);
  });
  const l = c.limits ?? {};
  return {
    host,
    port,
    origins,
    clients: resolvePeerClients('agUi', c.clients, ctx),
    limits: { maxBodyBytes: l.maxBodyBytes ?? 1024 * 1024, maxTextChars: l.maxTextChars ?? 16_000, requestsPerMinute: l.requestsPerMinute ?? 120, runsPerMinute: l.runsPerMinute ?? 20 },
  };
}

/**
 * The AG-UI endpoint as a module: section `agUi` (off unless present; `enabled: false` turns it
 * off), feature `ag-ui` while it listens, status `{ url, clients }` while it listens. It starts
 * after the daemon's channels, socket and console; a bad client token fails the start, a port that
 * is taken is logged, not fatal. Its streams end when the daemon stops.
 */
export const agUiModule: ModuleManifest<AgUiConfig> = {
  id: 'ag-ui',
  kind: 'feature',
  config: {
    section: 'agUi',
    schema: AgUiKeys,
    defaultEnabled: false,
    resolve: (raw, ctx) => resolveAgUi(raw as Omit<AgUiSection, 'enabled'>, ctx),
  },
  features: [FEATURE],
  setup: (kernel, cfg) => {
    let listening: { endpoint: AgUiEndpoint; url: string } | undefined;
    return {
      start: async () => {
        const endpoint = new AgUiEndpoint(kernel, cfg);
        let url: string;
        try {
          url = await endpoint.listen();
        } catch (e) {
          kernel.log('error', `AG-UI endpoint not started: cannot listen on ${cfg.host}:${cfg.port}: ${(e as Error).message}`);
          return;
        }
        listening = { endpoint, url };
        kernel.log('info', `AG-UI endpoint on ${url} (clients: ${cfg.clients.map((x) => x.name).join(', ') || 'none'})`);
      },
      features: () => (listening ? [FEATURE] : []),
      status: () => (listening ? { url: listening.url, clients: cfg.clients.map((x) => x.name) } : undefined),
      stop: async () => {
        await listening?.endpoint.close();
      },
    };
  },
};

/** A request refused before any stream: its status and what the client reads. */
class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const REFUSAL_STATUS: Record<PeerRefusal['code'], number> = { forbidden: 403, not_found: 404, denied: 403, invalid: 400, rate_limited: 429, stopping: 503, unavailable: 503 };

/** The HTTP server and what its requests do. */
export class AgUiEndpoint {
  private http: Server | undefined;
  private base: string | undefined;
  private readonly tokens: PeerTokens;
  private readonly requests = new RateWindow();
  private readonly runs = new RateWindow();
  /** Open streams: ended when the endpoint closes. */
  private readonly streams = new Set<() => void>();
  private lastUnauthorizedLog = 0;

  constructor(
    private readonly k: KernelContext,
    private readonly cfg: AgUiConfig,
  ) {
    // The clients' tokens are read (or generated) here: a bad one fails the start.
    this.tokens = new PeerTokens('agUi', cfg.clients, k);
  }

  async listen(): Promise<string> {
    const http = createServer((req, res) => void this.handle(req, res));
    http.on('clientError', (_e, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(this.cfg.port, this.cfg.host, () => {
        http.off('error', reject);
        resolve();
      });
    });
    http.unref();
    this.http = http;
    const a = http.address() as AddressInfo;
    this.base = `http://${a.family === 'IPv6' ? `[${a.address}]` : a.address}:${a.port}${PATH}`;
    return this.base;
  }

  async close(): Promise<void> {
    for (const end of [...this.streams]) end();
    const h = this.http;
    this.http = undefined;
    if (!h) return;
    h.closeAllConnections?.();
    await new Promise<void>((r) => h.close(() => r()));
  }

  private cors(req: IncomingMessage): Record<string, string> {
    const o = req.headers.origin;
    if (o === undefined) return {};
    return { 'access-control-allow-origin': o, vary: 'Origin', 'access-control-allow-headers': 'authorization, content-type, accept, last-event-id', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  }

  private refuse(req: IncomingMessage, res: ServerResponse, r: HttpRefusal): void {
    if (r.status === 401) {
      // One line per 10 s at most: a client with a wrong token retries in a loop.
      if (Date.now() - this.lastUnauthorizedLog < 10_000) return void res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer', ...this.cors(req) }).end(JSON.stringify({ error: r.message }));
      this.lastUnauthorizedLog = Date.now();
    }
    this.k.log('warn', `AG-UI: ${req.method} refused ${r.status} (${r.message})`);
    res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers, ...this.cors(req) }).end(JSON.stringify({ error: r.message }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (path !== PATH && !path.startsWith(`${PATH}/`)) return void res.writeHead(404).end();
      // DNS rebinding: only a loopback name. A browser: only from the origins configured.
      if (!loopbackHostHeader(req.headers.host)) throw new HttpRefusal(403, 'unexpected Host header');
      const origin = req.headers.origin;
      if (origin !== undefined && !this.cfg.origins.includes(origin)) throw new HttpRefusal(403, 'browser requests from this origin are not accepted (agUi.origins)');
      if (req.method === 'OPTIONS') return void res.writeHead(204, this.cors(req)).end();
      const client = this.tokens.match(tokenOf(req));
      if (!client) throw new HttpRefusal(401, 'invalid or missing bearer token', { 'www-authenticate': 'Bearer' });
      const rate = this.requests.take(client.name, this.cfg.limits.requestsPerMinute);
      if (!rate.ok) throw new HttpRefusal(429, `rate limited: at most ${this.cfg.limits.requestsPerMinute} requests per minute`, { 'retry-after': String(Math.max(1, Math.ceil(rate.retryMs / 1000))) });
      if (this.k.stopping()) throw new HttpRefusal(503, 'the daemon is stopping; try again later');
      if (path === PATH) {
        if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST', ...this.cors(req) }).end();
        return await this.run(client, req, res);
      }
      const m = /^\/ag-ui\/threads\/([^/]+)\/events$/.exec(path);
      if (!m) return void res.writeHead(404).end();
      if (req.method !== 'GET') return void res.writeHead(405, { allow: 'GET', ...this.cors(req) }).end();
      return this.resume(client, decodeURIComponent(m[1]!), url, req, res);
    } catch (e) {
      if (e instanceof HttpRefusal) return this.refuse(req, res, e);
      if (e instanceof PeerRefusal) return this.refuse(req, res, new HttpRefusal(REFUSAL_STATUS[e.code], e.message, e.code === 'rate_limited' ? { 'retry-after': '60' } : {}));
      this.k.log('warn', `AG-UI: ${req.method} failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json', ...this.cors(req) }).end(JSON.stringify({ error: 'internal error' }));
      else res.end();
    }
  }

  /** `POST /ag-ui`: the last user message into the thread's session, and the run's events as SSE. */
  private async run(client: PeerClient, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, this.cfg.limits.maxBodyBytes);
    const parsed = RunAgentInputSchema.safeParse(raw);
    if (!parsed.success) throw new HttpRefusal(400, `not a RunAgentInput: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
    const input = parsed.data as RunAgentInput;
    const content = await this.content(input);
    checkText(content, this.cfg.limits.maxTextChars);
    const s = sessionFor(this.k, client, ENDPOINT, input.threadId, 'input');
    const runs = this.runs.take(client.name, this.cfg.limits.runsPerMinute);
    if (!runs.ok) throw new HttpRefusal(429, `rate limited: at most ${this.cfg.limits.runsPerMinute} runs per minute`, { 'retry-after': String(Math.max(1, Math.ceil(runs.retryMs / 1000))) });
    const inputId = `agui_${randomUUID()}`;
    // Watching before the input goes in (a snapshot first): its turn may start, and end, before the lane answers.
    const view = new ExternalView(this.k, s.key);
    let r;
    try {
      r = await peerInput(this.k, client, ENDPOINT, { sessionKey: s.key, ...(s.agent !== undefined ? { agent: s.agent } : {}), inputId, content });
    } catch (e) {
      view.close();
      throw e;
    }
    const p = new AgUiProjection({ threadId: input.threadId, runId: input.runId, inputId });
    const sse = this.open(req, res, () => view.close());
    sse.write(p.begin(), this.k.head(s.key));
    if (r.disposition === 'observe_only') {
      sse.write([{ type: EventType.RUN_ERROR, message: 'kept as context only: the loop guard stopped it (too many turns started from outside without a person writing in this session; policy.loopGuard.pair)', code: 'loop_guard' }], this.k.head(s.key));
      return sse.end();
    }
    // The run is the answer to the client's own input (a turn takes one principal's inputs, IN-3); the session's state is for a reader.
    const readable = mayRead(client, ENDPOINT, s.key);
    for await (const e of view) {
      if (sse.closed) break;
      sse.write(
        p.push(e).filter((x) => readable || x.type !== EventType.STATE_SNAPSHOT),
        e.seq,
      );
      if (p.finished) break;
    }
    sse.end();
  }

  /** `GET /ag-ui/threads/<threadId>/events`: every turn of the session from a seq on (a resume), until the client goes. */
  private resume(client: PeerClient, threadId: string, url: URL, req: IncomingMessage, res: ServerResponse): void {
    const s = sessionFor(this.k, client, ENDPOINT, threadId, 'read');
    if (!this.k.sessions.known(s.key) || !mayRead(client, ENDPOINT, s.key)) throw new HttpRefusal(404, `no session ${threadId}`);
    const given = url.searchParams.get('fromSeq') ?? req.headers['last-event-id'];
    const fromSeq = typeof given === 'string' && /^\d+$/.test(given) ? Number(given) : undefined;
    if (given !== undefined && fromSeq === undefined) throw new HttpRefusal(400, 'fromSeq (or Last-Event-ID) is a seq number');
    const view = new ExternalView(this.k, s.key, fromSeq !== undefined ? { fromSeq } : {});
    const p = new AgUiProjection({ threadId });
    const sse = this.open(req, res, () => view.close());
    void (async () => {
      for await (const e of view) {
        if (sse.closed) break;
        sse.write(p.push(e), e.seq);
      }
      sse.end();
    })();
  }

  /** The last user message's content: text, inline images (put in the blob store), image URLs as links. */
  private async content(input: RunAgentInput): Promise<ContentBlock[]> {
    const last = [...input.messages].reverse().find((m) => m.role === 'user');
    if (!last || last.role !== 'user') throw new HttpRefusal(400, 'the run has no user message (messages: the last one with role user is the input)');
    if (typeof last.content === 'string') return [{ type: 'text', text: last.content }];
    const out: ContentBlock[] = [];
    for (const part of last.content) {
      if (part.type === 'text') out.push({ type: 'text', text: part.text });
      else if (part.type === 'image' && part.source.type === 'data') out.push(await inlineImage(this.k, part.source.value, part.source.mimeType));
      else if (part.type === 'image' && part.source.type === 'url') out.push({ type: 'text', text: `[image](${part.source.value})` });
      else throw new HttpRefusal(400, `a ${part.type} part is not taken (text, image)`);
    }
    return out;
  }

  /** Start the SSE answer; `stop` runs when the client goes or the stream ends. */
  private open(req: IncomingMessage, res: ServerResponse, stop: () => void) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no', ...this.cors(req) });
    // Now, not with the first event: a resume from the head may have none for a while.
    res.flushHeaders();
    let closed = false;
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    keepalive.unref();
    const end = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      this.streams.delete(end);
      stop();
      res.end();
    };
    this.streams.add(end);
    res.on('close', end);
    return {
      get closed() {
        return closed;
      },
      write(events: AgUiEvent[], seq: number) {
        if (closed) return;
        for (const e of events) res.write(`id: ${seq}\ndata: ${JSON.stringify(e)}\n\n`);
      },
      end,
    };
  }
}

function tokenOf(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m?.[1];
}

/** `Host` names a loopback address or `localhost` (any port). */
function loopbackHostHeader(h: string | undefined): boolean {
  if (!h) return false;
  let name: string;
  try {
    name = new URL(`http://${h}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  return name === 'localhost' || isLoopback(name);
}

function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    return Promise.reject(new HttpRefusal(413, `the request body is larger than ${max} bytes`, { connection: 'close' }));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        over = true;
        return;
      }
      chunks.push(c);
    });
    req.once('error', () => reject(new HttpRefusal(400, 'the request body could not be read')));
    req.once('end', () => {
      if (over) return reject(new HttpRefusal(413, `the request body is larger than ${max} bytes`, { connection: 'close' }));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpRefusal(400, 'the request body is not JSON'));
      }
    });
  });
}
