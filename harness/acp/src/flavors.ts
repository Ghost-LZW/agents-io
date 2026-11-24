import type { RequestQuestion } from '@agents-io/protocol';

/*
 * Agent quirks, as named flavor hooks (core-slimming G9): what one ACP agent does differently from
 * the protocol's plain reading lives here, behind a name, never in the kernel. An instance picks
 * one with `flavor`; without it the agent's `initialize` answer (`agentInfo.name`) picks one that
 * `matches`, else `generic`. Every hook is optional: a missing one is `generic`'s.
 */

/** A tool call as the hooks see it: what `tool_call` and `tool_call_update` said of it so far. */
export interface AcpToolCallView {
  toolCallId: string;
  title?: string;
  /** Its programmatic name (`ToolCall.name`), when the agent gives one. */
  name?: string;
  kind?: string;
  rawInput?: unknown;
  /** The `_meta` the agent sent with it (an agent's own extensions), as last sent. */
  meta?: Record<string, unknown>;
}

/** A session mode the agent offers (`availableModes`), as the hooks see it. */
export interface AcpMode {
  id: string;
  name?: string;
  description?: string | null;
}

/** A form elicitation (`elicitation/create`, `mode: "form"`), as the hooks see it. */
export interface AcpElicitationForm {
  message: string;
  requestedSchema: {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[] | null;
    title?: string | null;
  };
}

/** An advertised slash command (`available_commands_update`). */
export interface AcpCommand {
  name: string;
  description?: string;
}

export interface AcpFlavor {
  readonly name: string;
  /** Picks this flavor for an instance that names none, by the agent's `initialize` answer. */
  matches?(agentInfo: { name?: string; title?: string | null } | undefined): boolean;
  /** The harness's name in replies (`HarnessAdapter.displayName`) when the instance gives none. */
  readonly displayName?: string;
  /** The session mode Plan mode selects (`RunSpec.mode: "plan"`), when the agent offers it. Default `plan`. */
  readonly planMode?: string;
  /**
   * The session mode a turn runs in when its profile configures none (every profile but `bypass`,
   * the built-in `restricted` among them): one in which the agent asks before it acts, among the
   * modes it offers, as Claude Code's `default` and Codex's `on-request` are. None: such a turn does
   * not start until its profile's `mode` is configured. Default: `default` when the agent offers it.
   */
  restrictedMode?(modes: readonly AcpMode[]): string | undefined;
  /** The command that compacts the session's context, from the commands the agent advertises. Default: `/compact` when it advertises `compact`. */
  compactCommand?(advertised: readonly AcpCommand[]): string | undefined;
  /** The MCP server and tool a tool call is (an `mcp_tool` item, INVARIANTS HC-7's shape), when it is one. Default: a name or title `mcp__<server>__<tool>`. */
  mcpTool?(call: AcpToolCallView): { server: string; name: string } | undefined;
  /** A tool call that runs a subagent (a `subagent` item). Default: none. */
  subagent?(call: AcpToolCallView): boolean;
  /** A tool call that reports the agent compacting the session's context (on its own or for the compaction command): the next input's preface gives its context in full again (INVARIANTS ID-2). Default: none. */
  compaction?(call: AcpToolCallView): boolean;
  /** The questions of a form elicitation. Default: one per property of its schema. */
  elicitationQuestions?(form: AcpElicitationForm): RequestQuestion[];
}

const MCP_NAME = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/;

/** `mcp__<server>__<tool>` (Claude Code's naming, which other agents copied). */
export function mcpToolOfName(s: string | undefined): { server: string; name: string } | undefined {
  const m = s ? MCP_NAME.exec(s) : null;
  return m ? { server: m[1]!, name: m[2]! } : undefined;
}

/** Every flavor's defaults: the protocol as written. */
export const genericFlavor: AcpFlavor = {
  name: 'generic',
  planMode: 'plan',
  restrictedMode: (modes) => modes.find((m) => m.id === 'default')?.id,
  compactCommand: (advertised) => (advertised.some((c) => c.name === 'compact') ? '/compact' : undefined),
  mcpTool: (call) => mcpToolOfName(call.name) ?? mcpToolOfName(call.title),
  subagent: () => false,
  compaction: () => false,
  elicitationQuestions: (form) =>
    Object.entries(form.requestedSchema.properties ?? {}).map(([id, p]) => {
      const title = typeof p.title === 'string' ? p.title : undefined;
      const description = typeof p.description === 'string' ? p.description : undefined;
      const options = choices(p);
      return {
        id,
        text: title ?? description ?? id,
        ...(title && description ? { header: description } : {}),
        ...(options ? { options } : {}),
        ...(p.type === 'array' ? { multiSelect: true } : {}),
      };
    }),
};

/** The options of an enum-like property (`enum`, `oneOf` / `anyOf` of `const` + `title`, an array's `items`). */
export function choices(p: Record<string, unknown>): { label: string; description?: string }[] | undefined {
  const src = p.type === 'array' && typeof p.items === 'object' && p.items !== null ? (p.items as Record<string, unknown>) : p;
  if (Array.isArray(src.enum)) return src.enum.filter((v): v is string => typeof v === 'string').map((label) => ({ label }));
  const list = Array.isArray(src.oneOf) ? src.oneOf : Array.isArray(src.anyOf) ? src.anyOf : undefined;
  if (!list) return undefined;
  return list.flatMap((o) => {
    const e = o as { const?: unknown; title?: unknown; description?: unknown };
    if (typeof e.const !== 'string') return [];
    return [{ label: typeof e.title === 'string' ? e.title : e.const, ...(typeof e.description === 'string' ? { description: e.description } : {}) }];
  });
}

/**
 * Claude Code through its ACP agent (`@agentclientprotocol/claude-agent-acp`): its `Agent` / `Task`
 * tool runs a subagent; it advertises `/compact`; its Plan mode is the session mode `plan`, its
 * asking one `default` ("Always ask before making changes"; it opens in `auto`); it reports a
 * compaction, its own or `/compact`'s, to a client without its compaction extension as a tool call
 * "Compact conversation" whose `_meta.claudeCode.toolName` is `compact` (0.110.1).
 */
export const claudeFlavor: AcpFlavor = {
  name: 'claude',
  matches: (info) => /claude/i.test(info?.name ?? ''),
  displayName: 'Claude Code (ACP)',
  subagent: (call) => call.name === 'Agent' || call.name === 'Task' || /^(Agent|Task)\b/.test(call.title ?? ''),
  compaction: (call) => (call.meta?.claudeCode as { toolName?: unknown } | undefined)?.toolName === 'compact',
};

/** The flavors this package knows, by name (an instance's `flavor`). */
export const ACP_FLAVORS: Readonly<Record<string, AcpFlavor>> = { generic: genericFlavor, claude: claudeFlavor };

/** `f`'s hooks over `generic`'s. */
export function withDefaults(f: AcpFlavor): Required<Omit<AcpFlavor, 'matches' | 'displayName'>> & Pick<AcpFlavor, 'matches' | 'displayName'> {
  const g = genericFlavor;
  return {
    name: f.name,
    ...(f.matches ? { matches: f.matches } : {}),
    ...(f.displayName !== undefined ? { displayName: f.displayName } : {}),
    planMode: f.planMode ?? g.planMode!,
    restrictedMode: f.restrictedMode ?? g.restrictedMode!,
    compactCommand: f.compactCommand ?? g.compactCommand!,
    mcpTool: f.mcpTool ?? g.mcpTool!,
    subagent: f.subagent ?? g.subagent!,
    compaction: f.compaction ?? g.compaction!,
    elicitationQuestions: f.elicitationQuestions ?? g.elicitationQuestions!,
  };
}

/** The flavor of an agent that named itself `info`, among `known` (the first that matches), else generic. */
export function flavorFor(info: { name?: string; title?: string | null } | undefined, known: readonly AcpFlavor[] = Object.values(ACP_FLAVORS)): AcpFlavor {
  return known.find((f) => f.matches?.(info)) ?? genericFlavor;
}
