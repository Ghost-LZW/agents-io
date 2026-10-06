import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import type { HarnessAdapter, HarnessCaps, HarnessOpenArgs, HarnessSession } from '@agents-io/protocol';
import { AsyncQueue } from './queue.js';
import { ClaudeCodeSession, defaultProfile, isEffort } from './session.js';
import type { ClaudeCodeOptions, Options, QueryFn, SDKUserMessage } from './types.js';

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
};

export interface ClaudeCodeHarnessConfig {
  /** Path of the `claude` CLI to drive (default: first `claude` on PATH). */
  claudePath?: string;
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

export function cliVersionOf(path: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(path, ['--version'], { timeout: 15_000 }, (err, stdout) => {
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

  probe(): Promise<{ version: string; caps: HarnessCaps }> {
    this.probed ??= (async () => {
      const sdk = this.config.sdkVersion ?? readSdkVersion();
      const cli = await (this.config.cliVersion ?? (() => cliVersionOf(this.claudePath())))();
      assertSupported(sdk, cli);
      return { version: `claude-code ${cli} (agent-sdk ${sdk})`, caps: claudeCodeCaps };
    })();
    this.probed.catch(() => (this.probed = undefined));
    return this.probed;
  }

  async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    await this.probe();
    const options = (args.options ?? {}) as ClaudeCodeOptions;
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

    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'agents-io/0.1.0',
      ...options.env,
    };
    // A restart must not silently re-run side effects of an interrupted turn.
    delete env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;

    const mcpServers: Options['mcpServers'] = { ...(options.sdk?.mcpServers ?? {}) };
    if (args.mcp) {
      mcpServers[options.mcpServerName ?? 'agents_io'] = {
        type: options.mcpTransport ?? 'http',
        url: args.mcp.url,
        headers: { Authorization: `Bearer ${args.mcp.token}` },
      };
    }

    const sdkOptions: Options = {
      ...options.sdk,
      cwd: args.cwd,
      model: args.run.model,
      ...(isEffort(args.run.effort) ? { effort: args.run.effort } : {}),
      permissionMode,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(profile.allowedTools ? { allowedTools: profile.allowedTools } : {}),
      ...(profile.disallowedTools ? { disallowedTools: profile.disallowedTools } : {}),
      ...(profile.additionalDirectories ? { additionalDirectories: profile.additionalDirectories } : {}),
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

async function loadQuery(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as unknown as QueryFn;
}
