import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Tier, errors, type Principal, type RunSpec } from '@agents-io/protocol';
import { loadEnvFile } from '@agents-io/testkit';
import type { CodexTransportOption } from '@agents-io/harness-codex';

/*
 * aio.config.json: what runs. Secrets never go in it: they come from the
 * environment or a gitignored `.env.live` (KEY=VALUE), and any string in a
 * channel's `config` written as "env:NAME" is replaced by that variable.
 */

const Closed = { additionalProperties: false } as const;

const HarnessKind = Type.Union([Type.Literal('claude-code'), Type.Literal('codex')]);
export type HarnessKind = Static<typeof HarnessKind>;

const HarnessSection = {
  /** RunSpec base; the policy adds `profile`. Env AGENTS_IO_LIVE_<CLAUDE|CODEX>_MODEL overrides `model`. */
  run: Type.Optional(Type.Object({ model: Type.Optional(Type.String()), effort: Type.Optional(Type.String()) }, Closed)),
  /** Profile name (`bypass`, `restricted`, …) → harness-native settings (ClaudeProfile / CodexProfile). */
  profiles: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()))),
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
    /** Working directory for harness sessions (default: the current directory). */
    cwd: Type.Optional(Type.String()),
    harness: Type.Optional(
      Type.Object(
        {
          use: Type.Optional(HarnessKind),
          'claude-code': Type.Optional(Type.Object({ ...HarnessSection, claudePath: Type.Optional(Type.String()) }, Closed)),
          codex: Type.Optional(Type.Object({ ...HarnessSection, bin: Type.Optional(Type.String()), transport: Type.Optional(CodexTransport) }, Closed)),
        },
        Closed,
      ),
    ),
    channels: Type.Optional(Type.Array(ChannelEntry)),
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
        },
        Closed,
      ),
    ),
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

export interface HarnessConfig {
  kind: HarnessKind;
  run: Omit<RunSpec, 'profile'>;
  profiles: Record<string, Record<string, unknown>>;
  options: Record<string, unknown>;
  claudePath?: string;
  codexBin?: string;
  transport: CodexTransportOption;
  /** Variables from `.env.live` the harness CLI may need (API endpoints, tokens). */
  env: Record<string, string>;
}

export interface Config {
  dataDir: string;
  logPath: string;
  socketPath: string;
  cwd: string;
  harness: HarnessConfig;
  channels: ResolvedChannel[];
  policy: { owners: string[]; selfAccounts: string[]; agentAccounts: string[]; ownerSessionKey?: string; routes: string[] };
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
  /** Override `harness.use` (e.g. `aio-dev e2e --harness codex`). */
  harness?: HarnessKind;
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
  harness?: HarnessKind;
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
  const kind = ctx.harness ?? c.harness?.use ?? 'claude-code';
  const section = kind === 'codex' ? c.harness?.codex : c.harness?.['claude-code'];
  const model = env[MODEL_ENV[kind]] || section?.run?.model || DEFAULT_MODEL[kind];
  const codex = c.harness?.codex;
  const transport: CodexTransportOption = codex?.transport
    ? codex.transport.kind === 'unix'
      ? { ...codex.transport, ...(codex.transport.path ? { path: path(codex.transport.path) } : {}), ...(codex.transport.stateDir ? { stateDir: path(codex.transport.stateDir) } : {}) }
      : codex.transport
    : { kind: 'stdio' };

  const owners = [...(c.policy?.owners ?? []), ...(env.AGENTS_IO_OWNERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  const ownerSessionKey = c.policy?.ownerSessionKey;

  return {
    dataDir,
    logPath: path(c.logPath ?? join(dataDir, 'log.sqlite')),
    socketPath: path(c.socketPath ?? join(dataDir, 'run', 'aio.sock')),
    cwd: path(c.cwd ?? ctx.cwd ?? process.cwd()),
    harness: {
      kind,
      run: { harness: kind, model, ...(section?.run?.effort ? { effort: section.run.effort } : {}) },
      profiles: section?.profiles ?? {},
      options: section?.options ?? {},
      ...(c.harness?.['claude-code']?.claudePath ? { claudePath: path(c.harness['claude-code'].claudePath) } : {}),
      ...(codex?.bin ? { codexBin: codex.bin } : {}),
      transport,
      env: Object.fromEntries(Object.entries(ctx.fileEnv ?? {}).filter(([k]) => HARNESS_ENV.test(k))),
    },
    channels: ctx.channels === false ? [] : (c.channels ?? []).map((ch) => resolveChannel(ch, env, path)),
    policy: {
      owners,
      selfAccounts: c.policy?.selfAccounts ?? [],
      agentAccounts: c.policy?.agentAccounts ?? [],
      ...(ownerSessionKey ? { ownerSessionKey } : {}),
      routes: c.policy?.routes ?? [],
    },
    local: {
      principal: { id: c.local?.principal ?? owners[0] ?? 'local:owner', labels: c.local?.labels ?? ['owner'] },
      session: c.local?.session ?? ownerSessionKey ?? 'local:main',
    },
  };
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
