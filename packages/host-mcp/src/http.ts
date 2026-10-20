import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** 127.0.0.0/8 and ::1. */
export function isLoopback(host: string): boolean {
  if (host === '::1') return true;
  const v4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host);
  return v4 !== null && v4[1] === '127';
}

/** A request refused before the MCP server sees it. */
export interface McpRefusal {
  status: number;
  error: string;
  headers?: Record<string, string>;
}

export interface McpHttpEndpointOptions<A> {
  /** Listen address (default 127.0.0.1); anything but a loopback address is refused. */
  host?: string;
  /** Default 0: an ephemeral port. */
  port?: number;
  /** URL path of the endpoint (default `/mcp`); every other path answers 404. */
  path?: string;
  /** Who the request is, from its headers; undefined answers 401. */
  authenticate(req: IncomingMessage): A | undefined;
  /** After authentication, before the body is read: a refusal (e.g. a rate limit), or undefined to go on. */
  admit?(auth: A, req: IncomingMessage): McpRefusal | undefined;
  /** A fresh MCP server for one request, bound to who sent it (stateless: nothing is kept between requests). */
  build(auth: A, req: IncomingMessage): McpServer;
  /**
   * Read the body here, at most this many bytes (413 beyond), and hand it to the transport
   * parsed. Absent: the SDK reads it with its own limit.
   */
  maxBodyBytes?: number;
  /**
   * Refuse browser requests (any `Origin` header: MCP clients send none) and `Host` headers
   * that are not a loopback name (DNS rebinding). Off by default.
   */
  localOnly?: boolean;
  /** A refused request (401, 403, 405, 413, 429 …), for the caller's log. */
  onRefused?(r: McpRefusal, req: IncomingMessage): void;
}

/**
 * One MCP endpoint over Streamable HTTP, stateless: every POST builds a fresh MCP
 * server for its sender and answers with JSON (no session id, no standalone SSE
 * stream: GET and DELETE answer 405, which the transport spec allows). Bound to
 * loopback only: bearer tokens travel in clear text. Used by the host MCP server
 * (harness sessions' output tools) and the daemon's external MCP endpoint.
 */
export class McpHttpEndpoint<A> {
  private http: Server | undefined;
  private base: string | undefined;

  constructor(private readonly o: McpHttpEndpointOptions<A>) {}

  async listen(): Promise<string> {
    if (this.base) return this.base;
    const bind = this.o.host ?? '127.0.0.1';
    if (!isLoopback(bind)) throw new Error(`MCP endpoint: host ${JSON.stringify(bind)} is not a loopback address (use 127.0.0.1 or ::1)`);
    const http = createServer((req, res) => void this.handle(req, res));
    http.on('clientError', (_e, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(this.o.port ?? 0, bind, () => {
        http.off('error', reject);
        resolve();
      });
    });
    http.unref();
    this.http = http;
    const a = http.address() as AddressInfo;
    const host = a.family === 'IPv6' ? `[${a.address}]` : a.address;
    this.base = `http://${host}:${a.port}${this.o.path ?? '/mcp'}`;
    return this.base;
  }

  /** The endpoint URL (after `listen`). */
  get url(): string {
    if (!this.base) throw new Error('MCP endpoint is not listening');
    return this.base;
  }

  async close(): Promise<void> {
    const h = this.http;
    this.http = undefined;
    this.base = undefined;
    if (!h) return;
    h.closeAllConnections?.();
    await new Promise<void>((r) => h.close(() => r()));
  }

  private refuse(req: IncomingMessage, res: ServerResponse, r: McpRefusal): void {
    this.o.onRefused?.(r, req);
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) }).end(JSON.stringify({ error: r.error }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path !== (this.o.path ?? '/mcp')) {
      res.writeHead(404).end();
      return;
    }
    if (this.o.localOnly) {
      if (req.headers.origin !== undefined) return this.refuse(req, res, { status: 403, error: 'browser requests (with an Origin header) are not accepted' });
      if (!loopbackHostHeader(req.headers.host)) return this.refuse(req, res, { status: 403, error: 'unexpected Host header' });
    }
    const auth = this.o.authenticate(req);
    if (auth === undefined) return this.refuse(req, res, { status: 401, error: 'invalid or missing bearer token', headers: { 'www-authenticate': 'Bearer' } });
    if (req.method !== 'POST') {
      // Stateless: no standalone SSE stream and no sessions to delete.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const refused = this.o.admit?.(auth, req);
    if (refused) return this.refuse(req, res, refused);
    let body: unknown;
    if (this.o.maxBodyBytes !== undefined) {
      const r = await readBody(req, this.o.maxBodyBytes);
      if (!r.ok) return this.refuse(req, res, r.refusal);
      body = r.body;
    }
    let server: McpServer;
    try {
      server = this.o.build(auth, req);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await (body !== undefined ? transport.handleRequest(req, res, body) : transport.handleRequest(req, res));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
    }
  }
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

function readBody(req: IncomingMessage, max: number): Promise<{ ok: true; body: unknown } | { ok: false; refusal: McpRefusal }> {
  const tooLarge = { ok: false as const, refusal: { status: 413, error: `the request body is larger than ${max} bytes`, headers: { connection: 'close' } } };
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    return Promise.resolve(tooLarge);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const onData = (c: Buffer) => {
      n += c.length;
      if (n <= max) return void chunks.push(c);
      // Answered now; the rest is read and dropped (the connection closes after the answer).
      req.off('data', onData);
      req.resume();
      resolve(tooLarge);
    };
    req.on('data', onData);
    req.once('error', () => resolve({ ok: false, refusal: { status: 400, error: 'the request body could not be read' } }));
    req.once('end', () => {
      if (n > max) return;
      try {
        resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, refusal: { status: 400, error: 'the request body is not JSON' } });
      }
    });
  });
}
