import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Type, type TSchema } from '@sinclair/typebox';
import type { ContentBlock, InputRecord, KernelContext, KernelInputResult, ModuleResolveContext, Origin, Principal } from '@agents-io/protocol';
import { LaneUnavailableError, OWNER_LABEL } from '@agents-io/session';
import { globMatch, isLoopback } from '@agents-io/host-mcp';
import { TokenError, loadOrCreateTokenFile } from '@agents-io/kernel';

/*
 * What the north projections (core-slimming G9: the ACP server, the AG-UI endpoint) share with
 * each other and with the external MCP endpoint (docs/design/external-mcp): configured clients,
 * each with its own token and scopes; nothing else is allowed (CF-10). Whatever a client does is
 * stamped by the daemon with the client's own principal, kind `peer`, never a person (ID-10), asked
 * of the host that declared the `external` hook, and goes through the lane's loop guard like any
 * agent's input (IN-8). The rules are the external MCP endpoint's (`external-mcp.ts`), with these
 * endpoints' own names: their clients have no `send:` or `schedule:` scopes, and a client with an
 * `agent` may open sessions of its own (`<endpoint>:<client>:<id>`), which it may always read and
 * write.
 */

/** Which north endpoint, by its module's id (`origin.adapter`, the `external` callout's `endpoint`). */
export type PeerEndpoint = 'acp-server' | 'ag-ui';

const Closed = { additionalProperties: false } as const;

/** The keys every client of a north endpoint has (`<section>.clients.<name>`), plus the endpoint's own (`extra`). */
export function peerClientSchema<E extends Record<string, TSchema> = {}>(extra: E = {} as E) {
  return Type.Record(
    Type.String(),
    Type.Object(
      {
        /** `env:NAME`: the variable holding the token (never a literal). */
        token: Type.Optional(Type.String()),
        /** A token file (relative to the config file): read when it exists, else generated (0600). */
        tokenFile: Type.Optional(Type.String()),
        /** `read`, `read:<session pattern>`, `input:<session pattern>` (`*` matches any run of characters). */
        scopes: Type.Array(Type.String()),
        /** The principal it acts as (default `external:<name>`); always `external:…`, never a person. */
        principal: Type.Optional(Type.String()),
        /** Extra principal labels (`external` is always there; `owner` is refused). */
        labels: Type.Optional(Type.Array(Type.String())),
        /** An agent of the deployment: the client may open new sessions of its own with it (`<endpoint>:<client>:<id>`). */
        agent: Type.Optional(Type.String()),
        ...extra,
      },
      Closed,
    ),
  );
}

/** One client of a north endpoint, resolved. */
export interface PeerClient {
  /** Its name in `<section>.clients` (`[A-Za-z0-9._-]`, at most 64). */
  name: string;
  /** From `token: "env:NAME"`. SECRET: never log it. */
  token?: string;
  /** Absolute; read or generated when the endpoint starts. */
  tokenFile?: string;
  /** `external:<name>` unless configured (always `external:…`); labels always include `external`, never `owner`. */
  principal: Principal;
  /** Session patterns it may read, and queue inputs into (its own sessions besides). */
  scopes: { read: string[]; input: string[] };
  /** The agent its new sessions run (it may open sessions only with one). */
  agent?: string;
}

const CLIENT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const EXTERNAL_PRINCIPAL = /^external:[^\s]{1,128}$/;

/** `host:port`, loopback only (tokens are bearer credentials in clear text: never reachable off this machine). */
export function resolveListen(section: string, listen: string, ctx: Pick<ModuleResolveContext, 'fail'>): { host: string; port: number } {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(listen);
  if (!m || Number(m[2]) > 65535) ctx.fail(`${section}.listen ${JSON.stringify(listen)} is not host:port`);
  const host = m![1]!.replace(/^\[|\]$/g, '');
  if (!isLoopback(host)) ctx.fail(`${section}.listen ${JSON.stringify(listen)}: the endpoint listens on a loopback address only (127.0.0.1 or ::1)`);
  return { host, port: Number(m![2]) };
}

/** The section's clients, resolved; errors name keys, never values (the rules of `resolveExternalMcp`). */
export function resolvePeerClients(
  section: string,
  raw: Record<string, { token?: string; tokenFile?: string; scopes: string[]; principal?: string; labels?: string[]; agent?: string }>,
  ctx: Pick<ModuleResolveContext, 'substitute' | 'path' | 'valueAt' | 'fail'>,
): PeerClient[] {
  const fail = (msg: string): never => ctx.fail(msg);
  const owners = (ctx.valueAt('policy.owners') as string[] | undefined) ?? [];
  const agents = ctx.valueAt('agents') as Record<string, { mode?: string }> | undefined;
  const clients = Object.entries(raw).map(([name, e]): PeerClient => {
    const at = `${section}.clients.${name}`;
    if (!CLIENT_NAME.test(name)) fail(`${section}.clients: ${JSON.stringify(name)} is not a client name (letters, digits, . _ -, at most 64)`);
    if ((e.token === undefined) === (e.tokenFile === undefined)) fail(`${at}: give exactly one of token ("env:NAME") or tokenFile`);
    let token: string | undefined;
    if (e.token !== undefined) {
      if (!e.token.startsWith('env:')) fail(`${at}.token must be "env:NAME" (a literal token does not belong in the config; or use tokenFile)`);
      token = ctx.substitute(e.token, `${at}.token`) as string;
      if (token.length < 16 || /\s/.test(token)) fail(`${at}.token: the variable ${e.token.slice(4)} must hold at least 16 characters and no whitespace`);
    }
    const scopes: PeerClient['scopes'] = { read: [], input: [] };
    e.scopes.forEach((x, i) => {
      const m = x === 'read' ? ['read', 'read', '*'] : /^(read|input):(\S+)$/.exec(x);
      if (!m) fail(`${at}.scopes[${i}]: ${JSON.stringify(x)} is not a scope of this endpoint (read, read:<session pattern>, input:<session pattern>)`);
      scopes[m![1] as 'read' | 'input'].push(m![2]!);
    });
    const id = e.principal ?? `external:${name}`;
    if (!EXTERNAL_PRINCIPAL.test(id)) fail(`${at}.principal must be "external:<id>" (an external client is never a person, an agent or a host)`);
    if (owners.includes(id)) fail(`${at}.principal is an owner: an external client is never a person`);
    const labels = [...new Set(['external', ...(e.labels ?? [])])];
    if (labels.includes(OWNER_LABEL)) fail(`${at}.labels: an external client never carries the ${OWNER_LABEL} label`);
    if (e.agent !== undefined) {
      const a = agents?.[e.agent];
      if (!a) fail(`${at}.agent: no agent ${JSON.stringify(e.agent)} in agents`);
      if (a!.mode === 'task') fail(`${at}.agent: ${e.agent} is a task agent (its sessions are task runs)`);
    }
    return {
      name,
      ...(token !== undefined ? { token } : {}),
      ...(e.tokenFile !== undefined ? { tokenFile: ctx.path(e.tokenFile) } : {}),
      principal: { id, labels },
      scopes,
      ...(e.agent !== undefined ? { agent: e.agent } : {}),
    };
  });
  const files = clients.map((x) => x.tokenFile).filter((f): f is string => f !== undefined);
  if (new Set(files).size !== files.length) fail(`${section}.clients: two clients name the same tokenFile`);
  return clients;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * The clients' tokens, read (or generated) when the endpoint starts: a bad token file fails the
 * start (`TokenError`), and so does a client whose token is the host token or another client's.
 * `match` finds the client of a token comparing every digest (no early exit).
 */
export class PeerTokens {
  private readonly digests: { client: PeerClient; d: Buffer }[] = [];

  constructor(section: string, clients: readonly PeerClient[], k: KernelContext) {
    const seen = new Set<string>();
    for (const c of clients) {
      const token = c.token ?? tokenFromFile(section, c, k);
      if (k.host.isToken(token)) throw new TokenError(`${section}.clients.${c.name}: its token is the host token; give every client its own`);
      if (seen.has(token)) throw new TokenError(`${section}.clients.${c.name}: its token is another client's; give every client its own`);
      seen.add(token);
      this.digests.push({ client: c, d: digest(token) });
    }
  }

  /** The client whose token this is. */
  match(given: string | undefined): PeerClient | undefined {
    if (given === undefined) return undefined;
    const d = digest(given);
    let hit: PeerClient | undefined;
    for (const x of this.digests) if (timingSafeEqual(x.d, d) && hit === undefined) hit = x.client;
    return hit;
  }
}

function tokenFromFile(section: string, c: PeerClient, k: KernelContext): string {
  try {
    const r = loadOrCreateTokenFile(c.tokenFile!);
    k.log('info', r.created ? `token of client ${c.name} generated and written to ${c.tokenFile}` : `token of client ${c.name} read from ${c.tokenFile}`);
    return r.token;
  } catch (e) {
    throw new TokenError(`${section}.clients.${c.name}.tokenFile: ${(e as Error).message}`);
  }
}

const MINUTE = 60_000;

/** Per-client counts over the last minute (requests, writes). */
export class RateWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  /** Count one; refused (not counted) when `max` were counted in the last minute, with the wait. */
  take(key: string, max: number): { ok: true } | { ok: false; retryMs: number } {
    const t = this.now();
    const kept = (this.hits.get(key) ?? []).filter((x) => t - x < MINUTE);
    if (kept.length >= max) {
      this.hits.set(key, kept);
      return { ok: false, retryMs: MINUTE - (t - kept[0]!) };
    }
    kept.push(t);
    this.hits.set(key, kept);
    return { ok: true };
  }
}

/** A client's action refused, with what the client reads (`code` for its protocol's error). */
export class PeerRefusal extends Error {
  override name = 'PeerRefusal';
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'denied' | 'invalid' | 'rate_limited' | 'stopping' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

/**
 * A north endpoint's client as the daemon stamps it (ID-10): kind `peer` (an agent outside this
 * daemon), its own principal, evidence `device_only` (a local connection with its token), `via`
 * and `adapter` naming the endpoint.
 */
export function peerOrigin(c: Pick<PeerClient, 'name' | 'principal'>, endpoint: PeerEndpoint): Origin {
  return { kind: 'peer', principal: { id: c.principal.id, labels: [...c.principal.labels] }, evidence: 'device_only', via: peerVia(c.name, endpoint), adapter: endpoint };
}

/** `<endpoint>:<client>`: the origin's `via`, the input's `cause.peer` (its pair count, IN-8) and its routing record's binding. */
export const peerVia = (client: string, endpoint: PeerEndpoint) => `${endpoint}:${client}`;

/** The prefix of the sessions a client opens itself (`<endpoint>:<client>:`). */
export const ownPrefix = (client: string, endpoint: PeerEndpoint) => `${endpoint}:${client}:`;

/** Not a session anyone outside may read or write: a task run, a log of deliveries. */
const notASession = (key: string) => key.startsWith('run:') || key.startsWith('host:') || key.startsWith('external:');

/** The client may read the session: one of its own, or one its `read` scopes name. */
export function mayRead(c: PeerClient, endpoint: PeerEndpoint, key: string): boolean {
  if (notASession(key)) return false;
  return key.startsWith(ownPrefix(c.name, endpoint)) || c.scopes.read.some((p) => globMatch(p, key));
}

/** The client may queue inputs into the session: one of its own, or one its `input` scopes name. */
export function mayInput(c: PeerClient, endpoint: PeerEndpoint, key: string): boolean {
  if (notASession(key)) return false;
  return key.startsWith(ownPrefix(c.name, endpoint)) || c.scopes.input.some((p) => globMatch(p, key));
}

/**
 * The session a client means by `ref` (an ACP session id, an AG-UI thread id): `ref` itself when it
 * is a session this daemon knows and the client may `need` it; else, for a client with an agent, its
 * own session `<endpoint>:<client>:<ref>` (opened with that agent when new); else refused: `not_found`
 * unless the client may read it (then `forbidden`).
 */
export function sessionFor(k: KernelContext, c: PeerClient, endpoint: PeerEndpoint, ref: string, need: 'read' | 'input'): { key: string; agent?: string } {
  const may = need === 'read' ? mayRead : mayInput;
  if (k.sessions.known(ref) && may(c, endpoint, ref)) return { key: ref };
  if (ref.startsWith(ownPrefix(c.name, endpoint))) {
    if (c.agent === undefined && !k.sessions.known(ref)) throw new PeerRefusal('not_found', `no session ${ref}`);
    return { key: ref, ...(c.agent !== undefined ? { agent: c.agent } : {}) };
  }
  if (c.agent !== undefined && /^[A-Za-z0-9._-]{1,128}$/.test(ref)) return { key: `${ownPrefix(c.name, endpoint)}${ref}`, agent: c.agent };
  // One it may not read is as if there were none (its existence is not the client's to learn).
  if (!k.sessions.known(ref) || !mayRead(c, endpoint, ref)) throw new PeerRefusal('not_found', `no session ${ref}${c.agent === undefined ? ' (and this client opens none: it has no agent)' : ''}`);
  throw new PeerRefusal('forbidden', `session ${ref} is not in your ${need} scope`);
}

/** A new session of the client's own (it has an agent). */
export function newOwnSession(c: PeerClient, endpoint: PeerEndpoint): { key: string; agent: string } {
  if (c.agent === undefined) throw new PeerRefusal('forbidden', `client ${c.name} opens no sessions of its own (it has no agent)`);
  return { key: `${ownPrefix(c.name, endpoint)}${randomUUID()}`, agent: c.agent };
}

/**
 * The host that declared the `external` hook decides every write (`op: input`); it being away, or
 * failing, denies (as for the external MCP endpoint). A host without the hook: the scopes decide.
 */
export async function hostAllows(k: KernelContext, c: PeerClient, endpoint: PeerEndpoint, a: { sessionKey: string; content: ContentBlock[]; id: string }): Promise<void> {
  const held = k.host.heldBy('external');
  if (held !== undefined) {
    k.log('warn', `host ${held} decides external writes and is not connected: ${endpoint} client ${c.name} input denied`);
    throw new PeerRefusal('denied', `denied: the host that decides external writes (${held}) is not connected; try again later`);
  }
  if (!k.host.answers('external')) return;
  let v;
  try {
    v = await k.host.external({ client: c.name, principal: c.principal.id, op: 'input', sessionKey: a.sessionKey, content: a.content, id: a.id, endpoint });
  } catch (e) {
    k.log('warn', `host external callout for ${endpoint} client ${c.name} input failed (${(e as Error).message}); denied`);
    throw new PeerRefusal('denied', 'denied: the host did not answer whether this is allowed; try again later');
  }
  if (v.verdict !== 'allow') throw new PeerRefusal('denied', `denied by the host${v.reason ? `: ${v.reason}` : ''}`);
}

/**
 * Queue a client's input into a session it may write (opening the session with `agent` when it is
 * a new one of its own): the host's `external` hook first, then a routing record (`explain
 * <inputId>`), then the lane, which decides as for any agent's input (its loop guard may keep it as
 * context: `observe_only`, IN-8). The answer stays in the session's log (reply route `local`).
 */
export async function peerInput(
  k: KernelContext,
  c: PeerClient,
  endpoint: PeerEndpoint,
  a: { sessionKey: string; agent?: string; inputId: string; content: ContentBlock[]; mode?: 'queue' | 'steer' },
): Promise<Extract<KernelInputResult, { ok: true }>> {
  if (k.stopping()) throw new PeerRefusal('stopping', 'the daemon is stopping; try again later');
  const key = a.sessionKey;
  await hostAllows(k, c, endpoint, { sessionKey: key, content: a.content, id: a.inputId });
  try {
    await k.lanes.open(key, a.agent);
  } catch (e) {
    throw new PeerRefusal('unavailable', e instanceof LaneUnavailableError ? `${e.code}: ${e.message}` : (e as Error).message);
  }
  const origin = peerOrigin(c, endpoint);
  const via = peerVia(c.name, endpoint);
  const input: InputRecord = {
    inputId: a.inputId,
    origin,
    content: a.content,
    // The answer stays in the session's log: the client reads it there (as a local end does).
    replyRoute: { channel: 'local', account: 'local', conversationId: key },
    // An agent outside this daemon: where it sits in a chain is unknown (the pair limit still counts it).
    cause: { peer: via, basis: 'none' },
    channelContext: { channel: endpoint, client: c.name },
  };
  const agent = k.sessions.agentOf(key) ?? a.agent;
  k.router.record({
    inputId: a.inputId,
    tableVersions: [],
    matched: [{ bindingId: via, source: 'config', on: 'dispatch', ...(agent !== undefined ? { agent } : {}), sessionKey: key }],
    principal: origin.principal!.id,
    evidence: origin.evidence,
    at: Date.now(),
    cause: input.cause!,
  });
  const r = await k.lanes.input(key, input, a.mode ?? 'queue');
  if (!r.ok) throw new PeerRefusal('denied', `the session refused the input: ${r.reason}`);
  return r;
}

/** What a client may say in one input: text up to `maxChars`, at least something. */
export function checkText(content: ContentBlock[], maxChars: number): void {
  const chars = content.reduce((n, b) => n + ('text' in b && typeof b.text === 'string' ? b.text.length : 0), 0);
  if (chars > maxChars) throw new PeerRefusal('invalid', `the input is ${chars} characters; the limit is ${maxChars}`);
  if (!content.some((b) => ('text' in b && typeof b.text === 'string' ? b.text.trim() !== '' : true))) throw new PeerRefusal('invalid', 'the input is empty');
}

/** An image a client sends inline (base64), put in the host's blob store: its content block. */
export async function inlineImage(k: KernelContext, data: string, mime: string, name?: string): Promise<ContentBlock> {
  if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) throw new PeerRefusal('invalid', `${JSON.stringify(mime)} is not an image type`);
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new PeerRefusal('invalid', 'the image is empty (base64 data)');
  let ref: string;
  try {
    ref = await k.blobs.put(new Uint8Array(bytes), { mime, ...(name ? { name } : {}) });
  } catch (e) {
    throw new PeerRefusal('invalid', `the image was not stored: ${(e as Error).message}`);
  }
  return { type: 'image', ref, mime, ...(name ? { name } : {}) };
}
