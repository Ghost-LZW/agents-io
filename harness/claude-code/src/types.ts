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
  /** Raw SDK options merged last (escape hatch; adapter-owned fields win). */
  sdk?: Partial<Options>;
  /** Max chars of a tool result preview (default 400). */
  previewChars?: number;
}

/** What the adapter needs from a `Query`; `cancelAsyncMessage` exists at runtime but is untyped in 0.3.x. */
export type QueryLike = AsyncIterable<SDKMessage> &
  Pick<Query, 'interrupt' | 'setModel' | 'setPermissionMode' | 'applyFlagSettings' | 'close'> & {
    cancelAsyncMessage?(uuid: string): Promise<boolean>;
  };

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

export type { PermissionResult, SDKMessage, SDKUserMessage, Options };
