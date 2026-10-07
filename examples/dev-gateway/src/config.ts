import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Tier, WatchDraft, errors, type Principal, type RunSpec, type WatchSource } from '@agents-io/protocol';
import { DEFAULT_BLOB_MAX_BYTES } from '@agents-io/session';
import { loadEnvFile } from '@agents-io/testkit';
import type { CodexTransportOption } from '@agents-io/harness-codex';

/*
 * aio.config.json: what runs. Secrets never go in it: they come from the
 * environment or a gitignored `.env.live` (KEY=VALUE), and any string in a
 * channel's `config` or a harness instance's `env`, `settings`, `mcpServers`
 * or `config` written as "env:NAME" is replaced by that variable.
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
    /** Dotted key → value, passed as `-c key=<TOML>` to `codex app-server`. */
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
  /** Feishu/Lark bot. App id, secret and domain come from LARK_APP_ID / LARK_APP_SECRET / LARK_DOMAIN. */
  Type.Object({ type: Type.Literal('lark-bot'), ...ChannelCommon, config: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, Closed),
  /** IMAP/SMTP mail: a MailChannelConfig (use "env:NAME" for passwords). */
  Type.Object({ type: Type.Literal('mail'), ...ChannelCommon, config: Type.Record(Type.String(), Type.Unknown()) }, Closed),
  /** Out-of-process channel spoken to over JSONL stdio (jsonl-bridge `spawnChannel`); how private channels attach. */
  Type.Object(
    {
      type: Type.Literal('bridge'),
      ...ChannelCommon,
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

export const ConfigFile = Type.Object(
  {
    /** State directory (default ~/.agents-io/dev-gateway). Relative paths are relative to the config file. */
    dataDir: Type.Optional(Type.String()),
    /** SQLite session log (default <dataDir>/log.sqlite; ":memory:" for none). */
    logPath: Type.Optional(Type.String()),
    /** Local client socket (default <dataDir>/run/aio.sock; its directory is made 0700). */
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
    channels: Type.Optional(Type.Array(ChannelEntry)),
    /**
     * Mount the host MCP output tools (send_file, ask_choice, mention, reply_to,
     * send_message, get_channel_context) into every harness instance (default true).
     */
    outputTools: Type.Optional(Type.Boolean()),
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

export interface Config {
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
  local: { principal: Principal; session: string };
}

export type ResolvedChannel =
  | (Extract<ChannelEntry, { type: 'lark-bot' }> & { account: string; lark: { appId: string; appSecret: string; domain: 'feishu' | 'lark' } })
  | (Extract<ChannelEntry, { type: 'mail' }> & { account: string })
  | (Extract<ChannelEntry, { type: 'bridge' }> & { account: string });

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const DEFAULT_MODEL: Record<HarnessKind, string> = { 'claude-code': 'haiku', codex: '' };
const MODEL_ENV: Record<HarnessKind, string> = { 'claude-code': 'AGENTS_IO_LIVE_CLAUDE_MODEL', codex: 'AGENTS_IO_LIVE_CODEX_MODEL' };
/** `.env.live` keys handed to the harness CLI; everything else (Lark, mail secrets) stays in this process. */
const HARNESS_ENV = /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|HTTPS?_PROXY$|NO_PROXY$)/;

/** Where `.env.live` is: an explicit path, next to the config file, or the nearest one up from `cwd`. */
export function findEnvFile(o: { envFile?: string; configDir?: string; cwd?: string }): string | undefined {
  if (o.envFile) return o.envFile;
  if (o.configDir && existsSync(join(o.configDir, '.env.live'))) return join(o.configDir, '.env.live');
  for (let d = resolve(o.cwd ?? process.cwd()); ; d = dirname(d)) {
    if (existsSync(join(d, '.env.live'))) return join(d, '.env.live');
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
  return resolveConfig(raw, { env, fileEnv, baseDir: dirname(path), harness: o.harness, cwd, channels: o.channels });
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

  const dataDir = path(c.dataDir ?? join(homedir(), '.agents-io', 'dev-gateway'));
  const { harnesses, defaultHarness } = resolveHarnesses(c, ctx, path);

  const owners = [...(c.policy?.owners ?? []), ...(env.AGENTS_IO_OWNERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  const ownerSessionKey = c.policy?.ownerSessionKey;

  return {
    dataDir,
    logPath: path(c.logPath ?? join(dataDir, 'log.sqlite')),
    socketPath: path(c.socketPath ?? join(dataDir, 'run', 'aio.sock')),
    blobs: { dir: path(c.blobs?.dir ?? join(dataDir, 'blobs')), maxBytes: c.blobs?.maxBytes ?? DEFAULT_BLOB_MAX_BYTES },
    cwd: path(c.cwd ?? ctx.cwd ?? process.cwd()),
    harnesses,
    defaultHarness,
    channels: ctx.channels === false ? [] : (c.channels ?? []).map((ch) => resolveChannel(ch, env, path)),
    outputTools: c.outputTools ?? true,
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
      session: c.local?.session ?? ownerSessionKey ?? 'local:main',
    },
  };
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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) fail(`${where}.env: ${JSON.stringify(k)} is not a variable name`);
    envOut[k] = v === null ? undefined : sub(v, `env.${k}`);
  }
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
      ...(x.config ? { config: sub(x.config, 'config') } : {}),
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
    ...(x.settings !== undefined ? { settings: typeof x.settings === 'string' ? path(x.settings) : sub(x.settings, 'settings') } : {}),
    ...(x.settingSources ? { settingSources: x.settingSources } : {}),
    ...(x.mcpServers ? { mcpServers: sub(x.mcpServers, 'mcpServers') } : {}),
    ...(x.plugins ? { plugins: x.plugins.map(path) } : {}),
    ...(x.skills !== undefined ? { skills: x.skills } : {}),
    ...(x.extraArgs ? { extraArgs: x.extraArgs } : {}),
    ...(x.additionalDirectories ? { additionalDirectories: x.additionalDirectories.map(path) } : {}),
  };
  return { ...common, kind: 'claude-code', claude, ...(unavailable ? { unavailable } : {}) };
}

function resolveChannel(ch: ChannelEntry, env: Record<string, string | undefined>, path: (p: string) => string): ResolvedChannel {
  const account = ch.account ?? 'default';
  switch (ch.type) {
    case 'lark-bot': {
      const need = (k: string) => env[k] || fail(`channel lark-bot needs ${k} (environment or .env.live)`);
      const domain = env.LARK_DOMAIN || 'feishu';
      if (domain !== 'feishu' && domain !== 'lark') fail(`LARK_DOMAIN must be 'feishu' or 'lark'`);
      return { ...ch, account, lark: { appId: need('LARK_APP_ID'), appSecret: need('LARK_APP_SECRET'), domain: domain as 'feishu' | 'lark' } };
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
