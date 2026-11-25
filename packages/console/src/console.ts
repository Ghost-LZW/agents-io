import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ADMIN_ENDPOINTS,
  ADMIN_WS_BEARER_PREFIX,
  ADMIN_WS_PATH,
  ADMIN_WS_SUBPROTOCOL,
  type AdminEndpoint,
  AdminBackendKeyRequest,
  AdminConfigPut,
  AdminConfigValidateRequest,
  AdminLoginRequest,
  PROTOCOL_VERSION,
  check,
  errors,
  type AdminError,
  type AdminLoginResult,
} from '@agents-io/protocol';
import {
  FrameConn,
  NO_REGISTRIES,
  adminContributions,
  isLoopbackHost,
  isWildcardHost,
  type ChannelRegistry,
  type ConsoleServerOptions,
  type ContributedRoute,
  type FrameTransport,
  type HarnessRegistry,
} from '@agents-io/kernel';

/*
 * The console API (packages/protocol/src/admin.ts): HTTP endpoints under
 * `/api` and the WebSocket `/ws`, for web UIs built against the protocol only.
 * What it serves is the daemon's (`ConsoleHost`, `@agents-io/kernel`'s
 * console-host.ts). Modules add routes of their own (`AdminContribution.routes`,
 * packages/protocol/src/admin-module.ts), handed in as `ConsoleHost.routes` and
 * served after the core ones with the same auth; the gateway's are its channel
 * types' (lark-bot's bot provisioning) and its harness kinds'.
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
/** How long a closed /ws connection may take to answer the close frame before its socket is dropped. */
const WS_CLOSE_GRACE_MS = 1000;
const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' };

/**
 * Every admin HTTP endpoint for clients and route tables of a console over `channels` and
 * `harnesses` (default none): the core ones (`ADMIN_ENDPOINTS`), then the routes the registered
 * channel types contribute, then the harness kinds' (`AdminContribution.routes`, without their
 * handlers; `adminContributions`), in registration order. The gateway's console serves these over
 * its registries (and `POST /api/login-link`, `POST /api/console-proof` for `aio console-link`).
 */
export function adminEndpoints(channels: ChannelRegistry, harnesses: HarnessRegistry = NO_REGISTRIES.harnessRegistry): AdminEndpoint[] {
  return [...ADMIN_ENDPOINTS, ...adminContributions(harnesses, channels).flatMap(({ admin }) => (admin.routes ?? []).map(({ handle: _handle, ...endpoint }) => endpoint))];
}

/**
 * A contributed route with its path as a pattern: a `:name` segment matches one segment, and one
 * that ends the path the rest of it, `/` included (as the core's `/api/explain/:inputId` takes it).
 */
interface CompiledRoute extends ContributedRoute {
  pattern: RegExp;
  names: string[];
}

function compileRoute(r: ContributedRoute): CompiledRoute {
  const names: string[] = [];
  const segments = r.route.path.split('/');
  const source = segments
    .map((x, i) => {
      if (!x.startsWith(':')) return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(x.slice(1));
      return i === segments.length - 1 ? '(.*)' : '([^/]+)';
    })
    .join('/');
  return { ...r, pattern: new RegExp(`^${source}$`), names };
}

type Role = 'host' | 'session' | 'backend';
type Checked = { ok: true; role: 'host' | 'session' } | { ok: true; role: 'backend'; backend: string } | { ok: false; why: string };

/** One-time login tokens and console sessions, in memory (gone at restart). Stored hashed. */
export class ConsoleAuth {
  private readonly logins = new Map<string, number>();
  private readonly sessions = new Map<string, { exp: number; host?: string }>();
  private readonly host: Buffer;

  constructor(
    hostToken: string,
    private readonly sessionTtlMs: number,
    private readonly now: () => number = Date.now,
    /** The backend whose key a token is (PB-1); absent: no token is a backend's. */
    private readonly backendOf?: (token: string) => string | undefined,
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

  /** Who a token is (presented through `host`): the host, a backend (its key), a live session, or nobody (with why). */
  check(token: string | undefined, host?: string): Checked {
    if (!token) return { ok: false, why: 'missing credentials (Authorization: Bearer <token>, the console cookie, or the bearer subprotocol)' };
    const given = Buffer.from(token);
    if (given.length === this.host.length && timingSafeEqual(given, this.host)) return { ok: true, role: 'host' };
    const backend = this.backendOf?.(token);
    if (backend !== undefined) return { ok: true, role: 'backend', backend };
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

/** The console API server over what the daemon gives it (`ConsoleServerOptions.host`); a `ConsoleListener` for the gateway. */
export class ConsoleServer {
  readonly auth: ConsoleAuth;
  /** The session cookie's name: random per daemon start. */
  readonly cookieName = CONSOLE_COOKIE_PREFIX + randomBytes(8).toString('hex');
  private server: Server | undefined;
  private readonly wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(ADMIN_WS_SUBPROTOCOL) ? ADMIN_WS_SUBPROTOCOL : false) });
  private readonly conns = new Set<FrameConn>();
  private address: AddressInfo | undefined;
  private readonly routes: CompiledRoute[];

  constructor(private readonly o: ConsoleServerOptions) {
    this.auth = new ConsoleAuth(o.host.token, o.config.sessionTtlMs, o.now, o.host.backendOf ? (token) => o.host.backendOf!(token) : undefined);
    this.routes = (o.host.routes ?? []).map(compileRoute);
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

  /** The admin credential behind a request: the host token or a console session. A backend's key is neither (PB-1, PB-3). */
  private authorize(req: IncomingMessage): 'host' | 'session' {
    const r = this.auth.check(this.credentials(req), req.headers.host);
    if (!r.ok) throw new HttpError(401, 'unauthorized', r.why);
    if (r.role === 'backend') throw new HttpError(403, 'forbidden', 'a backend key opens /ws only (host.hello with the key); the console API needs the host token or a console session');
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
    // PB-3: backend keys are managed with the admin credential (the host token or a console session).
    if (h.backends && m === 'GET' && p === '/api/backends') return { status: 200, body: h.backends.list() };
    const backend = h.backends && m === 'POST' ? /^\/api\/backends\/([^/]+)\/(key|forget)$/.exec(p) : null;
    if (h.backends && backend) {
      const id = decode(backend[1]!);
      const r = backend[2] === 'key' ? h.backends.key(id, (await readJson(req, AdminBackendKeyRequest)).op) : h.backends.forget(id);
      if (r.ok) return { status: 200, body: r.value };
      throw new HttpError(r.code === 'unknown_backend' ? 404 : r.code === 'key_exists' ? 409 : r.code === 'invalid_frame' ? 400 : 500, r.code === 'invalid_frame' ? 'invalid_request' : r.code, r.message);
    }
    if (p === '/api/config' || p === '/api/config/validate') {
      const store = h.configStore;
      if (!store) throw new HttpError(404, 'not_found', 'this daemon was started without a config file');
      if (m === 'GET' && p === '/api/config') return { status: 200, body: await store.document() };
      if (m === 'POST' && p === '/api/config/validate') return { status: 200, body: await store.validate((await readJson(req, AdminConfigValidateRequest)).config) };
      if (m === 'PUT' && p === '/api/config') {
        const body = await readJson(req, AdminConfigPut);
        const r = await store.put(body.config, body.ifRevision);
        if (r.status === 409) throw new HttpError(409, r.code, r.message);
        if (r.status !== 200) return { status: r.status, body: r.body };
        const live = await h.applyChannels?.();
        const res = live ? { ...r.body, applied: live.applied, channels: live.channels } : r.body;
        this.o.log('info', `console: config written (revision ${res.revision}, ${res.applied === 'restart' ? 'restart required' : live ? 'applied live' : 'unchanged'})`);
        return { status: 200, body: res };
      }
    }
    // What modules add, after the core routes and with their auth.
    for (const r of this.routes) {
      const match = r.route.method === m ? r.pattern.exec(p) : null;
      if (!match) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decode(match[i + 1]!)]));
      const body = r.route.body ? await readJson(req, r.route.body) : undefined;
      const out = await r.route.handle({ params, body }, r.ctx);
      return { status: out.status, body: out.body };
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
    const backend = r.role === 'backend' ? r.backend : undefined;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, backend));
  }

  /** `backend`: the connection was admitted with that backend's key; it speaks host frames only, as that backend (PB-1). */
  private onSocket(ws: WebSocket, backend?: string): void {
    // Frames handed to the socket and not yet written out by it; who waits for that (PR-2: `blob.get`).
    let unwritten = 0;
    const waiting: (() => void)[] = [];
    const release = () => {
      unwritten = 0;
      for (const w of waiting.splice(0)) w();
    };
    const written = () => {
      if (unwritten > 0 && --unwritten === 0) release();
    };
    ws.once('close', release);
    const transport: FrameTransport = {
      write: (f) => {
        if (ws.readyState !== ws.OPEN) return false;
        unwritten++;
        // The callback runs once the frame was written to the socket, or could not be.
        ws.send(JSON.stringify(f), written);
        return ws.bufferedAmount < WS_HIGH_WATER;
      },
      drained: async () => {
        while (ws.readyState === ws.OPEN && ws.bufferedAmount >= WS_HIGH_WATER) await new Promise((r) => setTimeout(r, 20));
      },
      // The high-water mark is several answers of `blob.get`: those wait for the socket to have taken the one before.
      flushed: () => (unwritten === 0 || ws.readyState !== ws.OPEN ? Promise.resolve() : new Promise<void>((r) => waiting.push(r))),
      get gone() {
        return ws.readyState !== ws.OPEN;
      },
      end: () => {
        ws.close(1001, 'closing');
        // A half-open peer (host takeover) never answers the close: drop the socket after a short grace.
        const t = setTimeout(() => ws.terminate(), WS_CLOSE_GRACE_MS);
        t.unref?.();
        ws.once('close', () => clearTimeout(t));
      },
    };
    const c = new FrameConn(transport, this.o.host.local, () => this.conns.delete(c), { origin: (key) => this.o.host.consoleOrigin(key), ...(backend !== undefined ? { backend } : {}) });
    this.conns.add(c);
    if (backend !== undefined) {
      const hf = this.o.host.local.hostFrames;
      // Known to the host service before any hello, so a rotated or revoked key closes this connection too (PB-3).
      if (hf?.attachBackend) hf.attachBackend(c, backend);
      // Without it nothing would hold the connection to its backend: do not keep it.
      else c.end('this server has no backends');
    }
    const beat = this.heartbeat(ws, c.id);
    ws.on('message', (data, isBinary) => {
      beat.alive();
      if (isBinary) return void c.send({ v: PROTOCOL_VERSION, type: 'result', id: '', ok: false, error: { code: 'bad_json', message: 'frames are text messages' } });
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return void c.send({ v: PROTOCOL_VERSION, type: 'result', id: '', ok: false, error: { code: 'bad_json', message: 'message is not JSON' } });
      }
      c.receive(raw);
    });
    ws.on('close', () => {
      beat.stop();
      c.drop();
    });
    ws.on('error', () => {
      beat.stop();
      c.drop();
    });
  }

  /**
   * `/ws` heartbeat (`console.heartbeat`): a ping every `intervalMs`; no pong (or
   * other message) within `timeoutMs` after it and the socket is terminated, so a
   * half-open connection does not keep the host role (or its pushes) forever.
   */
  private heartbeat(ws: WebSocket, id: string): { alive(): void; stop(): void } {
    const { intervalMs, timeoutMs } = this.o.config.heartbeat;
    if (intervalMs <= 0) return { alive: () => {}, stop: () => {} };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(deadline);
      deadline = undefined;
    };
    ws.on('pong', alive);
    const tick = setInterval(() => {
      if (ws.readyState !== ws.OPEN || deadline) return;
      deadline = setTimeout(() => {
        this.o.log('warn', `console: /ws connection ${id} did not answer a heartbeat within ${timeoutMs} ms; closing it`);
        ws.terminate();
      }, timeoutMs);
      deadline.unref?.();
      try {
        ws.ping();
      } catch {
        // closing already
      }
    }, intervalMs);
    tick.unref?.();
    return {
      alive,
      stop: () => {
        clearInterval(tick);
        alive();
      },
    };
  }
}

function param(path: string, prefix: string): string {
  return decode(path.slice(prefix.length));
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
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
