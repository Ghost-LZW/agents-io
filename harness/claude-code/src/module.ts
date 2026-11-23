import { Type, type Static } from '@sinclair/typebox';
import type { HarnessModule, HarnessResolveContext } from '@agents-io/protocol';
import { CLAUDE_CODE_DECLARATIONS, ClaudeCodeHarness, findOnPath, type ClaudeCodeHarnessConfig } from './adapter.js';
import { TUI_BRIDGE_COMMAND, tuiBridge } from './bridge.js';

/*
 * The Claude Code harness kind (`use: "claude-code"`, and the `claude-code` section of the older
 * `harness` block): its config keys, defaults and construction. The daemon registers it in its
 * bundle, first: it is the kind of a config that names none.
 */

/** A `use: "claude-code"` instance's own keys (beside `use`, `env`, `cwd`, `run`, `profiles`, `options`). */
const Instance = Type.Object({
  /** CLAUDE_CONFIG_DIR: login, user settings, user skills/agents/commands, transcripts (default ~/.claude). */
  configDir: Type.Optional(Type.String()),
  /** The `claude` CLI (default: first on PATH). */
  executable: Type.Optional(Type.String()),
  /** Flag-layer settings: a settings.json path, or an inline object (Agent SDK `settings`). */
  settings: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())])),
  /** Which settings files load (`[]` = none; default all). */
  settingSources: Type.Optional(Type.Array(Type.Union([Type.Literal('user'), Type.Literal('project'), Type.Literal('local')]))),
  mcpServers: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()))),
  /** Local plugin directories (each may carry skills, agents, commands, hooks). */
  plugins: Type.Optional(Type.Array(Type.String())),
  /** Skills to enable: "all" or names (default: the CLI's own). */
  skills: Type.Optional(Type.Union([Type.Literal('all'), Type.Array(Type.String())])),
  /** Extra CLI flags: name without `--` → value, null for a bare flag. */
  extraArgs: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
  additionalDirectories: Type.Optional(Type.Array(Type.String())),
});

/** The older block's `harness.claude-code` section (beside `run`, `profiles`, `options`). */
const LegacySection = Type.Object({ claudePath: Type.Optional(Type.String()) });

/** Claude Code launch settings (ClaudeCodeHarnessConfig): what an instance's entry resolves to (`HarnessInstance.launch`). */
export interface ClaudeLaunch {
  claudePath?: string;
  configDir?: string;
  settings?: string | Record<string, unknown>;
  settingSources?: ('user' | 'project' | 'local')[];
  mcpServers?: Record<string, Record<string, unknown>>;
  plugins?: string[];
  skills?: 'all' | string[];
  extraArgs?: Record<string, string | null>;
  additionalDirectories?: string[];
}

const pathish = (p: string) => p.startsWith('~') || p.startsWith('.') || p.includes('/');

export const claudeCodeHarnessModule: HarnessModule<ClaudeLaunch> = {
  kind: 'claude-code',
  schema: Instance,
  defaults: { model: 'haiku', modelEnv: 'AGENTS_IO_LIVE_CLAUDE_MODEL', configDirEnv: ['CLAUDE_CONFIG_DIR'] },
  declares: CLAUDE_CODE_DECLARATIONS,
  // The adapter reads them from the open options (`ClaudeCodeOptions.profiles`), as it always has.
  profilesInOpen: true,
  // The terminal UI's bridge (`takeover`): its MCP config starts `aio tui-bridge` as the TUI's child.
  cli: { [TUI_BRIDGE_COMMAND]: ({ env }) => tuiBridge(env) },
  legacy: {
    schema: LegacySection,
    envPrefixes: ['ANTHROPIC_', 'CLAUDE_'],
    resolve: (s, ctx) => {
      const x = s as Static<typeof LegacySection>;
      return x.claudePath ? { claudePath: ctx.path(x.claudePath) } : {};
    },
  },

  resolve(entry, ctx) {
    const x = entry as Static<typeof Instance>;
    const where = ctx.where;
    if ('CLAUDE_CONFIG_DIR' in ctx.env && x.configDir) ctx.fail(`${where}: set \`configDir\` or env.CLAUDE_CONFIG_DIR, not both`);
    const launch: ClaudeLaunch = {
      ...(x.executable ? { claudePath: pathish(x.executable) ? ctx.path(x.executable) : x.executable } : {}),
      ...(x.configDir ? { configDir: ctx.path(x.configDir) } : {}),
      ...(x.settings !== undefined ? { settings: typeof x.settings === 'string' ? ctx.path(x.settings) : claudeSettingsViaEnv(x.settings, `${where}.settings`, ctx) } : {}),
      ...(x.settingSources ? { settingSources: x.settingSources } : {}),
      ...(x.mcpServers ? { mcpServers: claudeMcpViaEnv(x.mcpServers, `${where}.mcpServers`, ctx) } : {}),
      ...(x.plugins ? { plugins: x.plugins.map((p) => ctx.path(p)) } : {}),
      ...(x.skills !== undefined ? { skills: x.skills } : {}),
      ...(x.extraArgs ? { extraArgs: x.extraArgs } : {}),
      ...(x.additionalDirectories ? { additionalDirectories: x.additionalDirectories.map((p) => ctx.path(p)) } : {}),
    };
    return { launch };
  },

  create(init) {
    const x = init.launch;
    // A bare name is looked up on the instance's PATH (else the daemon's), as the CLI would be.
    const claudePath = x.claudePath && !x.claudePath.includes('/') ? (findOnPath(x.claudePath, init.env.PATH ?? process.env.PATH) ?? x.claudePath) : x.claudePath;
    const config: ClaudeCodeHarnessConfig = {
      env: init.env,
      ...(claudePath ? { claudePath } : {}),
      // The terminal UI runs the command as configured: `aio tui` looks a bare name up on its own PATH.
      ...(x.claudePath ? { tuiCommand: x.claudePath } : {}),
      ...(x.configDir ? { configDir: x.configDir } : {}),
      ...(x.settings !== undefined ? { settings: x.settings as ClaudeCodeHarnessConfig['settings'] } : {}),
      ...(x.settingSources ? { settingSources: x.settingSources } : {}),
      ...(x.mcpServers ? { mcpServers: x.mcpServers as ClaudeCodeHarnessConfig['mcpServers'] } : {}),
      ...(x.plugins ? { plugins: x.plugins } : {}),
      ...(x.skills !== undefined ? { skills: x.skills } : {}),
      ...(x.extraArgs ? { extraArgs: x.extraArgs } : {}),
      ...(x.additionalDirectories ? { additionalDirectories: x.additionalDirectories } : {}),
      ...(init.blobs ? { blobs: init.blobs } : {}),
    };
    return new ClaudeCodeHarness(config);
  },
};

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envRef = (v: unknown): string | undefined => (typeof v === 'string' && v.startsWith('env:') ? v.slice(4) : undefined);

/** Claude `mcpServers`: "env:NAME" becomes `${NAME}` (the CLI expands it in command, args, env, url, headers). */
function claudeMcpViaEnv<T>(v: T, at: string, ctx: Pick<HarnessResolveContext, 'secrets'>): T {
  const name = envRef(v);
  if (name !== undefined) {
    const value = ctx.secrets.value(name, at);
    if (value !== undefined) ctx.secrets.toChild(name, value, at);
    return `\${${name}}` as T;
  }
  if (Array.isArray(v)) return v.map((x, i) => claudeMcpViaEnv(x, `${at}[${i}]`, ctx)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, claudeMcpViaEnv(x, `${at}.${k}`, ctx)])) as T;
  return v;
}

/** Claude inline `settings` (passed as `--settings <json>`): "env:NAME" only under `settings.env`, moved to the child env. */
function claudeSettingsViaEnv(st: Record<string, unknown>, at: string, ctx: Pick<HarnessResolveContext, 'secrets' | 'fail'>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(st)) {
    if (k === 'env' && v && typeof v === 'object' && !Array.isArray(v)) {
      const kept: Record<string, unknown> = {};
      for (const [vk, vv] of Object.entries(v)) {
        const name = envRef(vv);
        if (name === undefined) kept[vk] = vv;
        else if (!VAR_NAME.test(vk)) ctx.fail(`${at}.env: ${JSON.stringify(vk)} is not a variable name`);
        else {
          const value = ctx.secrets.value(name, `${at}.env.${vk}`);
          if (value !== undefined) ctx.secrets.toChild(vk, value, `${at}.env.${vk}`);
        }
      }
      out[k] = kept;
    } else out[k] = noEnvRefs(v, `${at}.${k}`, 'the claude command line (--settings)', 'set it under settings.env or the instance env', ctx);
  }
  return out;
}

function noEnvRefs(v: unknown, at: string, line: string, hint: string, ctx: Pick<HarnessResolveContext, 'fail'>): unknown {
  if (envRef(v) !== undefined) ctx.fail(`${at}: "env:" values would be on ${line}, visible to other local users via ps; ${hint}`);
  if (Array.isArray(v)) v.forEach((x, i) => noEnvRefs(x, `${at}[${i}]`, line, hint, ctx));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) noEnvRefs(x, `${at}.${k}`, line, hint, ctx);
  return v;
}
