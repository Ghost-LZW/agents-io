import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Binding, IdentityEntry, Tier, WatchDraft, errors, type BindingTable, type Principal, type RunSpec, type WatchSource } from '@agents-io/protocol';
import { DEFAULT_BLOB_MAX_BYTES, Router, RouterError, checkIdentities, ownerIdentities, ownersTable, type AgentSpec } from '@agents-io/session';
import { loadEnvFile } from '@agents-io/testkit';
import type { CodexTransportOption } from '@agents-io/harness-codex';

/*
 * aio.config.json: what runs. Secrets never go in it: they come from the
 * environment or a gitignored `.env.live` (KEY=VALUE), and any string in a
 * channel's `config` or a harness instance's `env`, `settings`, `mcpServers`
 * or `config` written as "env:NAME" is replaced by that variable. Settings
 * that reach a child's command line (claude `mcpServers` and inline
 * `settings`, codex `config`) never get the value itself: it goes into the
 * child's environment and the setting names the variable (`${NAME}`,
 * `settings.env`, codex `env_http_headers` / `bearer_token_env_var` /
 * `env_key` / `env_vars`); where that is impossible "env:" is refused.
 *
 * Agents (`agents: { <name>: { harness, model?, effort?, profile?, cwd?, mode?,
 * tools?, instructionsFile? } }`) are named run configurations over the
 * instances; `bindings` (+ `identities`) is the local binding table
 * (docs/HOSTS.md §2). Without `bindings` the owners-based default table routes
 * to the default agent. Without `agents` there is one agent, `default`, on the
 * default instance (as before).
 *
 * Harnesses are NAMED INSTANCES (`harnesses: { <name>: { use, … } }`): each has
 * its own process environment and config dirs, `RunSpec.harness` is the
 * instance name, and the default policy plans `defaultHarness`. The older
 * single `harness: { use, 'claude-code': {…}, codex: {…} }` block still loads:
 * each section becomes an instance named after its kind.
 */

const Closed = { additionalProperties: false } as const;

const HarnessKind = Type.Union([Type.Literal('claude-code'), Type.Literal('codex')]);
export type HarnessKind = Static<typeof HarnessKind>;

const RunDefaults = Type.Object({ model: Type.Optional(Type.String()), effort: Type.Optional(Type.String()) }, Closed);
const Profiles = Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()));

const LegacySection = {
  /** RunSpec base; the policy adds `profile`. Env AGENTS_IO_LIVE_<CLAUDE|CODEX>_MODEL overrides `model`. */
  run: Type.Optional(RunDefaults),
  /** Profile name (`bypass`, `restricted`, …) → harness-native settings (ClaudeProfile / CodexProfile). */
  profiles: Type.Optional(Profiles),
  /** Passed through as HarnessOpenArgs.options (ClaudeCodeOptions / CodexOpenOptions). */
  options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
};

const CodexTransport = Type.Union([
  Type.Object({ kind: Type.Literal('stdio') }, Closed),
  Type.Object(
    {
      kind: Type.Literal('unix'),
      spawn: Type.Union([Type.Literal('own'), Type.Literal('daemon'), Type.Literal('none')]),
      path: Type.Optional(Type.String()),
      stateDir: Type.Optional(Type.String()),
      reconnectWindowMs: Type.Optional(Type.Number()),
    },
    Closed,
  ),
]);

const InstanceCommon = {
  /**
   * Environment for the harness process, over the gateway's own. Values may be
   * "env:NAME" (from the environment / .env.live); `null` removes a variable.
   */
  env: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
  /** Working directory for this instance's sessions (default: top-level `cwd`). */
  cwd: Type.Optional(Type.String()),
  /** RunSpec defaults; the policy adds `profile`. */
  run: Type.Optional(RunDefaults),
  /** Profile name (`bypass`, `restricted`, …) → harness-native settings (ClaudeProfile / CodexProfile). */
  profiles: Type.Optional(Profiles),
  /** Passed through as HarnessOpenArgs.options (ClaudeCodeOptions / CodexOpenOptions). */
  options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
};

const ClaudeInstance = Type.Object(
  {
    use: Type.Literal('claude-code'),
    ...InstanceCommon,
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
  },
  Closed,
);

const CodexInstance = Type.Object(
  {
    use: Type.Literal('codex'),
    ...InstanceCommon,
    /** CODEX_HOME: config.toml, auth, sessions, skills (default ~/.codex). */
    home: Type.Optional(Type.String()),
    /** The `codex` binary (default `codex` on PATH). */
    executable: Type.Optional(Type.String()),
    /** Dotted key → value, passed as `-c key=<TOML>` to `codex app-server` (argv: "env:NAME" only where Codex can name a variable). */
    config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    enable: Type.Optional(Type.Array(Type.String())),
    disable: Type.Optional(Type.Array(Type.String())),
    transport: Type.Optional(CodexTransport),
    /** Not supported: `codex app-server` rejects --profile (checked: codex-cli 0.160). Listed to give a clear error. */
    profile: Type.Optional(Type.String()),
  },
  Closed,
);

const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const ChannelCommon = {
  account: Type.Optional(Type.String()),
  /** Rendering tier for this channel (default: the adapter's `caps.defaultTier`). */
  tier: Type.Optional(Tier),
};

const ChannelEntry = Type.Union([
  /**
   * Feishu/Lark bot, one app per entry. `config.appId` / `config.appSecret` / `config.domain`
   * (values or "env:NAME"; the whole config is env-substituted) name the app; an entry
   * without them reads LARK_APP_ID / LARK_APP_SECRET / LARK_DOMAIN (at most one such entry).
   */
  Type.Object({ type: Type.Literal('lark-bot'), ...ChannelCommon, config: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, Closed),
  /** IMAP/SMTP mail: a MailChannelConfig (use "env:NAME" for passwords). */
  Type.Object({ type: Type.Literal('mail'), ...ChannelCommon, config: Type.Record(Type.String(), Type.Unknown()) }, Closed),
  /** Out-of-process channel spoken to over JSONL stdio (jsonl-bridge `spawnChannel`); how private channels attach. */
  Type.Object(
    {
      type: Type.Literal('bridge'),
      ...ChannelCommon,
      /** The adapter id the peer declares in `hello`; shown (e.g. in status) while the peer has not connected yet. Default `bridge`. */
      id: Type.Optional(Type.String()),
      command: Type.String(),
      args: Type.Optional(Type.Array(Type.String())),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      cwd: Type.Optional(Type.String()),
      config: Type.Optional(Type.Unknown()),
    },
    Closed,
  ),
]);
export type ChannelEntry = Static<typeof ChannelEntry>;

const AgentEntry = Type.Object(
  {
    /** Harness instance (a name from `harnesses`). */
    harness: Type.String(),
    /** Over the instance's `run.model`. */
    model: Type.Optional(Type.String()),
    effort: Type.Optional(Type.String()),
    /**
     * Permission profile of every turn. Interactive default: the policy's (`bypass` when only owners
     * triggered the turn, else `restricted`); task default `restricted`.
     */
    profile: Type.Optional(Type.String()),
    /** Working directory (over the instance's and the top-level `cwd`); a run may name its own. */
    cwd: Type.Optional(Type.String()),
    /** `task`: only `run.start` / `aio run` runs it; no binding may target it. Default `interactive`. */
    mode: Type.Optional(Type.Union([Type.Literal('interactive'), Type.Literal('task')])),
    /** Mount the host MCP output tools (default: top-level `outputTools`). */
    tools: Type.Optional(Type.Boolean()),
    /** Extra system instructions read from this file (Claude: appended to the preset prompt; Codex: developer instructions). */
    instructionsFile: Type.Optional(Type.String()),
    /**
     * Bounds within which a host may launch this agent's sessions with their own cwd and
     * env (decision 7: callout answers' `launch`, `session.prepare`). Without it every
     * launch is refused. Interactive agents only.
     */
    sessionParams: Type.Optional(
      Type.Object(
        {
          /** `launch.cwd` must be under one of these (after realpath). Relative paths are relative to the config file. */
          cwdRoots: Type.Array(Type.String()),
          /** The only variables `launch.env` may set (never `AGENTS_IO_*`). */
          envKeys: Type.Array(Type.String()),
          /**
           * Variables whose values are paths, checked like `cwd` against their own roots.
           * Required for `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when they are in `envKeys`;
           * any other path-valued key left out here (`HOME`, `XDG_CONFIG_HOME`, `GIT_DIR`, …)
           * lets the host name any path for it.
           */
          envPathRoots: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
        },
        Closed,
      ),
    ),
  },
  Closed,
);

export const ConfigFile = Type.Object(
  {
    /** State directory (default ~/.agents-io/aio). Relative paths are relative to the config file. */
    dataDir: Type.Optional(Type.String()),
    /** SQLite session log (default <dataDir>/log.sqlite; ":memory:" for none). */
    logPath: Type.Optional(Type.String()),
    /** Local client socket (default <dataDir>/run/aio.sock). A missing directory is created 0700; an existing one must already be ours and 0700. */
    socketPath: Type.Optional(Type.String()),
    /**
     * Content-addressed store for inbound media (`sha256:<hex>` refs): Lark images/files and
     * mail attachments are kept here and handed to the harnesses. Default dir <dataDir>/blobs,
     * maxBytes 20 MiB per blob.
     */
    blobs: Type.Optional(Type.Object({ dir: Type.Optional(Type.String()), maxBytes: Type.Optional(Type.Number({ minimum: 1 })) }, Closed)),
    /** Working directory for harness sessions (default: the current directory). */
    cwd: Type.Optional(Type.String()),
    /** Named harness instances; `RunSpec.harness` is the name. Each entry is checked against its `use`. */
    harnesses: Type.Optional(Type.Record(Type.String(), Type.Object({ use: HarnessKind }))),
    /** Instance the default policy plans (default: the only one, else the first). */
    defaultHarness: Type.Optional(Type.String()),
    /** Older single-harness form; each section becomes an instance named after its kind. */
    harness: Type.Optional(
      Type.Object(
        {
          use: Type.Optional(HarnessKind),
          'claude-code': Type.Optional(Type.Object({ ...LegacySection, claudePath: Type.Optional(Type.String()) }, Closed)),
          codex: Type.Optional(Type.Object({ ...LegacySection, bin: Type.Optional(Type.String()), transport: Type.Optional(CodexTransport) }, Closed)),
        },
        Closed,
      ),
    ),
    /** Named run configurations (agents); see AgentEntry. */
    agents: Type.Optional(Type.Record(Type.String(), AgentEntry)),
    /** Agent of the owners default table and of rules that name none (default: the first interactive agent). */
    defaultAgent: Type.Optional(Type.String()),
    /** The local binding table (docs/HOSTS.md §2). Without it the owners-based default table applies. */
    bindings: Type.Optional(Type.Array(Binding)),
    /** Identity map entries (channel identity → principal + labels), next to the ones `policy.owners` makes. */
    identities: Type.Optional(Type.Array(IdentityEntry)),
    channels: Type.Optional(Type.Array(ChannelEntry)),
    /**
     * Mount the host MCP output tools (send_file, ask_choice, mention, reply_to,
     * send_message, get_channel_context) into every harness instance (default true).
     */
    outputTools: Type.Optional(Type.Boolean()),
    /**
     * Topics (decision 6). `parkedIdleMs`: a parked topic's lane (and harness session) closes
     * once it has been parked and idle this long (default 30 min; 0 = never); switching back
     * reopens it, resuming the harness session by its native id.
     */
    topics: Type.Optional(Type.Object({ parkedIdleMs: Type.Optional(Type.Number({ minimum: 0 })) }, Closed)),
    policy: Type.Optional(
      Type.Object(
        {
          /** `${channel}:${channelUserId}`, e.g. `lark-bot:<union_id>`. Env AGENTS_IO_OWNERS (comma separated) adds more. */
          owners: Type.Optional(Type.Array(Type.String())),
          selfAccounts: Type.Optional(Type.Array(Type.String())),
          agentAccounts: Type.Optional(Type.Array(Type.String())),
          /** Put every owner DM (any channel) into this one session. */
          ownerSessionKey: Type.Optional(Type.String()),
          routes: Type.Optional(Type.Array(Type.String())),
          /**
           * Sources an agent may watch without asking (defaultPolicy `watchAllowlist`):
           * each entry matches when every field it sets equals the watch source's.
           */
          watchAllowlist: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  channel: Type.Optional(Type.String()),
                  account: Type.Optional(Type.String()),
                  conversation: Type.Optional(Type.String()),
                  conversationKind: Type.Optional(WatchDraft.properties.source.properties.conversationKind),
                },
                Closed,
              ),
            ),
          ),
        },
        Closed,
      ),
    ),
    /**
     * Watches the owner sets up (loaded at start, created as the local principal).
     * Each needs an `id`; an existing watch with that id is replaced, so editing
     * the config takes effect on restart.
     */
    watches: Type.Optional(Type.Array(Type.Intersect([WatchDraft, Type.Object({ id: Type.String() })]))),
    /**
     * The console API (HTTP + WebSocket for web UIs; protocol admin.ts). Default on for
     * `aio serve`, on 127.0.0.1:7464. A non-loopback `host` is refused unless
     * `allowRemote` is true (then every request still needs a token).
     */
    console: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          host: Type.Optional(Type.String()),
          /** 0: any free port (the URL is written next to the socket, `<socket>.console`). */
          port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
          allowRemote: Type.Optional(Type.Boolean()),
          /**
           * Extra names the `Host` header may carry (anti DNS rebinding), e.g. the LAN name or
           * address remote browsers use. Loopback names and a concrete `host` are always accepted.
           * Required with a wildcard `host` (0.0.0.0, ::) and `allowRemote`.
           */
          allowedHosts: Type.Optional(Type.Array(Type.String())),
          /** Origins of separately hosted UIs allowed to call the API (CORS); none by default. */
          origins: Type.Optional(Type.Array(Type.String())),
          /** Where the UI is; login links point there (default: the console URL itself). */
          uiUrl: Type.Optional(Type.String()),
          /** Lifetime of console sessions from a login link (default 12 h). */
          sessionTtlMs: Type.Optional(Type.Number({ minimum: 1000 })),
          /**
           * WebSocket heartbeat of `/ws`: a ping every `intervalMs` (default 30 s; 0 turns it off);
           * a connection that has not answered (pong, or any message) within `timeoutMs` after a
           * ping (default 10 s) is closed, which frees the host role it held.
           */
          heartbeat: Type.Optional(
            Type.Object({ intervalMs: Type.Optional(Type.Integer({ minimum: 0 })), timeoutMs: Type.Optional(Type.Integer({ minimum: 100 })) }, Closed),
          ),
          /** create-lark-bot invocation for `POST /api/bots/lark` (argv; default npx of the pinned release). */
          larkBotCommand: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
        },
        Closed,
      ),
    ),
    /**
     * The host connection. `tokenFile`: an operator-set host token, stable across restarts
     * (relative paths are relative to the config file). Read when the file exists (it must be
     * ours, 0600-ish, in a directory others cannot write); otherwise generated and written there
     * (0600). Without it every start makes a fresh token. `aio serve --token-file` wins.
     * The token is still copied to `<socket>.token` for the CLI.
     */
    host: Type.Optional(Type.Object({ tokenFile: Type.Optional(Type.String()) }, Closed)),
    /** Who local socket clients are. */
    local: Type.Optional(
      Type.Object(
        {
          /** Principal id (default: the first owner, else `local:owner`). */
          principal: Type.Optional(Type.String()),
          labels: Type.Optional(Type.Array(Type.String())),
          /** Default session for attach/send (default: ownerSessionKey, else `local:main`). */
          session: Type.Optional(Type.String()),
        },
        Closed,
      ),
    ),
  },
  Closed,
);
export type ConfigFile = Static<typeof ConfigFile>;

interface InstanceBase {
  /** Instance name: `RunSpec.harness`, and the `harness` of its session events. */
  name: string;
  /** RunSpec defaults; `harness` is the instance name. */
  run: Omit<RunSpec, 'profile'>;
  profiles: Record<string, Record<string, unknown>>;
  /** HarnessOpenArgs.options passthrough. */
  options: Record<string, unknown>;
  /** Sessions of this instance run here (default: Config.cwd). */
  cwd?: string;
  /** Over the gateway's environment; `undefined` removes a variable. SECRET: never log values. */
  env: Record<string, string | undefined>;
  /** Why this instance cannot be built (a missing "env:NAME"); names the variable, never a value. */
  unavailable?: string;
}

/** Claude Code launch settings (ClaudeCodeHarnessConfig). */
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

/** Codex launch settings (CodexHarnessOptions). */
export interface CodexLaunch {
  bin?: string;
  codexHome?: string;
  config?: Record<string, unknown>;
  enable?: string[];
  disable?: string[];
  transport: CodexTransportOption;
}

export type HarnessInstance = InstanceBase & ({ kind: 'claude-code'; claude: ClaudeLaunch } | { kind: 'codex'; codex: CodexLaunch });

/** A named run configuration. */
export interface AgentConfig {
  name: string;
  /** Harness instance name. */
  harness: string;
  model?: string;
  effort?: string;
  profile?: string;
  cwd?: string;
  mode: 'interactive' | 'task';
  /** Host MCP output tools mounted. */
  tools: boolean;
  /** Contents of `instructionsFile`. */
  instructions?: string;
  /** Session launch bounds (decision 7); roots are absolute. */
  sessionParams?: SessionParams;
  /** From the config file's `agents` (false: the synthesized `default` agent of a config without agents). */
  configured: boolean;
}

/** Where a host may launch an agent's sessions (`agents.<name>.sessionParams`). */
export interface SessionParams {
  cwdRoots: string[];
  envKeys: string[];
  envPathRoots: Record<string, string[]>;
}

/** Variables naming a harness config dir: in `envKeys` only with roots in `envPathRoots`. */
export const CONFIG_DIR_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];

export interface Config {
  /** Not fatal, logged at start (e.g. a lark-bot account with ':'). */
  warnings?: string[];
  dataDir: string;
  logPath: string;
  socketPath: string;
  /** Blob store directory (0700) and per-blob limit. */
  blobs: { dir: string; maxBytes: number };
  cwd: string;
  /** Named harness instances. */
  harnesses: Record<string, HarnessInstance>;
  /** The instance the default policy plans. */
  defaultHarness: string;
  /** Named agents (without `agents` in the file: one, `default`, on the default instance). */
  agents: Record<string, AgentConfig>;
  /** Agent of the default table and of rules naming none; undefined when there is no interactive agent. */
  defaultAgent: string | undefined;
  /** The local binding table from `bindings`; undefined: the owners default table (`ownersTable`). */
  table?: BindingTable;
  /** `identities` from the config (next to the owners' entries; they win for the same channel identity). */
  identities: IdentityEntry[];
  channels: ResolvedChannel[];
  policy: {
    owners: string[];
    selfAccounts: string[];
    agentAccounts: string[];
    ownerSessionKey?: string;
    routes: string[];
    watchAllowlist: Partial<Pick<WatchSource, 'channel' | 'account' | 'conversation' | 'conversationKind'>>[];
  };
  /** Owner watches from the config file. */
  watches: (WatchDraft & { id: string })[];
  /** Host MCP output tools mounted into every harness instance. */
  outputTools: boolean;
  /** How long a parked topic's lane stays open while idle (0: until the daemon stops). */
  topics: { parkedIdleMs: number };
  local: { principal: Principal; session: string };
  /** The console API server. */
  console: ConsoleConfig;
  /** The host connection: `tokenFile` is an absolute path when set. */
  host?: { tokenFile?: string };
  /** Where this config came from (loadConfig): the file (it may not exist) and the env file found for it. */
  source?: { path: string; envFile?: string };
}

export interface ConsoleConfig {
  enabled: boolean;
  host: string;
  port: number;
  allowRemote: boolean;
  /** Lowercased host names (no port, no brackets) the `Host` header may carry besides loopback and `host`. */
  allowedHosts: string[];
  /** Normalized origins (`scheme://host[:port]`). */
  origins: string[];
  uiUrl?: string;
  sessionTtlMs: number;
  larkBotCommand: string[];
  /** `/ws` ping interval (0: off) and how long a ping waits for an answer. */
  heartbeat: { intervalMs: number; timeoutMs: number };
}

/** create-lark-bot, pinned. */
export const CREATE_LARK_BOT = ['npx', '-y', 'github:Ghost-LZW/create-lark-bot#v0.2.4'];
export const DEFAULT_CONSOLE_PORT = 7464;
export const DEFAULT_WS_HEARTBEAT_MS = 30_000;
export const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 10_000;

/** 127.0.0.0/8, ::1, localhost. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** 0.0.0.0, ::, [::]: every interface. */
export function isWildcardHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === '0.0.0.0' || h === '::' || h === '';
}

function resolveConsole(c: ConfigFile['console']): ConsoleConfig {
  const host = c?.host ?? '127.0.0.1';
  if (!isLoopbackHost(host) && c?.allowRemote !== true)
    fail(`console.host ${JSON.stringify(host)} is not a loopback address; the console only listens on loopback unless console.allowRemote is true`);
  const allowedHosts = (c?.allowedHosts ?? []).map((h, i) => {
    const n = h.replace(/^\[|\]$/g, '').toLowerCase();
    if (!/^[a-z0-9.:-]+$/.test(n) || isWildcardHost(n)) fail(`console.allowedHosts[${i}]: ${JSON.stringify(h)} is not a host name or address (no port, no wildcard)`);
    return n;
  });
  if (isWildcardHost(host) && c?.allowRemote === true && allowedHosts.length === 0)
    fail(`console.host ${JSON.stringify(host)} listens on every interface: list the names remote browsers use in console.allowedHosts (the Host header is checked against them)`);
  const origins = (c?.origins ?? []).map((o, i) => {
    try {
      const u = new URL(o);
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== o.replace(/\/$/, '')) throw new Error('not an origin');
      return u.origin;
    } catch {
      return fail(`console.origins[${i}]: ${JSON.stringify(o)} is not an origin (scheme://host[:port], no path)`);
    }
  });
  if (c?.uiUrl !== undefined && !/^https?:\/\//.test(c.uiUrl)) fail('console.uiUrl must be an http(s) URL');
  return {
    enabled: c?.enabled ?? true,
    host,
    port: c?.port ?? DEFAULT_CONSOLE_PORT,
    allowRemote: c?.allowRemote === true,
    allowedHosts,
    origins,
    ...(c?.uiUrl !== undefined ? { uiUrl: c.uiUrl.replace(/\/$/, '') } : {}),
    sessionTtlMs: c?.sessionTtlMs ?? 12 * 3_600_000,
    larkBotCommand: c?.larkBotCommand ?? CREATE_LARK_BOT,
    heartbeat: { intervalMs: c?.heartbeat?.intervalMs ?? DEFAULT_WS_HEARTBEAT_MS, timeoutMs: c?.heartbeat?.timeoutMs ?? DEFAULT_WS_HEARTBEAT_TIMEOUT_MS },
  };
}

/** A lark-bot entry's config after env substitution, with its app resolved. */
export type LarkChannelConfig = Record<string, unknown> & { appId: string; appSecret: string; domain: 'feishu' | 'lark' };

export type ResolvedChannel =
  | (Omit<Extract<ChannelEntry, { type: 'lark-bot' }>, 'config'> & { account: string; config: LarkChannelConfig })
  | (Extract<ChannelEntry, { type: 'mail' }> & { account: string })
  | (Extract<ChannelEntry, { type: 'bridge' }> & { account: string });

/** `topics.parkedIdleMs` default: a parked topic's lane closes after 30 idle minutes. */
export const DEFAULT_PARKED_IDLE_MS = 30 * 60_000;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const DEFAULT_MODEL: Record<HarnessKind, string> = { 'claude-code': 'haiku', codex: '' };
const MODEL_ENV: Record<HarnessKind, string> = { 'claude-code': 'AGENTS_IO_LIVE_CLAUDE_MODEL', codex: 'AGENTS_IO_LIVE_CODEX_MODEL' };
/** `.env.live` keys handed to the harness CLI; everything else (Lark, mail secrets) stays in this process. */
const HARNESS_ENV = /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|HTTPS?_PROXY$|NO_PROXY$)/;

/**
 * Where `.env.live` is: an explicit path, next to the config file, or the nearest one up from `cwd`.
 * A discovered file must be ours, not writable by others, in a directory others cannot write:
 * anything else (e.g. a `/tmp/.env.live` another user created) is skipped, since its keys can
 * add owners. Our own file with loose permissions is an error rather than silently ignored.
 * An explicit `envFile` is taken as given.
 */
export function findEnvFile(o: { envFile?: string; configDir?: string; cwd?: string; uid?: number }): string | undefined {
  if (o.envFile) return o.envFile;
  const uid = o.uid ?? process.getuid?.();
  const usable = (dir: string): boolean => {
    const p = join(dir, '.env.live');
    if (!existsSync(p)) return false;
    if (uid === undefined) return true;
    const st = statSync(p);
    if (st.uid !== uid || statSync(dir).mode & 0o002) return false;
    if (st.mode & 0o022) fail(`${p} is writable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
    return true;
  };
  if (o.configDir && usable(o.configDir)) return join(o.configDir, '.env.live');
  for (let d = resolve(o.cwd ?? process.cwd()); ; d = dirname(d)) {
    if (usable(d)) return join(d, '.env.live');
    if (dirname(d) === d) return undefined;
  }
}

export interface LoadOptions {
  /** Config file; default `$AIO_CONFIG` or `./aio.config.json`. A missing default file means "all defaults". */
  path?: string;
  envFile?: string;
  /** Process environment (default process.env). Wins over `.env.live`. */
  env?: NodeJS.ProcessEnv;
  /** Override the default instance: an instance name, or a kind (its first instance, else a default one). */
  harness?: string;
  cwd?: string;
  /** Resolve `channels` (default true). Clients and e2e leave them out, so they need no channel secrets. */
  channels?: boolean;
}

export function loadConfig(o: LoadOptions = {}): Config {
  const procEnv = o.env ?? process.env;
  const cwd = o.cwd ?? process.cwd();
  const explicit = o.path ?? procEnv.AIO_CONFIG;
  const path = resolve(cwd, explicit ?? 'aio.config.json');
  let raw: unknown = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new ConfigError(`${path}: ${(e as Error).message}`);
    }
  } else if (explicit) throw new ConfigError(`config file not found: ${path}`);
  const envPath = findEnvFile({ envFile: o.envFile, configDir: dirname(path), cwd });
  const fileEnv = envPath ? loadEnvFile(envPath) : {};
  const env: Record<string, string | undefined> = { ...fileEnv, ...procEnv };
  const c = resolveConfig(raw, { env, fileEnv, baseDir: dirname(path), harness: o.harness, cwd, channels: o.channels });
  return { ...c, source: { path, ...(envPath ? { envFile: resolve(cwd, envPath) } : {}) } };
}

export interface ResolveContext {
  env: Record<string, string | undefined>;
  /** Only these (filtered) reach the harness CLI. */
  fileEnv?: Record<string, string>;
  baseDir: string;
  harness?: string;
  cwd?: string;
  channels?: boolean;
}

/** Validate a parsed config file and fill defaults. Error messages name keys, never values. */
export function resolveConfig(raw: unknown, ctx: ResolveContext): Config {
  const errs = errors(ConfigFile, raw);
  if (errs.length) throw new ConfigError(`invalid config: ${errs.slice(0, 5).join('; ')}`);
  const c = raw as ConfigFile;
  const env = ctx.env;
  const path = (p: string) => {
    const home = p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
    return isAbsolute(home) || home === ':memory:' ? home : resolve(ctx.baseDir, home);
  };

  const warnings: string[] = [];
  const dataDir = path(c.dataDir ?? join(homedir(), '.agents-io', 'aio'));
  const { harnesses, defaultHarness } = resolveHarnesses(c, ctx, path);

  const owners = [...(c.policy?.owners ?? []), ...(env.AGENTS_IO_OWNERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  const ownerSessionKey = c.policy?.ownerSessionKey;
  const outputTools = c.outputTools ?? true;
  const { agents, defaultAgent } = resolveAgents(c, harnesses, defaultHarness, outputTools, path);
  const identities = c.identities ?? [];
  const localSession = c.local?.session ?? ownerSessionKey ?? 'local:main';
  const table: BindingTable | undefined = c.bindings ? { version: 'config', bindings: c.bindings, identities: [] } : undefined;
  checkTable({ agents, defaultAgent, owners, identities, table, ownerSessionKey, localSession });

  return {
    dataDir,
    logPath: path(c.logPath ?? join(dataDir, 'log.sqlite')),
    socketPath: path(c.socketPath ?? join(dataDir, 'run', 'aio.sock')),
    blobs: { dir: path(c.blobs?.dir ?? join(dataDir, 'blobs')), maxBytes: c.blobs?.maxBytes ?? DEFAULT_BLOB_MAX_BYTES },
    cwd: path(c.cwd ?? ctx.cwd ?? process.cwd()),
    harnesses,
    defaultHarness,
    agents,
    defaultAgent,
    ...(table ? { table } : {}),
    identities,
    channels: ctx.channels === false ? [] : resolveChannels(c.channels ?? [], env, path, warnings),
    outputTools,
    topics: { parkedIdleMs: c.topics?.parkedIdleMs ?? DEFAULT_PARKED_IDLE_MS },
    policy: {
      owners,
      selfAccounts: c.policy?.selfAccounts ?? [],
      agentAccounts: c.policy?.agentAccounts ?? [],
      ...(ownerSessionKey ? { ownerSessionKey } : {}),
      routes: c.policy?.routes ?? [],
      watchAllowlist: c.policy?.watchAllowlist ?? [],
    },
    watches: c.watches ?? [],
    local: {
      principal: { id: c.local?.principal ?? owners[0] ?? 'local:owner', labels: c.local?.labels ?? ['owner'] },
      session: localSession,
    },
    console: resolveConsole(c.console),
    host: c.host?.tokenFile !== undefined ? { tokenFile: path(c.host.tokenFile) } : {},
    ...(warnings.length ? { warnings } : {}),
  };
}

/** The synthesized agent of a config without `agents`: the default instance, bare route-key sessions. */
export const DEFAULT_AGENT = 'default';

function resolveAgents(
  c: ConfigFile,
  harnesses: Record<string, HarnessInstance>,
  defaultHarness: string,
  outputTools: boolean,
  path: (p: string) => string,
): { agents: Record<string, AgentConfig>; defaultAgent: string | undefined } {
  if (!c.agents) {
    if (c.defaultAgent !== undefined && c.defaultAgent !== DEFAULT_AGENT) fail('`defaultAgent` needs `agents`');
    return { agents: { [DEFAULT_AGENT]: { name: DEFAULT_AGENT, harness: defaultHarness, mode: 'interactive', tools: outputTools, configured: false } }, defaultAgent: DEFAULT_AGENT };
  }
  const agents: Record<string, AgentConfig> = {};
  for (const [name, a] of Object.entries(c.agents)) {
    const where = `agents.${name}`;
    if (!INSTANCE_NAME.test(name)) fail(`${where}: agent names are letters, digits, '.', '_' and '-' (at most 64)`);
    if (!harnesses[a.harness]) fail(`${where}.harness: unknown harness instance ${JSON.stringify(a.harness)} (configured: ${Object.keys(harnesses).join(', ')})`);
    let instructions: string | undefined;
    if (a.instructionsFile !== undefined) {
      const file = path(a.instructionsFile);
      try {
        instructions = readFileSync(file, 'utf8');
      } catch (e) {
        fail(`${where}.instructionsFile: cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      }
    }
    const sessionParams = a.sessionParams && resolveSessionParams(a.sessionParams, `${where}.sessionParams`, a.mode ?? 'interactive', path);
    agents[name] = {
      name,
      harness: a.harness,
      ...(a.model !== undefined ? { model: a.model } : {}),
      ...(a.effort !== undefined ? { effort: a.effort } : {}),
      ...(a.profile !== undefined ? { profile: a.profile } : {}),
      ...(a.cwd !== undefined ? { cwd: path(a.cwd) } : {}),
      mode: a.mode ?? 'interactive',
      tools: a.tools ?? outputTools,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(sessionParams ? { sessionParams } : {}),
      configured: true,
    };
  }
  if (c.defaultAgent !== undefined) {
    const d = agents[c.defaultAgent];
    if (!d) fail(`defaultAgent ${JSON.stringify(c.defaultAgent)} is not one of the agents (${Object.keys(agents).join(', ')})`);
    if (d.mode === 'task') fail(`defaultAgent ${JSON.stringify(c.defaultAgent)} is a task agent; task agents only run through run.start`);
  }
  return { agents, defaultAgent: c.defaultAgent ?? Object.values(agents).find((a) => a.mode === 'interactive')?.name };
}

function resolveSessionParams(p: NonNullable<AgentEntry['sessionParams']>, where: string, mode: 'interactive' | 'task', path: (p: string) => string): SessionParams {
  if (mode === 'task') fail(`${where}: task agents take their cwd and env per run (run.start), not sessionParams`);
  for (const k of p.envKeys) {
    if (!VAR_NAME.test(k)) fail(`${where}.envKeys: ${JSON.stringify(k)} is not a variable name`);
    if (k.startsWith('AGENTS_IO_')) fail(`${where}.envKeys: ${k}: AGENTS_IO_* variables are the daemon's own`);
  }
  const envPathRoots: Record<string, string[]> = {};
  for (const [k, roots] of Object.entries(p.envPathRoots ?? {})) {
    if (!p.envKeys.includes(k)) fail(`${where}.envPathRoots.${k}: not in envKeys`);
    if (!roots.length) fail(`${where}.envPathRoots.${k}: needs at least one root`);
    envPathRoots[k] = roots.map(path);
  }
  for (const k of CONFIG_DIR_KEYS) {
    if (p.envKeys.includes(k) && !envPathRoots[k]) fail(`${where}: ${k} is in envKeys, so envPathRoots.${k} must say under which roots its value may point`);
  }
  return { cwdRoots: p.cwdRoots.map(path), envKeys: [...p.envKeys], envPathRoots };
}

type AgentEntry = Static<typeof AgentEntry>;

/** Router view of an agent: the default agent keeps bare route-key sessions and the local session as `main`. */
export function agentSpec(a: AgentConfig, c: Pick<Config, 'defaultAgent' | 'local'>): AgentSpec {
  return a.name === c.defaultAgent ? { name: a.name, mode: a.mode, mainSession: c.local.session, sessionPrefix: '' } : { name: a.name, mode: a.mode };
}

/**
 * The local table routing uses: `bindings` when given, else the owners default
 * table for the default agent; identities are the owners' entries plus the
 * config's (which win for the same channel identity).
 */
export function configTable(c: Pick<Config, 'defaultAgent' | 'identities' | 'table' | 'policy'>): BindingTable | undefined {
  const extra = new Set(c.identities.map((e) => `${e.channel}:${e.channelUserId}`));
  const identities = [...ownerIdentities(c.policy.owners).filter((e) => !extra.has(`${e.channel}:${e.channelUserId}`)), ...c.identities];
  if (c.table) return { ...c.table, identities };
  if (c.defaultAgent === undefined) return identities.length ? { version: 'config', bindings: [], identities } : undefined;
  return { ...ownersTable({ owners: [], agent: c.defaultAgent, ...(c.policy.ownerSessionKey ? { ownerSessionKey: c.policy.ownerSessionKey } : {}) }), identities };
}

/** Check the table at load: rule targets exist and are interactive (task agents can not be targets), digests have periods, no identity conflicts. */
function checkTable(o: {
  agents: Record<string, AgentConfig>;
  defaultAgent: string | undefined;
  owners: string[];
  identities: IdentityEntry[];
  table: BindingTable | undefined;
  ownerSessionKey: string | undefined;
  localSession: string;
}): void {
  let table: BindingTable | undefined;
  try {
    checkIdentities(o.identities);
    table = configTable({
      defaultAgent: o.defaultAgent,
      identities: o.identities,
      ...(o.table ? { table: o.table } : {}),
      policy: { owners: o.owners, ...(o.ownerSessionKey ? { ownerSessionKey: o.ownerSessionKey } : {}) } as Config['policy'],
    });
  } catch (e) {
    fail(`identities: ${(e as Error).message}`);
  }
  if (!table) return;
  const at = { defaultAgent: o.defaultAgent, local: { principal: { id: '', labels: [] }, session: o.localSession } };
  try {
    new Router({ agents: Object.values(o.agents).map((a) => agentSpec(a, at)), ...(o.defaultAgent ? { defaultAgent: o.defaultAgent } : {}), config: table }).close();
  } catch (e) {
    if (e instanceof RouterError) fail(`bindings: ${e.message}`);
    throw e;
  }
}

/** The instance the default policy plans. */
export function defaultInstance(c: Config): HarnessInstance {
  return c.harnesses[c.defaultHarness]!;
}

/** `c` with its default instance replaced. */
export function withDefaultInstance(c: Config, i: HarnessInstance): Config {
  return { ...c, harnesses: { ...c.harnesses, [c.defaultHarness]: i } };
}

/** Where a codex instance keeps its socket, server record and turn snapshots unless it sets `transport.stateDir`. */
export function codexStateDir(name: string): string {
  return join(homedir(), '.agents-io', `codex.${name}`);
}

const pathish = (p: string) => p.startsWith('~') || p.startsWith('.') || p.includes('/');

function resolveHarnesses(c: ConfigFile, ctx: ResolveContext, path: (p: string) => string): { harnesses: Record<string, HarnessInstance>; defaultHarness: string } {
  const env = ctx.env;
  if (c.harness && c.harnesses) fail('use either `harnesses` (named instances) or the older `harness` block, not both');
  const out: Record<string, HarnessInstance> = {};
  let def: string;
  if (c.harnesses) {
    const names = Object.keys(c.harnesses);
    if (!names.length) fail('`harnesses` is empty');
    for (const name of names) out[name] = resolveInstance(name, c.harnesses[name], env, path);
    def = c.defaultHarness ?? names[0]!;
    if (!out[def]) fail(`defaultHarness ${JSON.stringify(def)} is not one of the harnesses (${names.join(', ')})`);
  } else {
    if (c.defaultHarness) fail('`defaultHarness` needs `harnesses`');
    // Older form: one instance per present section, named after its kind, with the
    // harness-ish `.env.live` keys passed through as before.
    const legacyEnv = Object.fromEntries(Object.entries(ctx.fileEnv ?? {}).filter(([k]) => HARNESS_ENV.test(k)));
    def = c.harness?.use ?? 'claude-code';
    const cc = c.harness?.['claude-code'];
    if (cc || def === 'claude-code') {
      out['claude-code'] = {
        ...base('claude-code', 'claude-code', cc ?? {}),
        env: legacyEnv,
        kind: 'claude-code',
        claude: cc?.claudePath ? { claudePath: path(cc.claudePath) } : {},
      };
    }
    const cx = c.harness?.codex;
    if (cx || def === 'codex') {
      out.codex = {
        ...base('codex', 'codex', cx ?? {}),
        env: legacyEnv,
        kind: 'codex',
        // stateDir stays the adapter default (~/.agents-io/codex), so a running deployment keeps adopting its turns.
        codex: { ...(cx?.bin ? { bin: cx.bin } : {}), transport: transportOf(cx?.transport, undefined, path) },
      };
    }
  }

  // --harness: an instance name, or a kind (its first instance, else one with defaults).
  const pick = ctx.harness;
  if (pick !== undefined && !out[pick]) {
    const kind = pick === 'claude-code' || pick === 'codex' ? pick : undefined;
    if (!kind) fail(`unknown harness instance ${JSON.stringify(pick)} (configured: ${Object.keys(out).join(', ')})`);
    const first = Object.values(out).find((i) => i.kind === kind);
    if (first) def = first.name;
    else {
      out[kind] =
        kind === 'codex'
          ? { ...base(kind, kind, {}), env: {}, kind, codex: { transport: { kind: 'stdio' } } }
          : { ...base(kind, kind, {}), env: {}, kind, claude: {} };
      def = kind;
    }
  } else if (pick !== undefined) def = pick;

  // Env model override applies to the default instance only (other instances may target other providers).
  const d = out[def]!;
  const envModel = env[MODEL_ENV[d.kind]];
  if (envModel) d.run = { ...d.run, model: envModel };

  // Two codex instances must never share a server record or turn snapshots: restart adoption would cross them.
  const dirs = new Map<string, string>();
  for (const i of Object.values(out)) {
    if (i.kind !== 'codex' || i.codex.transport.kind !== 'unix') continue;
    const dir = i.codex.transport.stateDir ?? '(default ~/.agents-io/codex)';
    const other = dirs.get(dir);
    if (other) fail(`harnesses ${other} and ${i.name} use the same codex stateDir ${dir}; give each its own`);
    dirs.set(dir, i.name);
  }
  return { harnesses: out, defaultHarness: def };
}

function base(name: string, kind: HarnessKind, sec: { run?: { model?: string; effort?: string }; profiles?: Record<string, Record<string, unknown>>; options?: Record<string, unknown> }) {
  return {
    name,
    run: { harness: name, model: sec.run?.model ?? DEFAULT_MODEL[kind], ...(sec.run?.effort ? { effort: sec.run.effort } : {}) },
    profiles: sec.profiles ?? {},
    options: sec.options ?? {},
  };
}

function transportOf(t: Static<typeof CodexTransport> | undefined, defaultStateDir: string | undefined, path: (p: string) => string): CodexTransportOption {
  if (!t || t.kind === 'stdio') return { kind: 'stdio' };
  const stateDir = t.stateDir ? path(t.stateDir) : defaultStateDir;
  return { ...t, ...(t.path ? { path: path(t.path) } : {}), ...(stateDir ? { stateDir } : {}) };
}

function resolveInstance(name: string, raw: unknown, env: Record<string, string | undefined>, path: (p: string) => string): HarnessInstance {
  const where = `harnesses.${name}`;
  if (!INSTANCE_NAME.test(name)) fail(`${where}: instance names are letters, digits, '.', '_' and '-' (at most 64)`);
  const use = (raw as { use: HarnessKind }).use;
  const errs = errors(use === 'codex' ? CodexInstance : ClaudeInstance, raw);
  if (errs.length) fail(`invalid config: ${errs.slice(0, 5).map((e) => `${where}${e}`).join('; ')}`);
  // A missing "env:NAME" makes only this instance unusable (reported when it is built), not the whole config.
  let unavailable: string | undefined;
  const sub = <T>(v: T, key: string): T => {
    try {
      return substituteEnv(v, env, `${where}.${key}`) as T;
    } catch (e) {
      unavailable ??= (e as Error).message;
      return v;
    }
  };
  const envOut: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries((raw as { env?: Record<string, string | null> }).env ?? {})) {
    if (!VAR_NAME.test(k)) fail(`${where}.env: ${JSON.stringify(k)} is not a variable name`);
    envOut[k] = v === null ? undefined : sub(v, `env.${k}`);
  }
  // "env:NAME" in settings that end up on the child's command line (codex `-c`, claude
  // `--mcp-config` / `--settings`, readable by other local users via ps) never becomes the
  // value there: the value goes into the child's environment and the setting names the variable.
  const secrets: ChildSecrets = {
    value: (name, at) => {
      if (!VAR_NAME.test(name)) fail(`${at}: ${JSON.stringify(name)} is not a variable name`);
      const v = env[name];
      if (v === undefined) unavailable ??= `${at}: environment variable ${name} is not set`;
      return v;
    },
    toChild: (k, v, at) => {
      if (k in envOut && envOut[k] !== v) fail(`${where}: env.${k} and ${at} set ${k} differently; use one`);
      envOut[k] = v;
    },
  };
  const common = {
    ...base(name, use, raw as Static<typeof CodexInstance>),
    env: envOut,
    ...((raw as { cwd?: string }).cwd ? { cwd: path((raw as { cwd: string }).cwd) } : {}),
  };
  if (use === 'codex') {
    const x = raw as Static<typeof CodexInstance>;
    if (x.profile !== undefined)
      fail(`${where}.profile: \`codex app-server\` does not accept --profile (codex-cli 0.160 rejects it, and \`-c profile=…\` is legacy); use \`config\` keys or a separate \`home\``);
    if ('CODEX_HOME' in envOut && x.home) fail(`${where}: set \`home\` or env.CODEX_HOME, not both`);
    const transport = transportOf(x.transport, codexStateDir(name), path);
    if ((x.config && Object.keys(x.config).length) || x.enable?.length || x.disable?.length) {
      if (transport.kind === 'unix' && transport.spawn !== 'own')
        fail(`${where}: config/enable/disable only apply to a server the gateway starts (stdio or unix spawn "own"), not spawn "${transport.spawn}"`);
    }
    const codex: CodexLaunch = {
      ...(x.executable ? { bin: pathish(x.executable) ? path(x.executable) : x.executable } : {}),
      ...(x.home ? { codexHome: path(x.home) } : {}),
      ...(x.config ? { config: codexConfigViaEnv(x.config, `${where}.config`, secrets) } : {}),
      ...(x.enable ? { enable: x.enable } : {}),
      ...(x.disable ? { disable: x.disable } : {}),
      transport,
    };
    return { ...common, kind: 'codex', codex, ...(unavailable ? { unavailable } : {}) };
  }
  const x = raw as Static<typeof ClaudeInstance>;
  if ('CLAUDE_CONFIG_DIR' in envOut && x.configDir) fail(`${where}: set \`configDir\` or env.CLAUDE_CONFIG_DIR, not both`);
  const claude: ClaudeLaunch = {
    ...(x.executable ? { claudePath: pathish(x.executable) ? path(x.executable) : x.executable } : {}),
    ...(x.configDir ? { configDir: path(x.configDir) } : {}),
    ...(x.settings !== undefined ? { settings: typeof x.settings === 'string' ? path(x.settings) : claudeSettingsViaEnv(x.settings, `${where}.settings`, secrets) } : {}),
    ...(x.settingSources ? { settingSources: x.settingSources } : {}),
    ...(x.mcpServers ? { mcpServers: claudeMcpViaEnv(x.mcpServers, `${where}.mcpServers`, secrets) } : {}),
    ...(x.plugins ? { plugins: x.plugins.map(path) } : {}),
    ...(x.skills !== undefined ? { skills: x.skills } : {}),
    ...(x.extraArgs ? { extraArgs: x.extraArgs } : {}),
    ...(x.additionalDirectories ? { additionalDirectories: x.additionalDirectories.map(path) } : {}),
  };
  return { ...common, kind: 'claude-code', claude, ...(unavailable ? { unavailable } : {}) };
}

export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envRef = (v: unknown): string | undefined => (typeof v === 'string' && v.startsWith('env:') ? v.slice(4) : undefined);

/** How a harness instance hands "env:NAME" values to its child process. */
interface ChildSecrets {
  /** The variable's value; undefined (instance unavailable) when it is not set. */
  value(name: string, at: string): string | undefined;
  /** Put `k=v` into the child's environment. */
  toChild(k: string, v: string, at: string): void;
}

/** Claude `mcpServers`: "env:NAME" becomes `${NAME}` (the CLI expands it in command, args, env, url, headers). */
function claudeMcpViaEnv<T>(v: T, at: string, s: ChildSecrets): T {
  const name = envRef(v);
  if (name !== undefined) {
    const value = s.value(name, at);
    if (value !== undefined) s.toChild(name, value, at);
    return `\${${name}}` as T;
  }
  if (Array.isArray(v)) return v.map((x, i) => claudeMcpViaEnv(x, `${at}[${i}]`, s)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, claudeMcpViaEnv(x, `${at}.${k}`, s)])) as T;
  return v;
}

/** Claude inline `settings` (passed as `--settings <json>`): "env:NAME" only under `settings.env`, moved to the child env. */
function claudeSettingsViaEnv(st: Record<string, unknown>, at: string, s: ChildSecrets): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(st)) {
    if (k === 'env' && v && typeof v === 'object' && !Array.isArray(v)) {
      const kept: Record<string, unknown> = {};
      for (const [vk, vv] of Object.entries(v)) {
        const name = envRef(vv);
        if (name === undefined) kept[vk] = vv;
        else if (!VAR_NAME.test(vk)) fail(`${at}.env: ${JSON.stringify(vk)} is not a variable name`);
        else {
          const value = s.value(name, `${at}.env.${vk}`);
          if (value !== undefined) s.toChild(vk, value, `${at}.env.${vk}`);
        }
      }
      out[k] = kept;
    } else out[k] = noEnvRefs(v, `${at}.${k}`, 'the claude command line (--settings)', 'set it under settings.env or the instance env');
  }
  return out;
}

function noEnvRefs(v: unknown, at: string, line: string, hint: string): unknown {
  if (envRef(v) !== undefined) fail(`${at}: "env:" values would be on ${line}, visible to other local users via ps; ${hint}`);
  if (Array.isArray(v)) v.forEach((x, i) => noEnvRefs(x, `${at}[${i}]`, line, hint));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) noEnvRefs(x, `${at}.${k}`, line, hint);
  return v;
}

const TOML_SEG = /[A-Za-z0-9_][A-Za-z0-9_-]*|"[^"\\]*"/g;
const tomlKey = (segs: string[]) => segs.map((x) => (/^[A-Za-z0-9_-]+$/.test(x) ? x : JSON.stringify(x))).join('.');

/**
 * Codex `config` (passed as `-c key=value`): each "env:NAME" is replaced by the Codex setting
 * that names a variable instead of holding the value, with the value in the app-server's env:
 * `…http_headers.H` → `…env_http_headers.H`, `…bearer_token` → `…bearer_token_env_var`,
 * `…experimental_bearer_token` → `…env_key`, `mcp_servers.<id>.env.VAR` → `mcp_servers.<id>.env_vars`.
 * Anywhere else it is an error.
 */
function codexConfigViaEnv(config: Record<string, unknown>, at: string, s: ChildSecrets): Record<string, unknown> {
  const DROP = Symbol('drop');
  const extra: [string, unknown][] = [];
  const forward = new Map<string, string[]>();
  const visit = (v: unknown, segs: string[]): unknown => {
    const name = envRef(v);
    if (name !== undefined) {
      const where = `${at}.${segs.join('.')}`;
      const [last, parent] = [segs.at(-1)!, segs.at(-2)];
      const value = s.value(name, where);
      if (parent === 'env' && segs.length >= 3 && VAR_NAME.test(last)) {
        // A stdio MCP server's env: forward the variable from the app-server's environment.
        const server = tomlKey(segs.slice(0, -2));
        forward.set(server, [...(forward.get(server) ?? []), last]);
        if (value !== undefined) s.toChild(last, value, where);
        return DROP;
      }
      let key: string[] | undefined;
      if (parent === 'http_headers') key = [...segs.slice(0, -2), 'env_http_headers', last];
      else if (last === 'bearer_token') key = [...segs.slice(0, -1), 'bearer_token_env_var'];
      else if (last === 'experimental_bearer_token') key = [...segs.slice(0, -1), 'env_key'];
      if (!key)
        fail(
          `${where}: "env:" values would be on the codex app-server command line, visible to other local users via ps; ` +
            'use a setting that names a variable (http_headers → env_http_headers, bearer_token → bearer_token_env_var, ' +
            'experimental_bearer_token → env_key, mcp_servers.<id>.env.<VAR>) or write a non-secret value literally',
        );
      if (value !== undefined) s.toChild(name, value, where);
      extra.push([tomlKey(key), name]);
      return DROP;
    }
    if (Array.isArray(v)) return v.map((x, i) => visit(x, [...segs, `[${i}]`]));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const r = visit(x, [...segs, k]);
        if (r !== DROP) out[k] = r;
      }
      return out;
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    const segs = (k.match(TOML_SEG) ?? [k]).map((x) => x.replace(/^"|"$/g, ''));
    const r = visit(v, segs);
    if (r !== DROP) out[k] = r;
  }
  for (const [k, v] of extra) out[k] = v;
  for (const [server, vars] of forward) out[`${server}.env_vars`] = vars;
  return out;
}

/**
 * Every channel entry, plus the rules across lark-bot entries (decision 8): one
 * app per entry (two entries of one app would split its events), at most one entry
 * reading LARK_APP_*, accounts unique and, with several bots, plain names (they
 * go into route and session keys, separated by ':').
 */
function resolveChannels(entries: ChannelEntry[], env: Record<string, string | undefined>, path: (p: string) => string, warnings: string[]): ResolvedChannel[] {
  const out = entries.map((ch, i) => resolveChannel(ch, env, path, i));
  const lark = out.map((ch, i) => ({ ch, i })).filter((x): x is { ch: Extract<ResolvedChannel, { type: 'lark-bot' }>; i: number } => x.ch.type === 'lark-bot');
  const name = (x: { ch: { account: string }; i: number }) => `channels[${x.i}] (account ${JSON.stringify(x.ch.account)})`;
  const fallback = lark.filter((x) => !hasExplicitApp(entries[x.i]!));
  if (fallback.length > 1) fail(`lark-bot channels ${fallback.map(name).join(' and ')} both read LARK_APP_ID; give each its own config.appId / config.appSecret`);
  const seen = new Map<string, (typeof lark)[number]>();
  const apps = new Map<string, (typeof lark)[number]>();
  for (const x of lark) {
    const prior = seen.get(x.ch.account);
    if (prior) fail(`lark-bot channels ${name(prior)} and channels[${x.i}] have the same account; accounts must differ`);
    seen.set(x.ch.account, x);
    const app = `${x.ch.config.domain}:${x.ch.config.appId}`;
    const same = apps.get(app);
    // One long connection per app: a second one would get some of its events (Feishu delivers each to one connection).
    if (same) fail(`lark-bot channels ${name(same)} and ${name(x)} are the same app ${x.ch.config.appId}; run each app in one entry only (two connections split its events)`);
    apps.set(app, x);
  }
  if (lark.length > 1) {
    for (const x of lark) if (!INSTANCE_NAME.test(x.ch.account)) fail(`${name(x)}: with several lark-bot channels, accounts are letters, digits, '.', '_' and '-' (at most 64, not starting with '.', '_' or '-')`);
  } else if (lark[0]?.ch.account.includes(':')) warnings.push(`${name(lark[0])}: an account with ':' makes route and session keys ambiguous; use letters, digits, '.', '_' and '-'`);
  return out;
}

/** The entry names its app itself (`config.appId` or `config.appSecret`), instead of reading LARK_APP_*. */
function hasExplicitApp(ch: ChannelEntry): boolean {
  const c = ch.type === 'lark-bot' ? ch.config : undefined;
  return c?.appId !== undefined || c?.appSecret !== undefined;
}

function resolveChannel(ch: ChannelEntry, env: Record<string, string | undefined>, path: (p: string) => string, i: number): ResolvedChannel {
  const account = ch.account ?? 'default';
  switch (ch.type) {
    case 'lark-bot': {
      const where = `channels[${i}].config`;
      const config = substituteEnv(ch.config ?? {}, env, where) as Record<string, unknown>;
      let appId: unknown;
      let appSecret: unknown;
      let domain: unknown;
      if (hasExplicitApp(ch)) {
        if (config.appId === undefined || config.appSecret === undefined) fail(`${where}: give both appId and appSecret (or neither, to read LARK_APP_ID / LARK_APP_SECRET)`);
        ({ appId, appSecret } = config);
        domain = config.domain ?? 'feishu';
      } else {
        const need = (k: string) => env[k] || fail(`channel lark-bot needs ${k} (environment or .env.live), or config.appId / config.appSecret`);
        appId = need('LARK_APP_ID');
        appSecret = need('LARK_APP_SECRET');
        domain = config.domain ?? (env.LARK_DOMAIN || 'feishu');
      }
      if (typeof appId !== 'string' || !appId) fail(`${where}.appId must be a non-empty string`);
      if (typeof appSecret !== 'string' || !appSecret) fail(`${where}.appSecret must be a non-empty string`);
      if (domain !== 'feishu' && domain !== 'lark') fail(`${where}.domain (or LARK_DOMAIN) must be 'feishu' or 'lark'`);
      return { ...ch, account, config: { ...config, appId, appSecret, domain } };
    }
    case 'mail':
      return { ...ch, account, config: substituteEnv(ch.config, env, 'mail.config') as Record<string, unknown> };
    case 'bridge':
      return {
        ...ch,
        account,
        ...(ch.cwd ? { cwd: path(ch.cwd) } : {}),
        ...(ch.env ? { env: substituteEnv(ch.env, env, 'bridge.env') as Record<string, string> } : {}),
        ...(ch.config !== undefined ? { config: substituteEnv(ch.config, env, 'bridge.config') } : {}),
      };
  }
}

/** Replace every string `"env:NAME"` with the variable's value; a missing variable is an error naming it. */
export function substituteEnv(v: unknown, env: Record<string, string | undefined>, where: string): unknown {
  if (typeof v === 'string' && v.startsWith('env:')) {
    const name = v.slice(4);
    return env[name] ?? fail(`${where}: environment variable ${name} is not set`);
  }
  if (Array.isArray(v)) return v.map((x, i) => substituteEnv(x, env, `${where}[${i}]`));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteEnv(x, env, `${where}.${k}`)]));
  return v;
}

function fail(msg: string): never {
  throw new ConfigError(msg);
}
