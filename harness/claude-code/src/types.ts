import type {
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/** Harness-native permission settings a profile name maps to (deployment config). */
export interface ClaudeProfile {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  /** 'none' denies anything that would prompt instead of asking the host. */
  permissionPrompts?: 'host' | 'none';
  /**
   * Models this profile runs on in `bypassPermissions` (HC-5): a name as `run.model` or a fallback
   * gives it (`opus`, `claude-opus-5-5`), a trailing `*` matches a prefix (`claude-opus-*`). On any
   * other model the profile runs in `permissionMode` (never bypass then). The mode follows the model
   * the CLI runs at each turn's start; within a turn a model change only ever tightens it.
   */
  bypassModels?: string[];
}

/** Resolves an image `ref` (e.g. `sha256:<hex>`) to bytes the model can see. */
export type ImageResolver = (
  ref: string,
  mime: string,
) => Promise<{ base64: string; mime?: string } | undefined>;

/** Resolves a file/audio `ref` to a local path the agent can read with its tools; undefined keeps the ref as text. */
export type FileResolver = (ref: string, mime: string, name?: string) => Promise<{ path: string } | undefined>;

/** `HarnessOpenArgs.options` understood by this adapter. Everything is optional. */
export interface ClaudeCodeOptions {
  /** Profile name → native permission settings. Unknown profiles fall back to the defaults below. */
  profiles?: Record<string, ClaudeProfile>;
  /** Image refs are skipped (with a notice) when absent. */
  resolveImage?: ImageResolver;
  /** File and audio refs are shown as a ref line when absent (or when it returns nothing). */
  resolveFile?: FileResolver;
  /** MCP server name for `HarnessOpenArgs.mcp` (default `agents_io`). */
  mcpServerName?: string;
  /** MCP transport for `HarnessOpenArgs.mcp` (default: `mcp.transport`, else `http`). */
  mcpTransport?: 'http' | 'sse';
  /** Add an allow rule `mcp__<mcpServerName>` so host tools never prompt (default true; they enforce Policy.outbound themselves). */
  mcpAutoAllow?: boolean;
  /**
   * Host output tools in every request (Claude Code `alwaysLoad` on the host server; default true).
   * `false`: with tool search on (`ENABLE_TOOL_SEARCH`) only their names are in the prompt and the
   * model loads one through ToolSearch when it needs it, like any MCP tool. The final text is still
   * the reply; a turn that sends a file, a choice or an extra message pays one ToolSearch call.
   * HTTP transport only (Claude Code ignores it on SSE).
   */
  mcpAlwaysLoad?: boolean;
  /** Forward subagent text and thinking (SDK `forwardSubagentText`). */
  forwardSubagentText?: boolean;
  /** Model-generated progress summaries for subagents (SDK `agentProgressSummaries`, costs tokens). */
  agentProgressSummaries?: boolean;
  /**
   * Mark inputs `client_composed`: no `@path` expansion and no slash-command dispatch.
   * Also skips the CLAUDE.md/skills attachment pass, so it is off by default.
   */
  clientComposed?: boolean;
  /** Extra environment for the CLI. `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` is always removed. */
  env?: Record<string, string | undefined>;
  /**
   * Raw SDK options merged last (escape hatch; adapter-owned fields win). `systemPrompt` defaults to
   * Claude Code's own (`{ type: 'preset', preset: 'claude_code' }`); set it here to append or replace.
   */
  sdk?: Partial<Options>;
  /** Max chars of a tool result preview (default 400). */
  previewChars?: number;
  /**
   * First-byte watchdog (ms; default 30000, `0` = off). A turn that has shown no model output and
   * made no tool call this long after its inputs were written is interrupted and goes on on the
   * first fallback model whose model check passes, with a `system/model_fallback` native event
   * (`trigger: "first_byte_timeout"`): inputs the interrupted attempt held stay in Claude Code's
   * history and get a short "go on" message; ones it had not started are withdrawn and written
   * again. When every fallback fails its check the turn fails (`first_byte_timeout`). At most once
   * per turn; not when Claude Code already fell back in that turn, while it compacts, for a harness
   * command (`/compact`), or without a fallback model. The next turn starts on its own `run.model` again.
   */
  firstByteTimeoutMs?: number;
  /**
   * The model the watchdog switches to. Default: Claude Code's own `fallbackModel` (SDK
   * `fallbackModel` / `--fallback-model`, else the flag, local, project, user settings in the
   * CLI's order, as `settingSources` loads them), tried in order, skipping the model that hung.
   */
  firstByteFallbackModel?: string;
  /**
   * Idle deadline (ms; default 90000, `0` = off; HC-3b). Once a turn has had output, this long with
   * no CLI message while it waits on the model (no tool running, no open permission request, not
   * compacting, not a harness command) ends the wait. When no tool that may change something ran in
   * the turn (only {@link READ_ONLY_TOOLS}), the CLI is interrupted and goes on on the next fallback
   * model (`system/model_fallback`, `trigger: "idle_timeout"`; the turn so far stays in its history
   * and a short "go on" message runs it; each model at most once per turn). Otherwise, or when no
   * fallback takes over, the turn ends `failed` (`idle_timeout`) with `idleStallNotice` as its answer:
   * nothing is run again.
   */
  idleTimeoutMs?: number;
  /** The answer of a turn the idle deadline ended (default {@link DEFAULT_STALL_NOTICE}; `{seconds}`, `{tools}`). */
  idleStallNotice?: string;
  /**
   * How long the idle deadline's interrupt waits for the CLI to give back a follow-up it has not
   * started (ms; default 2000). One it does not give back in time is carried, not consumed: never
   * written again while the CLI may hold it, and the CLI's run of it belongs to the next turn that is
   * given its inputs (HC-3b).
   */
  idleWithdrawWaitMs?: number;
}

/** What the adapter needs from a `Query`; `cancelAsyncMessage` exists at runtime but is untyped in 0.3.x. */
export type QueryLike = AsyncIterable<SDKMessage> &
  Pick<Query, 'interrupt' | 'setModel' | 'setPermissionMode' | 'applyFlagSettings' | 'close'> & {
    cancelAsyncMessage?(uuid: string): Promise<boolean>;
  };

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

export type { PermissionResult, SDKMessage, SDKUserMessage, Options };
