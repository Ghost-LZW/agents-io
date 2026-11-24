import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { BlobAccess, HarnessAdapter, HarnessCaps, HarnessOpenArgs, HarnessSession, SessionEnvSupport } from '@agents-io/protocol';
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type InitializeResponse,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { ACP_FLAVORS, flavorFor, withDefaults, type AcpCommand, type AcpFlavor } from './flavors.js';
import { recordStream, type AcpTranscriptTap } from './record.js';
import { AcpSession, type AcpLink } from './session.js';

/*
 * The ACP harness: any Agent Client Protocol agent (agentclientprotocol.com) as a `HarnessAdapter`.
 * One agent process per adapter, started by the first `probe` or `open`, serves every session of
 * the instance over JSON-RPC on stdio (the official SDK, `@agentclientprotocol/sdk`, v1); a launched
 * session's env or a task run gets a process of its own (`ownProcess`). What it can do comes from
 * the agent's `initialize` answer and each session's `session/new` / `session/load` answer. The
 * client capabilities offered are form elicitation only: no `fs`, no `terminal`, so the agent reads,
 * writes and runs things itself, under its own permissions, and asks for permission
 * (`session/request_permission`) as it decides. A process that exits ends its sessions; the next
 * `probe` or `open` starts another, and a session resumes there with `session/load`.
 */

export type AcpLog = (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => void;

export interface AcpHarnessOptions {
  /** The agent program: a path or a name looked up on PATH. */
  command: string;
  /** Its arguments, as written: other local users can read them (`ps`), so no secrets here. */
  args?: string[];
  /** The agent's environment over the host's; `undefined` removes a variable. SECRET: never logged. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The agent process's working directory (default the host's); each session works in its own (`open`'s `cwd`). */
  cwd?: string;
  /** The adapter's id (default `acp`). */
  id?: string;
  /** Its quirks (`ACP_FLAVORS` by name, or one of your own). Default: the one matching the agent's `agentInfo`, else `generic`. */
  flavor?: string | AcpFlavor;
  /**
   * Instance profiles: profile name → `{ mode }`, the session mode a turn of that profile runs in
   * (`session/set_mode`). Without one, `bypass` runs in the mode the session opened in and every
   * other profile in the agent's asking mode (the flavor's `restrictedMode`), or does not start.
   */
  profiles?: Readonly<Record<string, Record<string, unknown>>>;
  /**
   * How the host's MCP endpoint (`HarnessOpenArgs.mcp`) reaches the agent: `http` (an `http` MCP
   * server with the bearer token as a header; the agent must advertise `mcpCapabilities.http`) or
   * `stdio-bridge` (a stdio MCP server, this package's `bin/mcp-stdio-bridge.mjs`, which forwards to
   * the endpoint; every agent takes stdio). Default: `http` when the agent advertises it, else `stdio-bridge`.
   */
  mcp?: 'http' | 'stdio-bridge';
  /** The name the agent sees the host's MCP server by. Default `agents-io`. */
  mcpServerName?: string;
  /** The harness's name in replies (default: the flavor's, else the instance's). */
  displayName?: string;
  /** The session mode Plan mode selects (default: the flavor's, `plan`). Declares Plan mode before any session has shown it. */
  planMode?: string;
  /** The command that compacts a session's context (default: `/compact` once the agent advertises `compact`). */
  compact?: string;
  /** Offer form elicitation, so the agent can ask questions (`caps.questions`). Default true. */
  elicitation?: boolean;
  /** Authenticate with this method (`authenticate`, one of the agent's `authMethods`) after `initialize`. */
  authMethod?: string;
  /** The host's blob store, read-only: images and files of inputs. */
  blobs?: BlobAccess;
  log?: AcpLog;
  /** Timeout of `initialize`, `session/new`, `session/load` and the other setup requests. Default 60 s. */
  requestTimeoutMs?: number;
  /** How long an interrupted turn waits for the agent to stop before it ends anyway. Default 15 s. */
  cancelTimeoutMs?: number;
  /** How long the agent has to exit after its stdin closes (`dispose`), and then after SIGTERM, before it is killed. Default 1 s. */
  shutdownGraceMs?: number;
  /** Every JSON-RPC message of the connection, both ways (a transcript recorder's tap, docs/design/conformance-fixtures §2). */
  record?: AcpTranscriptTap;
}

/** The stdio MCP server that forwards to the host's MCP endpoint (`mcp: "stdio-bridge"`): a plain script, run with node. */
export const MCP_STDIO_BRIDGE = fileURLToPath(new URL('../bin/mcp-stdio-bridge.mjs', import.meta.url));

const CLIENT_INFO = { name: 'agents-io', title: 'agents-io', version: '0.1.0' };

class Timeout extends Error {}
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout(`${what}: no answer within ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** The last few lines of `s`, on one line. */
const lastLines = (s: string) => s.trim().split('\n').slice(-3).join(' | ');

/** One running agent process and its connection. */
interface Proc {
  child: ChildProcess;
  conn: ClientConnection;
  init: InitializeResponse;
  sessions: Map<string, AcpSession>;
  /** Updates for a session id no session has yet (a `session/new` answer may come after them). */
  early: Map<string, SessionNotification[]>;
  gone: boolean;
  /** Why it is gone, once it is. */
  closed: Promise<string>;
  stderr: { tail: string };
}

export class AcpHarness implements HarnessAdapter {
  readonly id: string;
  private proc: Proc | undefined;
  private starting: Promise<Proc> | undefined;
  private ended = false;
  private readonly log: AcpLog;
  private readonly requestTimeoutMs: number;
  /** What sessions showed: the session modes the agent offers, the commands it advertises. */
  private seen: { modes?: readonly string[]; commands?: readonly AcpCommand[] } = {};
  private flavorPicked: AcpFlavor | undefined;
  private agentInfo: InitializeResponse['agentInfo'];

  constructor(private readonly o: AcpHarnessOptions) {
    this.id = o.id ?? 'acp';
    this.log = o.log ?? (() => {});
    this.requestTimeoutMs = o.requestTimeoutMs ?? 60_000;
    if (typeof o.flavor === 'string' && !ACP_FLAVORS[o.flavor]) throw new Error(`unknown ACP flavor ${JSON.stringify(o.flavor)} (known: ${Object.keys(ACP_FLAVORS).join(', ')})`);
  }

  /** The flavor: the configured one, else the one the agent's `initialize` answer picked, else generic. */
  private get flavor(): AcpFlavor {
    const f = this.o.flavor;
    if (typeof f === 'string') return ACP_FLAVORS[f]!;
    return f ?? this.flavorPicked ?? ACP_FLAVORS.generic!;
  }

  // ---- static declarations: the instance's, then what its sessions showed ----

  get displayName(): string | undefined {
    return this.o.displayName ?? this.flavor.displayName;
  }

  /** Plan mode: configured (`planMode`), or a session showed the flavor's plan mode among the agent's modes. */
  get modes(): readonly 'plan'[] | undefined {
    if (this.o.planMode !== undefined) return ['plan'];
    const plan = withDefaults(this.flavor).planMode;
    return this.seen.modes?.includes(plan) ? ['plan'] : undefined;
  }

  /** Compaction: configured (`compact`), or the command the flavor finds among those the agent advertised. */
  get compact(): { readonly command: string } | undefined {
    const command = this.o.compact ?? (this.seen.commands ? withDefaults(this.flavor).compactCommand(this.seen.commands) : undefined);
    return command ? { command } : undefined;
  }

  /** One process serves every session: a launched session's env gets a process of its own. */
  readonly sessionEnv: SessionEnvSupport = 'own-process';

  ownProcess(o: { env: Record<string, string>; cwd?: string }): HarnessAdapter {
    const a = new AcpHarness({ ...this.o, env: { ...this.o.env, ...o.env }, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}) });
    a.seen = this.seen;
    return a;
  }

  // ---- the process ------------------------------------------------------------

  private async connect(): Promise<Proc> {
    if (this.ended) throw new Error(`ACP agent ${this.id} was disposed`);
    if (this.proc && !this.proc.gone) return this.proc;
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(): Promise<Proc> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...this.o.env })) if (v !== undefined) env[k] = v;
    const child = spawn(this.o.command, this.o.args ?? [], { cwd: this.o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    // The end of what it wrote on stderr, for messages when it fails; each line goes to the log too.
    const stderr = { tail: '' };
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      stderr.tail = (stderr.tail + d).slice(-4000);
      for (const line of d.split('\n')) if (line.trim()) this.log('debug', `agent stderr: ${line.slice(0, 500)}`);
    });
    child.stdin!.on('error', () => undefined);
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (e) => reject(new Error(`cannot start the ACP agent ${this.o.command}: ${e.message}`)));
    });
    // A later error (a failed kill) is not the daemon's to crash on; the exit says what happened.
    child.on('error', () => undefined);
    const closed = new Promise<string>((resolve) => child.once('exit', (code, signal) => resolve(`the ACP agent exited (${signal ? `signal ${signal}` : `code ${code}`})`)));
    await spawned;

    let stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    if (this.o.record) stream = recordStream(stream, this.o.record);
    const sessions = new Map<string, AcpSession>();
    const early = new Map<string, SessionNotification[]>();
    const identity = (p: unknown) => p as never;
    const app = client({ name: 'agents-io' })
      // Taken as sent (no schema check): an update of a shape or type this SDK does not know is still routed (and becomes `native`).
      .onNotification('session/update', identity, ({ params }: { params: SessionNotification }) => {
        const s = sessions.get(params?.sessionId);
        if (s) return s.update(params);
        if (typeof params?.sessionId !== 'string') return;
        const q = early.get(params.sessionId) ?? [];
        if (q.length < 64) q.push(params);
        early.set(params.sessionId, q);
        // Kept for a few ids only: one no session takes is dropped first.
        if (early.size > 16) early.delete(early.keys().next().value!);
      })
      .onRequest('session/request_permission', identity, ({ params, signal }: { params: { sessionId: string } & Parameters<AcpSession['permission']>[0]; signal: AbortSignal }) => {
        const s = sessions.get(params?.sessionId);
        return s ? s.permission(params, signal) : { outcome: { outcome: 'cancelled' } };
      })
      .onRequest('elicitation/create', identity, ({ params, signal }: { params: { sessionId?: string } & Parameters<AcpSession['elicitation']>[0]; signal: AbortSignal }) => {
        const s = params?.sessionId ? sessions.get(params.sessionId) : undefined;
        return s ? s.elicitation(params, signal) : { action: 'decline' };
      })
      .onNotification('elicitation/complete', identity, () => undefined);
    const conn = app.connect(stream);
    const proc: Proc = { child, conn, init: undefined as unknown as InitializeResponse, sessions, early, gone: false, closed, stderr };
    void closed.then((why) => {
      proc.gone = true;
      conn.close();
      const tail = lastLines(stderr.tail);
      if (!this.ended) this.log('warn', `${why}${tail ? `: ${tail}` : ''}`);
      for (const s of [...sessions.values()]) s.lost(why);
      sessions.clear();
      if (this.proc === proc) this.proc = undefined;
    });

    const fail = async (e: unknown): Promise<never> => {
      // Why it exited, when it did by itself; else it is stopped here.
      const why = await Promise.race([closed, new Promise<string>((r) => setTimeout(() => r(''), 100))]);
      if (!why) child.kill('SIGKILL');
      const tail = lastLines(stderr.tail);
      throw new Error(`${errMsg(e)}${why ? ` (${why})` : ''}${tail ? `: ${tail}` : ''}`);
    };
    try {
      const elicitation = this.o.elicitation !== false;
      const init = await within(
        conn.agent.request<InitializeResponse>('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: elicitation ? { elicitation: { form: {} } } : {}, clientInfo: CLIENT_INFO }),
        this.requestTimeoutMs,
        'initialize',
      );
      // Refuse to run a protocol version this adapter does not speak (INVARIANTS HC-1).
      if (init.protocolVersion !== PROTOCOL_VERSION) throw new Error(`the ACP agent speaks protocol version ${init.protocolVersion}; this adapter speaks ${PROTOCOL_VERSION}`);
      if (this.o.authMethod) await within(conn.agent.request('authenticate', { methodId: this.o.authMethod }), this.requestTimeoutMs, 'authenticate');
      proc.init = init;
      this.agentInfo = init.agentInfo;
      if (this.o.flavor === undefined) this.flavorPicked = flavorFor(init.agentInfo ?? undefined);
    } catch (e) {
      return fail(e);
    }
    this.proc = proc;
    if (this.ended) {
      void this.stop(proc);
      throw new Error(`ACP agent ${this.id} was disposed`);
    }
    return proc;
  }

  // ---- HarnessAdapter -------------------------------------------------------------

  async probe(): Promise<{ version: string; caps: HarnessCaps }> {
    const p = await this.connect();
    const a = p.init.agentCapabilities ?? {};
    return {
      version: p.init.agentInfo?.version ? `${p.init.agentInfo.name} ${p.init.agentInfo.version}` : (p.init.agentInfo?.name ?? 'unknown'),
      caps: {
        // A prompt runs to its end: an input during it waits for the next turn (the lane queues).
        steer: 'none',
        interrupt: true,
        approvals: true,
        questions: this.o.elicitation !== false,
        tokenDeltas: true,
        cancelQueued: false,
        injectWithoutTurn: false,
        resume: a.loadSession === true,
        switchModelMidSession: false,
        switchProfileMidSession: true,
      },
    };
  }

  async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    // One process serves every session (sessionEnv 'own-process'): a session's own env needs its own (INVARIANTS HC-2).
    if (args.env && Object.keys(args.env).length)
      throw new Error('the ACP agent process serves every session of this instance: a session with its own env runs on a process of its own (ownProcess)');
    const p = await this.connect();
    const caps = p.init.agentCapabilities ?? {};
    const mcpServers = this.mcpServers(args, caps.mcpCapabilities ?? {});
    let systemPrompt: { mode: 'append'; content: { type: 'text'; text: string }[] } | undefined;
    if (args.instructions) {
      if (!caps.sessionCapabilities?.systemPrompt) throw new Error("the ACP agent does not take instructions (it advertises no sessionCapabilities.systemPrompt); remove the agent's instructions or use another harness");
      systemPrompt = { mode: 'append', content: [{ type: 'text', text: args.instructions }] };
    }
    const link = this.link(p);
    const common = { cwd: args.cwd, mcpServers, ...(systemPrompt ? { systemPrompt } : {}) };

    if (args.resume) {
      if (caps.loadSession) {
        // Registered before the request: the replay comes before the answer, and is not the session's events.
        const s = new AcpSession(link, args.resume);
        this.register(p, s);
        try {
          const r = await within(p.conn.agent.request('session/load', { ...common, sessionId: args.resume }), this.requestTimeoutMs, 'session/load');
          s.setup((r ?? {}) as LoadSessionResponse);
          s.bound();
          return s;
        } catch (e) {
          if (p.sessions.get(args.resume) === s) p.sessions.delete(args.resume);
          if (e instanceof Timeout || p.gone) throw e;
          const s2 = await this.newSession(p, link, common);
          s2.notice('continuity', `could not resume ACP session ${args.resume} (${errMsg(e)}); started a new one`);
          return s2;
        }
      }
      const s = await this.newSession(p, link, common);
      s.notice('continuity', `the ACP agent cannot load sessions (no loadSession capability): session ${args.resume} not resumed, started a new one`);
      return s;
    }
    return this.newSession(p, link, common);
  }

  private async newSession(p: Proc, link: AcpLink, common: Record<string, unknown>): Promise<AcpSession> {
    const r = await within(p.conn.agent.request('session/new', common as never), this.requestTimeoutMs, 'session/new');
    const s = new AcpSession(link, (r as NewSessionResponse).sessionId);
    this.register(p, s);
    s.setup(r as NewSessionResponse);
    s.bound();
    return s;
  }

  private register(p: Proc, s: AcpSession): void {
    const old = p.sessions.get(s.sessionId);
    if (old && old !== s) old.lost('replaced by a newer open of the same ACP session');
    p.sessions.set(s.sessionId, s);
    const early = p.early.get(s.sessionId);
    p.early.delete(s.sessionId);
    for (const n of early ?? []) s.update(n);
  }

  /** The host's MCP endpoint as the agent takes it (`mcp`). */
  private mcpServers(args: HarnessOpenArgs, mcpCaps: { http?: boolean; sse?: boolean }): McpServer[] {
    const m = args.mcp;
    if (!m) return [];
    const name = this.o.mcpServerName ?? 'agents-io';
    const way = this.o.mcp ?? (mcpCaps.http ? 'http' : 'stdio-bridge');
    if (way === 'http') {
      if (!mcpCaps.http) throw new Error('the ACP agent does not take http MCP servers (no mcpCapabilities.http); set mcp: "stdio-bridge"');
      return [{ type: 'http', name, url: m.url, headers: [{ name: 'Authorization', value: `Bearer ${m.token}` }] }];
    }
    // The token goes in the bridge's environment, never on a command line.
    return [{ name, command: process.execPath, args: [MCP_STDIO_BRIDGE], env: [{ name: 'AIO_MCP_URL', value: m.url }, { name: 'AIO_MCP_TOKEN', value: m.token }] }];
  }

  private link(p: Proc): AcpLink {
    const self = this;
    const a = p.init.agentCapabilities ?? {};
    return {
      request: <T>(method: string, params: unknown, ms?: number) => within(p.conn.agent.request(method, params) as Promise<T>, ms ?? this.requestTimeoutMs, method),
      prompt: (params) => p.conn.agent.request('session/prompt', params as never) as Promise<PromptResponse>,
      notify: (method, params) => p.conn.agent.notify(method, params),
      // The process exited, or its output ended before the exit was seen.
      get gone() {
        return p.gone || p.conn.signal.aborted;
      },
      get flavor() {
        return withDefaults(self.flavor);
      },
      ...(this.o.blobs ? { blobs: this.o.blobs } : {}),
      support: a.promptCapabilities ?? {},
      closes: !!a.sessionCapabilities?.close,
      cancelTimeoutMs: this.o.cancelTimeoutMs ?? 15_000,
      profiles: this.o.profiles ?? {},
      planMode: this.o.planMode,
      learned: (o) => {
        this.seen = { ...this.seen, ...o };
      },
      forget: (s) => {
        if (p.sessions.get(s.sessionId) === s) p.sessions.delete(s.sessionId);
      },
      log: (level, msg) => this.log(level, msg),
    };
  }

  /** End the agent process now: its sessions end, a running turn as ambiguous. Final: nothing starts it again. */
  async dispose(): Promise<void> {
    this.ended = true;
    const p = this.proc ?? (await this.starting?.catch(() => undefined));
    if (p) await this.stop(p);
  }

  private async stop(p: Proc): Promise<void> {
    if (p.gone) return;
    const grace = this.o.shutdownGraceMs ?? 1_000;
    const exited = (ms: number) => Promise.race([p.closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref?.())]);
    p.child.stdin?.end();
    if (await exited(grace)) return;
    p.child.kill('SIGTERM');
    if (await exited(grace)) return;
    p.child.kill('SIGKILL');
    await exited(grace);
  }

  /** The agent as it named itself in `initialize` (after the first `probe` or `open`). */
  get agent(): { name?: string; title?: string | null; version?: string } | undefined {
    return this.agentInfo ?? undefined;
  }
}
