import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ADMIN_WS_BEARER_PREFIX,
  ADMIN_WS_PATH,
  ADMIN_WS_SUBPROTOCOL,
  AdminConfigPut,
  AdminConfigValidateRequest,
  AdminLarkBotRequest,
  AdminLoginRequest,
  PROTOCOL_VERSION,
  check,
  errors,
  type AdminError,
  type AdminExplain,
  type AdminLoginResult,
  type AdminQueue,
  type AdminSessions,
  type AdminStatus,
  type Origin,
} from '@agents-io/protocol';
import { isLoopbackHost, isWildcardHost, type ConsoleConfig } from './config.js';
import type { ConfigStore } from './console-config.js';
import type { LogFn } from './gateway.js';
import { FrameConn, type FrameTransport, type LocalHost } from './local-server.js';
import type { LarkBotJobs } from './provision.js';

/*
 * The console API (packages/protocol/src/admin.ts): HTTP endpoints under
 * `/api` and the WebSocket `/ws`, for web UIs built against the protocol only.
 *
 * - Listens on loopback unless the config allows otherwise (config.ts refuses
 *   a non-loopback host without `console.allowRemote`).
 * - Auth: `Authorization: Bearer <token>` (the daemon's host token, or a
 *   console session token), for `/ws` the subprotocol pair
 *   `[ADMIN_WS_SUBPROTOCOL, ADMIN_WS_BEARER_PREFIX + token]`, or the session
 *   cookie a login sets (HttpOnly, SameSite=Strict, Path=/). Explicit
 *   credentials (header, then subprotocol) win over the cookie. A login link
 *   carries a one-time token (5 min, single use) that `POST /api/login`
 *   exchanges for a session (cookie + token in the body). Login links are made
 *   with the host token only (`POST /api/login-link`, what `aio console-link`
 *   calls after `POST /api/console-proof` showed it talks to this daemon).
 * - Cookies are not port-scoped: a browser sends the console cookie to every
 *   server on the same host name, whatever its port, and any of them can
 *   replay it. The cookie name carries a random per-daemon instance id (so
 *   daemons on one host do not clobber each other), and a session only works
 *   through the `Host` it logged in with; still, non-browser clients and
 *   separately hosted UIs should keep the session token themselves and send it
 *   as a bearer token or the subprotocol, not rely on the cookie.
 * - Requests with an `Origin` other than the console's own or a configured one
 *   are refused (403); the configured ones get CORS headers (no credentials:
 *   a separately hosted UI uses bearer tokens). Requests whose `Host` is not
 *   the console's (DNS rebinding) are refused too.
 * - `/ws` speaks exactly the local socket's frames: client frames as the
 *   console principal (the local owner, via `console`), host frames after
 *   `host.hello` with the host token.
 */

/** Prefix of the session cookie's name; the full name adds the daemon's instance id (`ConsoleServer.cookieName`). */
export const CONSOLE_COOKIE_PREFIX = 'aio_console_';
/** What `POST /api/console-proof` answers: HMAC-SHA256(host token, PROOF_LABEL + challenge), base64url. */
export const consoleProof = (hostToken: string, challenge: string) => createHmac('sha256', hostToken).update(`aio-console-proof:${challenge}`).digest('base64url');
const ProofRequest = Type.Object({ challenge: Type.String({ minLength: 16, maxLength: 256 }) });
const LOGIN_TTL_MS = 5 * 60_000;
const MAX_BODY = 4 * 1024 * 1024;
const WS_HIGH_WATER = 4 * 1024 * 1024;
const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' };

/** What the console needs from the daemon. */
export interface ConsoleHost {
  /** For `/ws` connections (the same as the local socket's). */
  readonly local: LocalHost;
  /** The daemon's host token. */
  readonly token: string;
  status(): AdminStatus;
  queue(): AdminQueue;
  sessions(): AdminSessions;
  explain(inputId: string): AdminExplain | undefined;
  /** Origin of a console connection's client frames. */
  consoleOrigin(sessionKey: string): Origin;
  /** Absent: the daemon was started without a config file path (`/api/config*` answer 404). */
  readonly configStore?: ConfigStore;
  readonly larkBots?: LarkBotJobs;
}

type Role = 'host' | 'session';

/** One-time login tokens and console sessions, in memory (gone at restart). Stored hashed. */
export class ConsoleAuth {
  private readonly logins = new Map<string, number>();
  private readonly sessions = new Map<string, { exp: number; host?: string }>();
  private readonly host: Buffer;

  constructor(
    hostToken: string,
    private readonly sessionTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.host = Buffer.from(hostToken);
  }

  /** A fresh one-time login token. */
  loginToken(): { token: string; expiresAt: number } {
    this.sweep();
    const token = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + LOGIN_TTL_MS;
    this.logins.set(hash(token), expiresAt);
    return { token, expiresAt };
  }

  /** Exchange a one-time token (single use) for a session, bound to the `Host` it was made through. */
  login(loginToken: string, host?: string): AdminLoginResult | undefined {
    const k = hash(loginToken);
    const exp = this.logins.get(k);
    this.logins.delete(k);
    if (exp === undefined || exp <= this.now()) return undefined;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sessions.set(hash(token), { exp: expiresAt, ...(host !== undefined ? { host: host.toLowerCase() } : {}) });
    return { token, expiresAt };
  }

  /** Who a token is (presented through `host`): the host, a live session, or nobody (with why). */
  check(token: string | undefined, host?: string): { ok: true; role: Role } | { ok: false; why: string } {
    if (!token) return { ok: false, why: 'missing credentials (Authorization: Bearer <token>, the console cookie, or the bearer subprotocol)' };
    const given = Buffer.from(token);
    if (given.length === this.host.length && timingSafeEqual(given, this.host)) return { ok: true, role: 'host' };
    const k = hash(token);
    const s = this.sessions.get(k);
    if (s === undefined) return { ok: false, why: 'wrong token' };
    if (s.exp <= this.now()) {
      this.sessions.delete(k);
      return { ok: false, why: 'session expired; open a new login link (aio console-link)' };
    }
    if (s.host !== undefined && host?.toLowerCase() !== s.host) return { ok: false, why: 'this session was made through another Host; log in through this one' };
    return { ok: true, role: 'session' };
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, exp] of this.logins) if (exp <= t) this.logins.delete(k);
    for (const [k, s] of this.sessions) if (s.exp <= t) this.sessions.delete(k);
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ConsoleServerOptions {
  config: ConsoleConfig;
  host: ConsoleHost;
  log: LogFn;
  now?: () => number;
}

export class ConsoleServer {
  readonly auth: ConsoleAuth;
  /** The session cookie's name: random per daemon start. */
  readonly cookieName = CONSOLE_COOKIE_PREFIX + randomBytes(8).toString('hex');
  private server: Server | undefined;
  private readonly wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(ADMIN_WS_SUBPROTOCOL) ? ADMIN_WS_SUBPROTOCOL : false) });
  private readonly conns = new Set<FrameConn>();
  private address: AddressInfo | undefined;

  constructor(private readonly o: ConsoleServerOptions) {
    this.auth = new ConsoleAuth(o.host.token, o.config.sessionTtlMs, o.now);
  }

  /** `http://host:port` once listening. */
  get url(): string {
    const a = this.address;
    if (!a) throw new Error('console is not listening');
    // A wildcard bind is reached locally through loopback; remote users get `uiUrl` / allowedHosts names.
    const addr = isWildcardHost(a.address) ? (a.family === 'IPv6' ? '::1' : '127.0.0.1') : a.address;
    const host = addr.includes(':') ? `[${addr}]` : addr;
    return `http://${host}:${a.port}`;
  }

  /** Where login links point: the configured UI, else the console itself. */
  get uiUrl(): string {
    return this.o.config.uiUrl ?? this.url;
  }

  async listen(): Promise<void> {
    const c = this.o.config;
    if (!isLoopbackHost(c.host)) this.o.log('warn', `console listening on ${c.host}, which is not loopback (console.allowRemote): anyone who can reach it and has a token controls this daemon`);
    const server = createServer((req, res) => void this.onRequest(req, res));
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    server.on('clientError', (_e, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(c.port, c.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.address = server.address() as AddressInfo;
  }

  close(reason: string): void {
    for (const c of [...this.conns]) c.end(reason);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = undefined;
  }

  /** The `Host` header names this server (anti DNS-rebinding): a loopback name, the configured (concrete) host, or one of `allowedHosts`. */
  private hostOk(req: IncomingMessage): boolean {
    const h = req.headers.host;
    if (!h) return false;
    let name: string;
    try {
      name = new URL(`http://${h}`).hostname;
    } catch {
      return false;
    }
    const bare = name.replace(/^\[|\]$/g, '').toLowerCase();
    const c = this.o.config;
    if (isLoopbackHost(bare) || c.allowedHosts.includes(bare)) return true;
    return !isWildcardHost(c.host) && bare === c.host.replace(/^\[|\]$/g, '').toLowerCase();
  }

  /** undefined: no Origin (not a browser, or same-origin GET); 'self'; 'allowed' (configured, gets CORS); 'forbidden'. */
  private originKind(req: IncomingMessage): 'none' | 'self' | 'allowed' | 'forbidden' {
    const origin = req.headers.origin;
    if (origin === undefined) return 'none';
    if (this.o.config.origins.includes(origin)) return 'allowed';
    try {
      const u = new URL(origin);
      if (u.protocol === 'http:' && u.host === req.headers.host) return 'self';
    } catch {
      // not a URL
    }
    return 'forbidden';
  }

  /** The credentials presented: the Authorization header, else the `/ws` bearer subprotocol, else the cookie. */
  private credentials(req: IncomingMessage, bearer?: string): string | undefined {
    const a = req.headers.authorization;
    if (a) {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(a);
      return m ? m[1] : '';
    }
    return bearer ?? cookie(req, this.cookieName);
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const kind = this.originKind(req);
    try {
      if (!this.hostOk(req)) throw new HttpError(403, 'forbidden', 'unexpected Host header');
      if (kind === 'forbidden') throw new HttpError(403, 'forbidden', `origin ${req.headers.origin} is not allowed (console.origins)`);
      if (kind === 'allowed') {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin!);
        res.setHeader('Vary', 'Origin');
      }
      const url = new URL(req.url ?? '/', 'http://console');
      if (req.method === 'OPTIONS') {
        if (kind !== 'allowed') throw new HttpError(403, 'forbidden', 'CORS preflight from an origin that is not allowed');
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return page(res);
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', `no ${url.pathname}`);
      const out = await this.route(req, res, url);
      send(res, out.status, out.body);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal', (e as Error).message);
      if (err.status === 500) this.o.log('error', `console ${req.method} ${req.url}: ${err.message}`);
      send(res, err.status, { error: { code: err.code, message: err.message } } satisfies AdminError);
    }
  }

  private authorize(req: IncomingMessage): Role {
    const r = this.auth.check(this.credentials(req), req.headers.host);
    if (!r.ok) throw new HttpError(401, 'unauthorized', r.why);
    return r.role;
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<{ status: number; body: unknown }> {
    const h = this.o.host;
    const m = req.method;
    const p = url.pathname;
    if (m === 'POST' && p === '/api/login') {
      const body = await readJson(req, AdminLoginRequest);
      const r = this.auth.login(body.loginToken, req.headers.host);
      if (!r) throw new HttpError(401, 'unauthorized', 'the login token is wrong, used or expired; open a new login link (aio console-link)');
      const maxAge = Math.max(1, Math.floor((r.expiresAt - Date.now()) / 1000));
      res.setHeader('Set-Cookie', `${this.cookieName}=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
      return { status: 200, body: r };
    }
    // Lets `aio console-link` check it talks to this daemon before it sends the host token.
    if (m === 'POST' && p === '/api/console-proof') {
      const body = await readJson(req, ProofRequest);
      return { status: 200, body: { proof: consoleProof(h.token, body.challenge) } };
    }
    const role = this.authorize(req);
    if (m === 'POST' && p === '/api/login-link') {
      if (role !== 'host') throw new HttpError(403, 'forbidden', 'login links are made with the host token only');
      const t = this.auth.loginToken();
      return { status: 200, body: { url: `${this.uiUrl}/#login=${t.token}`, consoleUrl: this.url, expiresAt: t.expiresAt } };
    }
    if (m === 'GET' && p === '/api/status') return { status: 200, body: h.status() };
    if (m === 'GET' && p === '/api/queue') return { status: 200, body: h.queue() };
    if (m === 'GET' && p === '/api/sessions') return { status: 200, body: h.sessions() };
    if (m === 'GET' && p.startsWith('/api/explain/')) {
      const id = param(p, '/api/explain/');
      const e = h.explain(id);
      if (!e) throw new HttpError(404, 'unknown_input', `no routing record for ${id} (unknown, or older than the retention)`);
      return { status: 200, body: e };
    }
    if (p === '/api/config' || p === '/api/config/validate') {
      const store = h.configStore;
      if (!store) throw new HttpError(404, 'not_found', 'this daemon was started without a config file');
      if (m === 'GET' && p === '/api/config') return { status: 200, body: store.document() };
      if (m === 'POST' && p === '/api/config/validate') return { status: 200, body: store.validate((await readJson(req, AdminConfigValidateRequest)).config) };
      if (m === 'PUT' && p === '/api/config') {
        const body = await readJson(req, AdminConfigPut);
        const r = store.put(body.config, body.ifRevision);
        if (r.status === 409) throw new HttpError(409, r.code, r.message);
        if (r.status === 200) this.o.log('info', `console: config written (revision ${r.body.revision}, ${r.body.applied === 'restart' ? 'restart required' : 'unchanged'})`);
        return { status: r.status, body: r.body };
      }
    }
    if (p === '/api/bots/lark' || p.startsWith('/api/bots/lark/')) {
      const jobs = h.larkBots;
      if (!jobs) throw new HttpError(404, 'not_found', 'bot provisioning needs a config file');
      if (m === 'POST' && p === '/api/bots/lark') {
        const r = jobs.start(await readJson(req, AdminLarkBotRequest));
        if (!r.ok) throw new HttpError(r.status, r.code, r.message);
        return { status: 202, body: { job: r.job } };
      }
      if (m === 'GET' && p.startsWith('/api/bots/lark/')) {
        const id = param(p, '/api/bots/lark/');
        const j = jobs.get(id);
        if (!j) throw new HttpError(404, 'unknown_job', `no provisioning job ${id}`);
        return { status: 200, body: j };
      }
    }
    throw new HttpError(404, 'not_found', `no ${m} ${p}`);
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, code: string, message: string) => {
      const body = JSON.stringify({ error: { code, message } });
      socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    };
    const url = new URL(req.url ?? '/', 'http://console');
    if (url.pathname !== ADMIN_WS_PATH) return refuse(404, 'not_found', `no WebSocket at ${url.pathname}`);
    if (!this.hostOk(req)) return refuse(403, 'forbidden', 'unexpected Host header');
    if (this.originKind(req) === 'forbidden') return refuse(403, 'forbidden', `origin ${req.headers.origin} is not allowed (console.origins)`);
    const protocols = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const bearer = protocols.find((p) => p.startsWith(ADMIN_WS_BEARER_PREFIX))?.slice(ADMIN_WS_BEARER_PREFIX.length);
    if (protocols.length && !protocols.includes(ADMIN_WS_SUBPROTOCOL)) return refuse(400, 'invalid_request', `subprotocol ${ADMIN_WS_SUBPROTOCOL} is required`);
    const r = this.auth.check(this.credentials(req, bearer), req.headers.host);
    if (!r.ok) return refuse(401, 'unauthorized', r.why);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
  }

  private onSocket(ws: WebSocket): void {
    const transport: FrameTransport = {
      write: (f) => {
        if (ws.readyState !== ws.OPEN) return false;
        ws.send(JSON.stringify(f));
        return ws.bufferedAmount < WS_HIGH_WATER;
      },
      drained: async () => {
        while (ws.readyState === ws.OPEN && ws.bufferedAmount >= WS_HIGH_WATER) await new Promise((r) => setTimeout(r, 20));
      },
      get gone() {
        return ws.readyState !== ws.OPEN;
      },
      end: () => ws.close(1001, 'closing'),
    };
    const c = new FrameConn(transport, this.o.host.local, () => this.conns.delete(c), { origin: (key) => this.o.host.consoleOrigin(key) });
    this.conns.add(c);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return void c.send({ v: PROTOCOL_VERSION, type: 'result', id: '', ok: false, error: { code: 'bad_json', message: 'frames are text messages' } });
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return void c.send({ v: PROTOCOL_VERSION, type: 'result', id: '', ok: false, error: { code: 'bad_json', message: 'message is not JSON' } });
      }
      c.receive(raw);
    });
    ws.on('close', () => c.drop());
    ws.on('error', () => c.drop());
  }
}

function param(path: string, prefix: string): string {
  try {
    return decodeURIComponent(path.slice(prefix.length));
  } catch {
    throw new HttpError(400, 'invalid_request', 'bad URL encoding');
  }
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

async function readJson<S extends TSchema>(req: IncomingMessage, schema: S): Promise<Static<S>> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw new HttpError(400, 'invalid_request', 'the body must be application/json');
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new HttpError(400, 'invalid_request', `the body is larger than ${MAX_BODY} bytes`);
    chunks.push(c as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_request', 'the body is not JSON');
  }
  if (!check(schema, body)) throw new HttpError(400, 'invalid_request', errors(schema, body).slice(0, 3).join('; '));
  return body;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

/**
 * `GET /`: a minimal landing page. A login link opened here (`/#login=<token>`)
 * is exchanged for the session cookie; then it shows the status. The real UI is
 * a separate app (`console.uiUrl`).
 */
function page(res: ServerResponse): void {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>aio console</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;max-width:60rem}pre{background:#f4f4f4;padding:1rem;overflow:auto}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}pre{background:#222}}</style></head>
<body><h1>aio console</h1><p id="m">This is the daemon's console API (see packages/protocol/src/admin.ts).</p><pre id="s"></pre>
<script>
(async () => {
  const m = document.getElementById('m'), s = document.getElementById('s');
  const t = new URLSearchParams(location.hash.slice(1)).get('login');
  if (t) {
    history.replaceState(null, '', location.pathname);
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginToken: t }) });
    m.textContent = r.ok ? 'Logged in.' : 'Login failed: ' + (await r.json()).error.message;
  }
  const r = await fetch('/api/status');
  s.textContent = r.ok ? JSON.stringify(await r.json(), null, 2) : 'Not logged in: open a login link (aio console-link).';
})();
</script></body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}
