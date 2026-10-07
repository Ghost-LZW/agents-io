import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import type { HarnessAdapter, HarnessCaps, HarnessOpenArgs, HarnessSession } from '@agents-io/protocol';
import { AsyncQueue } from './queue.js';
import { ClaudeCodeSession, defaultProfile, isEffort } from './session.js';
import type { ClaudeCodeOptions, ClaudeProfile, Options, QueryFn, SDKUserMessage } from './types.js';

/** SDK 0.x: the minor is the breaking component. */
export const SUPPORTED_SDK = /^0\.3\./;
export const SUPPORTED_CLI = /^2\./;

export const claudeCodeCaps: HarnessCaps = {
  steer: 'tool_boundary',
  interrupt: true,
  approvals: true,
  questions: true,
  tokenDeltas: true,
  // Query.cancelAsyncMessage ships in sdk.mjs 0.3.x (control_request cancel_async_message) but is untyped.
  cancelQueued: true,
  // shouldQuery:false exists but is unverified in headless mode; not offered.
  injectWithoutTurn: false,
  resume: true,
  switchModelMidSession: true,
  // Tool-list changes need a new CLI process; permission-mode-only changes do not.
  switchProfileMidSession: false,
};

/**
 * How this adapter launches Claude Code: one value per deployment harness
 * instance. Everything is optional; omitted means the CLI's own default.
 */
export interface ClaudeCodeHarnessConfig {
  /** Path of the `claude` CLI to drive (default: first `claude` on PATH). */
  claudePath?: string;
  /**
   * Environment for the CLI, over `process.env` (an `undefined` value removes
   * the variable). Per-open `ClaudeCodeOptions.env` goes over this.
   */
  env?: Record<string, string | undefined>;
  /**
   * Claude Code's config directory (`CLAUDE_CONFIG_DIR`, default `~/.claude`):
   * login, user settings, user skills/agents/commands, session transcripts.
   * Wins over `env.CLAUDE_CONFIG_DIR`.
   */
  configDir?: string;
  /** Flag-layer settings: a settings.json path or an object (SDK `settings`, CLI `--settings`). */
  settings?: Options['settings'];
  /** Filesystem settings to load (SDK `settingSources`; `[]` = none, omitted = all). */
  settingSources?: Options['settingSources'];
  /** MCP servers for every session (the host's `HarnessOpenArgs.mcp` server is added on top). */
  mcpServers?: Options['mcpServers'];
  /** Local plugin directories (SDK `plugins: [{ type: 'local', path }]`, CLI `--plugin-dir`). */
  plugins?: string[];
  /** Skills to enable (SDK `skills`): `'all'` or names. Omitted: the CLI's defaults. */
  skills?: Options['skills'];
  /** Extra CLI flags (SDK `extraArgs`: name without `--` → value, `null` for a bare flag). */
  extraArgs?: Record<string, string | null>;
  /** Directories every session may access besides `cwd` (merged with the profile's). */
  additionalDirectories?: string[];
  /** Profile name → native settings, defaults for every session (per-open `options.profiles` win). */
  profiles?: Record<string, ClaudeProfile>;
  /** Injected `query` (tests). Default: the Agent SDK's. */
  query?: QueryFn;
  /** Override detected versions (tests). */
  sdkVersion?: string;
  cliVersion?: () => Promise<string>;
}

export function findOnPath(bin: string, path = process.env.PATH ?? ''): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // next
    }
  }
  return undefined;
}

export function readSdkVersion(): string {
  const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  return (JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version: string }).version;
}

export function cliVersionOf(path: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(path, ['--version'], { timeout: 15_000, ...(env ? { env } : {}) }, (err, stdout) => {
      if (err) return reject(new Error(`cannot run ${path} --version: ${err.message}`));
      const m = /(\d+\.\d+\.\d+)/.exec(stdout);
      if (!m) return reject(new Error(`unrecognized ${path} --version output: ${stdout.trim()}`));
      resolve(m[1]!);
    }),
  );
}

/** Throws unless both versions are ones this adapter was written against. */
export function assertSupported(sdk: string, cli: string): void {
  if (!SUPPORTED_SDK.test(sdk))
    throw new Error(`@agents-io/harness-claude-code: unsupported Claude Agent SDK ${sdk} (supported: 0.3.x)`);
  if (!SUPPORTED_CLI.test(cli))
    throw new Error(`@agents-io/harness-claude-code: unsupported Claude Code CLI ${cli} (supported: 2.x)`);
}

/**
 * Drives the locally installed Claude Code CLI through the official Agent SDK's
 * `query()` with streaming input. No agent loop of its own.
 */
export class ClaudeCodeHarness implements HarnessAdapter {
  readonly id = 'claude-code';
  private probed: Promise<{ version: string; caps: HarnessCaps }> | undefined;

  constructor(private readonly config: ClaudeCodeHarnessConfig = {}) {}

  private claudePath(): string {
    const p = this.config.claudePath ?? findOnPath('claude');
    if (!p) throw new Error('@agents-io/harness-claude-code: `claude` CLI not found on PATH; set claudePath');
    return p;
  }

  /** process.env < config.env < CLAUDE_CONFIG_DIR < options.env < args.env (per session, top layer); undefined values removed. */
  private childEnv(extra?: Record<string, string | undefined>): Record<string, string> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'agents-io/0.1.0',
      ...this.config.env,
      ...(this.config.configDir ? { CLAUDE_CONFIG_DIR: this.config.configDir } : {}),
      ...extra,
    };
    // A restart must not silently re-run side effects of an interrupted turn.
    delete env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    return env as Record<string, string>;
  }

  probe(): Promise<{ version: string; caps: HarnessCaps }> {
    this.probed ??= (async () => {
      const sdk = this.config.sdkVersion ?? readSdkVersion();
      const cli = await (this.config.cliVersion ?? (() => cliVersionOf(this.claudePath(), this.childEnv())))();
      assertSupported(sdk, cli);
      return { version: `claude-code ${cli} (agent-sdk ${sdk})`, caps: claudeCodeCaps };
    })();
    this.probed.catch(() => (this.probed = undefined));
    return this.probed;
  }

  async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    await this.probe();
    const c = this.config;
    const given = (args.options ?? {}) as ClaudeCodeOptions;
    const options: ClaudeCodeOptions = { ...given, profiles: { ...c.profiles, ...given.profiles } };
    const profile = options.profiles?.[args.run.profile] ?? defaultProfile(args.run.profile);
    const permissionMode = profile.permissionMode ?? 'default'; // never omit: the CLI default may be 'auto'
    const sessionId = args.resume ?? randomUUID();
    const prompt = new AsyncQueue<SDKUserMessage>();
    const stderr: string[] = [];

    const session: ClaudeCodeSession = new ClaudeCodeSession({
      args,
      options,
      profile,
      sessionId,
      prompt,
      stderrTail: () => stderr.slice(-20).join('').trim(),
    });

    const env = this.childEnv({ ...options.env, ...args.env });

    const mcpServers: Options['mcpServers'] = { ...c.mcpServers, ...options.sdk?.mcpServers };
    const hostServer = options.mcpServerName ?? 'agents_io';
    if (args.mcp) {
      const transport = options.mcpTransport ?? args.mcp.transport ?? 'http';
      // The SDK passes mcpServers to the CLI as `--mcp-config <json>` (argv, readable via ps by
      // other local users). The token goes in the CLI's env instead; the CLI expands ${VAR} in headers.
      env[MCP_TOKEN_ENV] = args.mcp.token;
      mcpServers[hostServer] = {
        type: transport,
        url: args.mcp.url,
        headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
        // Host output tools are always in the prompt, never deferred behind tool search.
        ...(transport === 'http' ? { alwaysLoad: true } : {}),
      } as NonNullable<Options['mcpServers']>[string];
    }
    // Host tools check their own destinations (Policy.outbound): never ask a person to approve them.
    const allowedTools =
      args.mcp && options.mcpAutoAllow !== false ? [...new Set([...(profile.allowedTools ?? []), `mcp__${hostServer}`])] : profile.allowedTools;

    const additionalDirectories = [...new Set([...(c.additionalDirectories ?? []), ...(profile.additionalDirectories ?? [])])];
    const sdkOptions: Options = {
      ...(c.settings !== undefined ? { settings: c.settings } : {}),
      ...(c.settingSources ? { settingSources: c.settingSources } : {}),
      ...(c.plugins?.length ? { plugins: c.plugins.map((path) => ({ type: 'local' as const, path })) } : {}),
      ...(c.skills !== undefined ? { skills: c.skills } : {}),
      ...(c.extraArgs ? { extraArgs: c.extraArgs } : {}),
      ...options.sdk,
      cwd: args.cwd,
      model: args.run.model,
      ...(isEffort(args.run.effort) ? { effort: args.run.effort } : {}),
      permissionMode,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(profile.disallowedTools ? { disallowedTools: profile.disallowedTools } : {}),
      ...(additionalDirectories.length ? { additionalDirectories } : {}),
      permissionPrompts: profile.permissionPrompts ?? 'host',
      // bypassPermissions never consults canUseTool (the SDK warns when both are set).
      ...(permissionMode === 'bypassPermissions' ? {} : { canUseTool: session.canUseTool }),
      includePartialMessages: true,
      forwardSubagentText: options.forwardSubagentText ?? false,
      agentProgressSummaries: options.agentProgressSummaries ?? false,
      ...(args.resume ? { resume: args.resume } : { sessionId }),
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      pathToClaudeCodeExecutable: this.claudePath(),
      env,
      stderr: (d: string) => {
        stderr.push(d);
        if (stderr.length > 200) stderr.splice(0, stderr.length - 200);
        options.sdk?.stderr?.(d);
      },
    };

    const query = this.config.query ?? (await loadQuery());
    session.attach(query({ prompt, options: sdkOptions }));
    return session;
  }
}

/** Env var carrying the host MCP bearer token to the CLI (referenced as ${…} in the server's headers). */
const MCP_TOKEN_ENV = 'AGENTS_IO_MCP_TOKEN';

async function loadQuery(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as unknown as QueryFn;
}
