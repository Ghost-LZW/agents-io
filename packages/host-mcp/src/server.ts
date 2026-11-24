import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TurnProvenance } from '@agents-io/protocol';
import type { z } from 'zod';
import { TOOL_DEFS, TOOL_NAMES } from './defs.js';
import { McpHttpEndpoint } from './http.js';
import { ToolError, type CallMeta, type HostTools, type ToolBinding } from './tools.js';

export const SERVER_NAME = 'agents_io';

/** A tool as the endpoint offers it: one of the kernel's (`TOOL_DEFS`) or an active module's. */
export interface ToolEntry {
  name: string;
  description: string;
  /**
   * What the MCP SDK registers: the zod shapes of `TOOL_DEFS` (also for a module's tool that is one
   * of `TOOL_GROUP_DEFS`), a module's own JSON Schema as zod (`moduleToolInput`).
   */
  input: z.ZodRawShape | z.ZodType;
  readOnly: boolean;
  /** The module that adds it; absent for the kernel's own. */
  module?: string;
}

/**
 * The tools an endpoint over `tools` may offer, in the order it lists them: the kernel's in
 * `TOOL_DEFS` order (`watch_*`, `schedule_*`, `session_*`, `live_*` only when the host passed their control),
 * then the active modules' (`HostToolsOptions.modules`; a module may offer one of those groups,
 * `TOOL_GROUP_DEFS`, when the host passed no control for it). A token limited to some tools (the
 * agent's `tools` list) gets those of these it names. At each request the endpoint leaves out the
 * modules' tools they do not offer at the moment (`HostTools.withheld`).
 */
export function toolCatalog(tools: HostTools): ToolEntry[] {
  const kernel: ToolEntry[] = [];
  for (const name of TOOL_NAMES) {
    if (name.startsWith('watch_') && !tools.hasWatches) continue;
    if (name.startsWith('schedule_') && !tools.hasSchedules) continue;
    if (name.startsWith('session_') && !tools.hasTopics) continue;
    if (name.startsWith('live_') && !tools.hasLive) continue;
    const def = TOOL_DEFS[name];
    kernel.push({ name, description: def.description, input: def.input, readOnly: 'readOnly' in def && def.readOnly });
  }
  const own = new Set<string>(kernel.map((t) => t.name));
  const modules = tools.moduleCatalog().map((t): ToolEntry => {
    if (own.has(t.name)) throw new Error(`module ${t.module}: tool ${JSON.stringify(t.name)} is a kernel tool`);
    return { name: t.name, description: t.description, input: t.input, readOnly: t.readOnly, module: t.module };
  });
  return [...kernel, ...modules];
}

export interface HostMcpServerOptions {
  tools: HostTools;
  /** Listen address (default 127.0.0.1); anything but a loopback address is refused. */
  host?: string;
  /** Default 0: an ephemeral port. */
  port?: number;
  /** Called for every tool call (debugging, verifying what harnesses send in `_meta`). */
  onCall?: (e: { binding: ToolBinding; tool: string; meta: Record<string, unknown> | undefined; ok: boolean; error?: string; provenance?: TurnProvenance }) => void;
}

/** `_meta` keys harnesses put their own tool-call id under. */
const CALL_ID_KEYS = ['claudecode/toolUseId', 'codex/callId', 'callId', 'call_id', 'toolCallId', 'tool_call_id'];

function callIdOf(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  for (const k of CALL_ID_KEYS) {
    const v = meta[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * The host MCP endpoint: one per gateway, streamable HTTP on loopback, stateless
 * (a fresh MCP server per request). Every request must carry `Authorization:
 * Bearer <token>`; a token is minted per harness binding (`mint`) and maps to
 * (sessionKey, generation). The current turn is resolved at call time.
 */
export class HostMcpServer {
  private readonly tokens = new Map<string, ToolBinding>();
  /** Tokens limited to some tools (the agent's `tools` list). */
  private readonly allowed = new Map<string, ReadonlySet<string>>();
  private readonly endpoint: McpHttpEndpoint<{ b: ToolBinding; allow?: ReadonlySet<string> }>;
  /** What every token may be offered (`toolCatalog`); each request leaves out what the modules withhold then. */
  private readonly catalog: readonly ToolEntry[];

  constructor(private readonly o: HostMcpServerOptions) {
    this.catalog = toolCatalog(o.tools);
    // The tokens are bearer credentials sent in clear text: never reachable off this machine.
    this.endpoint = new McpHttpEndpoint({
      ...(o.host !== undefined ? { host: o.host } : {}),
      ...(o.port !== undefined ? { port: o.port } : {}),
      authenticate: (req) => this.binding(req),
      build: (a) => this.build(a.b, a.allow),
    });
  }

  async listen(): Promise<string> {
    try {
      return await this.endpoint.listen();
    } catch (e) {
      throw new Error(`HostMcpServer: ${(e as Error).message.replace(/^MCP endpoint: /, '')}`);
    }
  }

  /** The endpoint URL (after `listen`). */
  get url(): string {
    try {
      return this.endpoint.url;
    } catch {
      throw new Error('HostMcpServer is not listening');
    }
  }

  /** A new token for one harness binding. */
  mint(b: ToolBinding): string {
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, { ...b });
    return token;
  }

  /** Forget every token of a session (or one token). */
  revoke(match: string | { sessionKey: string }): void {
    if (typeof match === 'string') {
      this.tokens.delete(match);
      this.allowed.delete(match);
    } else
      for (const [t, b] of this.tokens)
        if (b.sessionKey === match.sessionKey) {
          this.tokens.delete(t);
          this.allowed.delete(t);
        }
  }

  /**
   * `LaneOptions.mcp` for a session: mints one token per harness binding. `tools` limits
   * what that token lists and may call (the agent's `tools` list); every tool when absent.
   */
  mcpFor(a: { sessionKey: string; generation: number; harnessId: string }, tools?: readonly string[]): { url: string; token: string; transport: 'http' } {
    const token = this.mint({ sessionKey: a.sessionKey, generation: a.generation, harnessId: a.harnessId });
    if (tools) this.allowed.set(token, new Set(tools));
    return { url: this.url, token, transport: 'http' };
  }

  async close(): Promise<void> {
    await this.endpoint.close();
  }

  private binding(req: IncomingMessage): { b: ToolBinding; allow?: ReadonlySet<string> } | undefined {
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    if (!m) return undefined;
    const given = Buffer.from(m[1]!);
    for (const [t, b] of this.tokens) {
      const want = Buffer.from(t);
      if (want.length === given.length && timingSafeEqual(want, given)) {
        const allow = this.allowed.get(t);
        return allow ? { b, allow } : { b };
      }
    }
    return undefined;
  }

  private build(b: ToolBinding, allow?: ReadonlySet<string>): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' }, { capabilities: { tools: {} } });
    // Asked now, for this request: a module's tool it does not offer at the moment (the live tools
    // while no running channel can open a live) is neither listed nor callable in it (CF-6).
    const withheld = this.o.tools.withheld();
    let registered = 0;
    for (const def of this.catalog) {
      const name = def.name;
      // Per-agent tool list (CF-6): a tool not listed is neither offered nor callable.
      if (allow && !allow.has(name)) continue;
      if (withheld.has(name)) continue;
      registered++;
      server.registerTool(
        name,
        {
          description: def.description,
          inputSchema: def.input,
          annotations: {
            readOnlyHint: def.readOnly,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: !def.readOnly,
          },
        },
        async (args: Record<string, unknown>, extra: { _meta?: Record<string, unknown>; requestId?: string | number }) => {
          const meta: CallMeta = {};
          const id = callIdOf(extra._meta);
          if (id) meta.toolCallId = id;
          if (extra.requestId !== undefined) meta.requestId = extra.requestId;
          // Taken before the call: the turn may end while the tool runs.
          const provenance = this.o.tools.provenanceOf(b);
          const prov = provenance ? { provenance } : {};
          try {
            const text = await this.o.tools.call(b, name, args ?? {}, meta);
            this.o.onCall?.({ binding: b, tool: name, meta: extra._meta, ok: true, ...prov });
            return { content: [{ type: 'text' as const, text }] };
          } catch (e) {
            const msg = e instanceof ToolError ? e.message : `internal error: ${(e as Error).message}`;
            this.o.onCall?.({ binding: b, tool: name, meta: extra._meta, ok: false, error: msg, ...prov });
            return { isError: true, content: [{ type: 'text' as const, text: msg }] };
          }
        },
      );
    }
    // Nothing offered now (an agent's list naming only tools withheld at the moment): the SDK installs
    // its tools/list and tools/call handlers only with the first tool, so without one tools/list would
    // answer "Method not found". A tool registered and removed installs them: tools/list answers an empty
    // list, tools/call `Tool <name> not found`, and initialize says what it says with tools (CF-6).
    if (registered === 0) server.registerTool('none', { description: '' }, () => ({ content: [] })).remove();
    return server;
  }
}
