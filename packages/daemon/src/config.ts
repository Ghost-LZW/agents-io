import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Type, type Static, type TObject, type TSchema } from '@sinclair/typebox';
import {
  Binding,
  Evidence,
  IdentityEntry,
  Tier,
  WatchDraft,
  errors,
  type BindingTable,
  type ChannelResolveContext,
  type ChannelValidateContext,
  type HarnessChildSecrets,
  type HarnessModule,
  type HarnessResolveContext,
  type ModuleManifest,
  type Principal,
  type RunSpec,
  type WatchSource,
} from '@agents-io/protocol';
import { DEFAULT_BLOB_MAX_BYTES, Router, RouterError, checkIdentities, ownerIdentities, ownersTable, type AgentContactRule, type AgentSpec, type LoopGuardOptions } from '@agents-io/session';
import { builtinChannels, builtinHarnesses, builtinModules, type BuiltinChannelEntry, type BuiltinChannelSettings, type BuiltinModuleSections, type ExternalMcpConfig } from './bundle.js';
import type { ChannelRegistry } from './channel-registry.js';
import { ConfigError } from './config-error.js';
import { loadEnvFile } from './env-file.js';
import type { HarnessRegistry } from './harness-registry.js';
import { resolveModuleFile } from './module-loader.js';
import type { ModuleRegistry, ResolvedModule } from './modules.js';
import { KERNEL_TOOL_NAMES } from '@agents-io/host-mcp';

/*
 * aio.config.json: what runs. Secrets never go in it: they come from the
 * environment or a gitignored `.env.live` (KEY=VALUE), and any string in a
 * channel's `config` or a harness instance's `env`, `settings`, `mcpServers`
 * or `config` written as "env:NAME" is replaced by that variable. Settings
 * that reach a child's command line (claude `mcpServers` and inline
 * `settings`, codex `config`) never get the value itself: it goes into the
 * child's environment and the setting names the variable (`${NAME}`,
 * `settings.env`, codex `env_http_headers` / `bearer_token_env_var` /
 * `env_key` / `env_vars`); where that is impossible "env:" is refused. Each
 * harness kind's module does that for its own keys (`HarnessModule.resolve`,
 * through `HarnessChildSecrets`); the kinds are the ones a `HarnessRegistry`
 * holds (`bundle.ts` registers Claude Code and Codex).
 *
 * Agents (`agents: { <name>: { harness | preset, model?, effort?, profile?, cwd?,
 * mode?, tools?, instructionsFile? } }`) are named run configurations over the
 * instances. Presets (`presets: { <name>: { harness, model?, effort? } }`) name
 * one harness instance + model + effort: an agent may take its defaults from
 * one, and the owner switches a session to another with `/preset <name>`.
 * `bindings` (+ `identities`) is the local binding table
 * (docs/HOSTS.md §2). Without `bindings` the owners-based default table routes
 * to the default agent. Without `agents` there is one agent, `default`, on the
 * default instance (as before).
 *
 * Harnesses are NAMED INSTANCES (`harnesses: { <name>: { use, … } }`): each has
 * its own process environment and config dirs, `RunSpec.harness` is the
 * instance name, and the default policy plans `defaultHarness`. The older
 * single `harness: { use, 'claude-code': {…}, codex: {…} }` block still loads:
 * each section becomes an instance named after its kind. `use: "module"` loads a
 * harness plugin (a HarnessFactory) from an ES module, like a module channel.
 */

const Closed = { additionalProperties: false } as const;

/** A registered harness kind's name (`HarnessModule.kind`, the `use` of its instances). */
export type HarnessKind = string;

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

/**
 * In-process harness plugin: an ES module exporting a HarnessFactory (`@agents-io/protocol`), or a
 * HarnessModule. `module` resolves like a channel module's (relative to the config file, absolute,
 * a package directory, or a bare specifier); `config` is env-substituted and handed to the factory.
 */
const ModuleInstance = Type.Object(
  {
    use: Type.Literal('module'),
    ...InstanceCommon,
    module: Type.String(),
    /** Export holding the factory or descriptor (default `createHarness`, else `default`). */
    export: Type.Optional(Type.String()),
    config: Type.Optional(Type.Unknown()),
  },
  Closed,
);

const instanceSchemas = new WeakMap<HarnessModule, TObject>();

/** A registered kind's instance entry: `use`, the keys every instance has, then the kind's own (closed). */
function instanceSchema(m: HarnessModule): TObject {
  let s = instanceSchemas.get(m);
  if (!s) instanceSchemas.set(m, (s = Type.Object({ use: Type.Literal(m.kind), ...InstanceCommon, ...m.schema.properties }, Closed)));
  return s;
}

/** Named instances (`harnesses`): each entry's `use` is a registered kind or `module`; the rest is checked against that. */
function harnessesSchema(registry: HarnessRegistry) {
  return Type.Optional(Type.Record(Type.String(), Type.Object({ use: registry.kinds.length ? Type.Union([kindSchema(registry), Type.Literal('module')]) : Type.Literal('module') })));
}

/** The older single `harness` block: `use`, then each kind's section (`HarnessModule.legacy`), named after it. */
function legacyBlockSchema(registry: HarnessRegistry) {
  const sections = registry.modules.flatMap((m) => (m.legacy ? [[m.kind, Type.Optional(Type.Object({ ...LegacySection, ...m.legacy.schema.properties }, Closed))] as const] : []));
  return Type.Optional(Type.Object({ use: Type.Optional(kindSchema(registry)), ...Object.fromEntries(sections) }, Closed));
}

/** One of the registered kinds (`Type.Never` for none). */
function kindSchema(registry: HarnessRegistry): TSchema {
  return Type.Union(registry.kinds.map((k) => Type.Literal(k)));
}

const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const ChannelCommon = {
  account: Type.Optional(Type.String()),
  /** Rendering tier for this channel (default: the adapter's `caps.defaultTier`). */
  tier: Type.Optional(Tier),
  /**
   * Hold each turn's first message this long (ms) on streaming tiers. Lark defaults to 5000
   * and waits through answer deltas, then opens with the first answer text; an approval still opens immediately. Other channels
   * default to 0 and answer text opens early.
   */
  openDelayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
  /** Lark native process preview delay (ms), before the reply card. Default 2000. */
  previewDelayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
  /**
   * Acknowledge inbound messages (Lark: a reaction on them): working while handled; taken away
   * once a reply came, or `done` when the reply took longer than `doneAfterMs` (default 60000);
   * `failed` when it did not complete. `true` for the defaults.
   */
  ack: Type.Optional(Type.Union([Type.Boolean(), Type.Object({ doneAfterMs: Type.Optional(Type.Integer({ minimum: 0 })) }, Closed)])),
  /**
   * Sender evidence this channel may give (channel-stamping): the cap is this ∩ the
   * adapter's `caps.evidence`, and stronger claims become `none`. Default: what the
   * type was registered with (`ChannelRegistry.defaultEvidence`; `bundle.ts`: lark-bot
   * and mail `caps.evidence`); bridge and module channels, and any type registered
   * without, only `device_only` (never `platform_signed` / `dkim_pass` unless granted here).
   */
  evidence: Type.Optional(Type.Array(Evidence)),
};

type ChannelCommonFields = Static<TObject<typeof ChannelCommon>>;

/**
 * Channel ids of the built-in adapters, local ends and agent addresses (`agent:<agent>:<sessionKey>`
 * routes, the `agent` identity namespace the daemon stamps, ID-7): no bridge or module channel may use them.
 * The ones the built-in types declare (`ChannelModule.ids`), then the daemon's own (`CORE_CHANNEL_IDS`).
 */
export const RESERVED_CHANNEL_IDS: readonly string[] = builtinChannels.reservedIds;
/** Evidence a channel of a type registered `ungranted` (bridge, module) may give without an `evidence` grant. */
export const UNGRANTED_EVIDENCE: readonly Evidence[] = ['device_only', 'none'];

const channelEntrySchemas = new WeakMap<ChannelRegistry, TSchema>();

/** A `channels[]` entry: for each registered type (in order), `type`, the keys every entry has, then the type's own (`ChannelModule.entry`), closed. */
function channelEntrySchema(registry: ChannelRegistry): TSchema {
  let s = channelEntrySchemas.get(registry);
  if (!s) {
    const members = registry.modules.map((m) => {
      const taken = Object.keys(m.entry).find((k) => k === 'type' || Object.hasOwn(ChannelCommon, k));
      if (taken !== undefined) throw new Error(`channel type ${JSON.stringify(m.type)}: every channel entry has ${JSON.stringify(taken)}; its module cannot declare it`);
      return Type.Object({ type: Type.Literal(m.type), ...ChannelCommon, ...m.entry }, Closed);
    });
    channelEntrySchemas.set(registry, (s = Type.Union(members)));
  }
  return s;
}

/** A `channels[]` entry of a built-in type, as written. */
export type ChannelEntry = ChannelCommonFields & BuiltinChannelEntry;
const ChannelEntry = channelEntrySchema(builtinChannels) as TSchema & { static: ChannelEntry };

/** The `console` section's own keys before the modules' ones: the console server's. */
const ConsoleServerKeys = {
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
  heartbeat: Type.Optional(Type.Object({ intervalMs: Type.Optional(Type.Integer({ minimum: 0 })), timeoutMs: Type.Optional(Type.Integer({ minimum: 100 })) }, Closed)),
};

/** The `console` section's own keys after the modules' ones. */
const ConsoleApplyKeys = {
  /**
   * Apply `channels` changes written through the console (`PUT /api/config`, or a module's
   * route that adds a channel, such as a provisioned bot) to the running daemon: start new or
   * changed entries, stop removed or changed ones, keep the rest. Default false (changes take
   * effect at the next start).
   */
  liveChannels: Type.Optional(Type.Boolean()),
};

type ConsoleSection = TObject<typeof ConsoleServerKeys & typeof ConsoleApplyKeys>;
const consoleSections = new WeakMap<ChannelRegistry, ConsoleSection>();

/**
 * The `console` section over a registry's channel types: the console's own keys and, between the
 * server's and `liveChannels`, the settings the types contribute (`AdminContribution.console`,
 * each optional, in registration order; lark-bot's `larkBotCommand` is where it always was).
 * Closed, so a setting no registered type declares is a config error.
 */
function consoleSchema(registry: ChannelRegistry): ConsoleSection {
  let s = consoleSections.get(registry);
  if (!s) {
    const contributed: Record<string, TSchema> = {};
    for (const { type, admin } of registry.adminContributions) {
      for (const [k, schema] of Object.entries(admin.console ?? {})) {
        if (Object.hasOwn(ConsoleServerKeys, k) || Object.hasOwn(ConsoleApplyKeys, k)) throw new Error(`channel type ${JSON.stringify(type)}: admin setting console.${k} is the console's own`);
        contributed[k] = Type.Optional(schema);
      }
    }
    // The static type has the console's own keys only: `resolveConsole` reads the others by name.
    s = Type.Object({ ...ConsoleServerKeys, ...contributed, ...ConsoleApplyKeys }, Closed) as unknown as ConsoleSection;
    consoleSections.set(registry, s);
  }
  return s;
}

/** A named run preset: one harness instance with its model and effort (`presets.<name>`). */
const PresetEntry = Type.Object(
  {
    /** Harness instance (a name from `harnesses`). */
    harness: Type.String(),
    /** Over the instance's `run.model`. */
    model: Type.Optional(Type.String()),
    /** Over the instance's `run.effort`. */
    effort: Type.Optional(Type.String()),
    /** One line `/preset` shows next to it. */
    description: Type.Optional(Type.String()),
  },
  Closed,
);

const AgentEntry = Type.Object(
  {
    /** Harness instance (a name from `harnesses`). Give this or `preset`. */
    harness: Type.Optional(Type.String()),
    /** Preset (a name from `presets`) giving the harness, model and effort; the agent's own `model` / `effort` win. Give this or `harness`. */
    preset: Type.Optional(Type.String()),
    /** Over the instance's (or preset's) model. */
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
    /**
     * Mount the host MCP output tools for this agent (default: top-level `outputTools`,
     * itself off by default: principle 2, decision 13). This is the per-agent switch:
     * `true` mounts every tool, a list of tool names only those (`[]` is `false`).
     */
    tools: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
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

/**
 * The config file's own keys (the kernel's) over the built-in harness kinds and channel types:
 * `ConfigFile` without the modules' sections (`configFileSchema` adds a registry's).
 */
const KernelFile = Type.Object(
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
    /** Named harness instances; `RunSpec.harness` is the name. Each entry is checked against its `use` (a registered kind, or `module`). */
    harnesses: harnessesSchema(builtinHarnesses),
    /** Instance the default policy plans (default: the only one, else the first). */
    defaultHarness: Type.Optional(Type.String()),
    /** Older single-harness form; each section becomes an instance named after its kind. */
    harness: legacyBlockSchema(builtinHarnesses),
    /**
     * Named presets: harness instance + model + effort. An agent's `preset` is its default;
     * the owner switches one session to another with `/preset <name>` (`default` is reserved).
     */
    presets: Type.Optional(Type.Record(Type.String(), PresetEntry)),
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
     * Default of every agent's `tools`: mount the host MCP output tools (send_file,
     * ask_choice, mention, reply_to, send_message, watch_*, session_*, live_*…).
     * Default false since decision 13 (it was true): turn tools on per agent with
     * `agents.<name>.tools: true`, or set this to true for every agent.
     */
    outputTools: Type.Optional(Type.Boolean()),
    /**
     * Topics (decision 6). `parkedIdleMs`: a parked topic's lane (and harness session) closes
     * once it has been parked and idle this long (default 30 min; 0 = never); switching back
     * reopens it, resuming the harness session by its native id.
     */
    topics: Type.Optional(Type.Object({ parkedIdleMs: Type.Optional(Type.Number({ minimum: 0 })) }, Closed)),
    /**
     * Timeouts of the host's `resolve` / `outbound` / `external` callouts (a host opts in with
     * `host.hello { callouts: [...] }`; `route` callouts use the rule's own timeout).
     * Defaults 3000 / 2000 / 2000 ms.
     */
    hostCallouts: Type.Optional(
      Type.Object(
        {
          resolve: Type.Optional(Type.Object({ timeoutMs: Type.Optional(Type.Number({ minimum: 1 })) }, Closed)),
          review: Type.Optional(Type.Object({ timeoutMs: Type.Optional(Type.Number({ minimum: 1 })) }, Closed)),
          outbound: Type.Optional(Type.Object({ timeoutMs: Type.Optional(Type.Number({ minimum: 1 })) }, Closed)),
          external: Type.Optional(Type.Object({ timeoutMs: Type.Optional(Type.Number({ minimum: 1 })) }, Closed)),
        },
        Closed,
      ),
    ),
    policy: Type.Optional(
      Type.Object(
        {
          /** `${channel}:${channelUserId}`, e.g. `lark-bot:<union_id>`. Env AGENTS_IO_OWNERS (comma separated) adds more. */
          owners: Type.Optional(Type.Array(Type.String())),
          selfAccounts: Type.Optional(Type.Array(Type.String())),
          agentAccounts: Type.Optional(Type.Array(Type.String())),
          /** Put every owner DM (any channel) into this one session. */
          ownerSessionKey: Type.Optional(Type.String()),
          /**
           * Messages from people the deployment does not know, addressed to it (a DM, an @ in a group;
           * not mail): `drop` (default) leaves them as routed; `ask` asks the owner, in the chat of
           * `ownerSessionKey`, whether to let the agent answer (decision 15). The stranger approval
           * module's setting (an alias of its section `strangers`: `ask` turns it on, `drop` off).
           */
          strangers: Type.Optional(Type.Union([Type.Literal('drop'), Type.Literal('ask')])),
          routes: Type.Optional(Type.Array(Type.String())),
          /**
           * Let a request be answered on someone's behalf (default false, decision 13): a host
           * connection's `resolve { onBehalfOf }` is refused with `on_behalf_not_allowed` until
           * this is true. The one switch for answering in another's name; agent-on-behalf
           * approval (decision 12) will sit behind it too.
           */
          answerOnBehalf: Type.Optional(Type.Boolean()),
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
          /**
           * Loop guard (docs/design/agent-messaging §4.4): an agent input with a hop above
           * `maxHops` (default 8), or one more from a peer that started `pair.maxTurns`
           * (default 10) turns in a session within `pair.windowMs` (default 15 min) since a
           * person last wrote there, is recorded as context instead of starting a turn.
           */
          loopGuard: Type.Optional(
            Type.Object(
              {
                maxHops: Type.Optional(Type.Integer({ minimum: 1 })),
                pair: Type.Optional(Type.Object({ maxTurns: Type.Optional(Type.Integer({ minimum: 1 })), windowMs: Type.Optional(Type.Integer({ minimum: 1 })) }, Closed)),
              },
              Closed,
            ),
          ),
          /**
           * Which agent may contact which (`Policy.contact`; `from` / `to` an agent name or `*`,
           * `ops` default all). Not set: every contact is denied (agent-messaging §4.6).
           */
          agentContacts: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  from: Type.String(),
                  to: Type.String(),
                  ops: Type.Optional(Type.Array(Type.Union(['list', 'send', 'run', 'observe', 'control'].map((x) => Type.Literal(x))))),
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
    console: Type.Optional(consoleSchema(builtinChannels)),
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

/** The config file as written, over the built-in harness kinds, channel types and modules. */
export type ConfigFile = Static<typeof KernelFile> & BuiltinModuleSections;

const fileSchemas = new WeakMap<HarnessRegistry, WeakMap<ChannelRegistry, WeakMap<ModuleRegistry, TObject>>>();

/**
 * The registered modules' config sections (`ModuleConfig`): each its `section` key, an object of
 * `enabled` and the module's own keys, closed. A section may not be one of the file's own keys.
 */
function moduleSections(modules: ModuleRegistry): Record<string, TSchema> {
  const out: Record<string, TSchema> = {};
  for (const { manifest: m } of modules.modules) {
    if (!m.config) continue;
    const key = m.config.section;
    if (Object.hasOwn(KernelFile.properties, key)) throw new Error(`module ${m.id}: config section ${JSON.stringify(key)} is one of the config file's own keys`);
    out[key] = Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()), ...m.config.schema }, Closed));
  }
  return out;
}

/**
 * The config file's schema over a registry's harness kinds (`harnesses.<name>.use`, the older
 * `harness` block), a registry's channel types (`channels[].type` and the settings they add to
 * `console`; default the built-in ones) and a registry's modules (their config sections; default
 * the built-in ones); the rest is the kernel's own keys. The modules' sections come before `local`,
 * where `externalMcp` was before it was a module, so a file's schema errors come in the order they
 * always did. Built once per set of registries (`ConfigFile` is the built-in ones').
 */
export function configFileSchema(registry: HarnessRegistry, channels: ChannelRegistry = builtinChannels, modules: ModuleRegistry = builtinModules): TObject {
  let byChannels = fileSchemas.get(registry);
  if (!byChannels) fileSchemas.set(registry, (byChannels = new WeakMap()));
  let byModules = byChannels.get(channels);
  if (!byModules) byChannels.set(channels, (byModules = new WeakMap()));
  let s = byModules.get(modules);
  if (!s) {
    const { local, ...head } = KernelFile.properties;
    s = Type.Object(
      {
        ...head,
        harnesses: harnessesSchema(registry),
        harness: legacyBlockSchema(registry),
        channels: Type.Optional(Type.Array(channelEntrySchema(channels))),
        console: Type.Optional(consoleSchema(channels)),
        ...moduleSections(modules),
        local,
      },
      Closed,
    );
    byModules.set(modules, s);
  }
  return s;
}

/**
 * The config file's schema over the built-in harness kinds, channel types and modules (`bundle.ts`):
 * the kernel's keys and the built-in modules' sections (`externalMcp`).
 */
export const ConfigFile: TObject = configFileSchema(builtinHarnesses, builtinChannels, builtinModules);

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

/** A harness plugin module (`use: "module"`). */
export interface ModuleLaunch {
  /** The resolved file to import. */
  file: string;
  /** Export name; default `createHarness`, falling back to `default`. */
  export?: string;
  /** The entry's `config`, env-substituted. */
  config?: unknown;
}

export type HarnessInstance = InstanceBase & {
  /**
   * A registered kind (`HarnessModule.kind`, e.g. `claude-code`, `codex`), or `module`; with no kind
   * registered and none configured, `embedded` (`EMBEDDED_HARNESS`: the embedder's adapter).
   */
  kind: string;
  /**
   * The kind's launch settings, as its module resolved the entry (`HarnessModule.resolve`, e.g.
   * `ClaudeLaunch` / `CodexLaunch` of the harness packages); for `module`, a `ModuleLaunch`.
   *
   * Deprecated, kept for one release: an instance `resolveConfig` returns also has it under the
   * field it had before (`module`; a registered kind's `HarnessRegistry.launchAlias`, the built-in
   * ones `claude` / `codex`), an accessor of `launch` for reading and writing, not enumerable (a
   * spread or JSON copy has only `launch`).
   */
  launch: unknown;
};

/** A named run preset (`presets.<name>`). */
export interface PresetConfig {
  name: string;
  /** Harness instance name. */
  harness: string;
  model?: string;
  effort?: string;
  description?: string;
}

/** A named run configuration. */
export interface AgentConfig {
  name: string;
  /** Harness instance name (the preset's, when the agent names one). */
  harness: string;
  /** The preset `harness`, `model` and `effort` came from (the agent's own `model` / `effort` win). */
  preset?: string;
  model?: string;
  effort?: string;
  profile?: string;
  cwd?: string;
  mode: 'interactive' | 'task';
  /** Host MCP output tools mounted. */
  tools: boolean;
  /** Only these tools are listed (`agents.<name>.tools` as a list); every tool when absent. */
  toolNames?: string[];
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

/** Variables naming a built-in harness's config dir (`HarnessModule.defaults.configDirEnv`): in `envKeys` only with roots in `envPathRoots`. */
export const CONFIG_DIR_KEYS: string[] = builtinHarnesses.configDirKeys();

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
  /** Named presets (harness instance + model + effort), in config order. */
  presets: Record<string, PresetConfig>;
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
    /**
     * `policy.strangers` (default `drop`). Deprecated, kept for one release: whether the stranger
     * approval module is on (`ask`) or off (`drop`), as `modules` says (its section `strangers`
     * decides over `policy.strangers`). Given the other value before `Gateway.start`, or in a config
     * without `modules`, it still turns the module on or off (`ModuleFields.switch`).
     */
    strangers: 'drop' | 'ask';
    routes: string[];
    watchAllowlist: Partial<Pick<WatchSource, 'channel' | 'account' | 'conversation' | 'conversationKind'>>[];
    /** `policy.answerOnBehalf` (default false): `resolve { onBehalfOf }` is allowed. */
    answerOnBehalf: boolean;
    /** `policy.loopGuard` (defaults in `LOOP_GUARD_DEFAULTS`). */
    loopGuard: LoopGuardOptions;
    /** `policy.agentContacts` (none: every contact denied). */
    agentContacts: AgentContactRule[];
  };
  /** Owner watches from the config file. */
  watches: (WatchDraft & { id: string })[];
  /** The config's `outputTools` (default false): the default of every agent's `tools`. */
  outputTools: boolean;
  /** How long a parked topic's lane stays open while idle (0: until the daemon stops). */
  topics: { parkedIdleMs: number };
  /** Host `resolve` / `outbound` callout timeouts (ms). */
  hostCallouts: { resolveTimeoutMs: number; reviewTimeoutMs: number; outboundTimeoutMs: number; externalTimeoutMs: number };
  local: { principal: Principal; session: string };
  /** The console API server. */
  console: ConsoleConfig;
  /** The host connection: `tokenFile` is an absolute path when set. */
  host?: { tokenFile?: string };
  /**
   * Deprecated, kept for one release: the external MCP endpoint's settings (section `externalMcp`),
   * when it is on; the same object as its module's in `modules` (`ModuleFields.config`, set by
   * `bundle.ts`). Given another value or removed before `Gateway.start`, it still turns the
   * endpoint on, changes or off.
   */
  externalMcp?: ExternalMcpConfig;
  /**
   * The registered feature modules, on or off, with their settings (`resolveModules`), in
   * registration order; absent when the registry has none.
   */
  modules?: ResolvedModule[];
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
  /** `/ws` ping interval (0: off) and how long a ping waits for an answer. */
  heartbeat: { intervalMs: number; timeoutMs: number };
  /** Apply channel changes written through the console at once. */
  liveChannels: boolean;
  /**
   * The settings the channel types contribute (`AdminContribution.console`; the built-in lark-bot
   * type's `larkBotCommand`), by key, as `consoleSettings` resolves them: the value written, else
   * the key's schema default.
   */
  readonly [setting: string]: unknown;
}
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

/**
 * The console settings one contribution declares (`AdminContribution.console`), from a console
 * section (as written, or a resolved `ConsoleConfig`): each key's value, else a copy of its
 * schema's `default`; a key with neither is left out. What the module gets as `AdminContext.console`.
 */
export function consoleSettings(section: Readonly<Record<string, unknown>> | undefined, keys: Readonly<Record<string, TSchema>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, schema] of Object.entries(keys ?? {})) {
    const written = section?.[k];
    const v = written !== undefined ? written : structuredClone((schema as { default?: unknown }).default);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function resolveConsole(c: ConfigFile['console'], channels: ChannelRegistry): ConsoleConfig {
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
    ...Object.assign({}, ...channels.adminContributions.map(({ admin }) => consoleSettings(c, admin.console))),
    heartbeat: { intervalMs: c?.heartbeat?.intervalMs ?? DEFAULT_WS_HEARTBEAT_MS, timeoutMs: c?.heartbeat?.timeoutMs ?? DEFAULT_WS_HEARTBEAT_TIMEOUT_MS },
    liveChannels: c?.liveChannels === true,
  };
}

/**
 * A `channels[]` entry as resolved: `type`, the keys every entry has, `account` (default `default`)
 * and what the type's module made of the rest (`ChannelModule.resolve`; a `module` entry's `module`
 * is the resolved file to import). Typed for the built-in types; another registry's resolve the same way.
 */
export type ResolvedChannel = ChannelCommonFields & { account: string } & BuiltinChannelSettings;

/** `topics.parkedIdleMs` default: a parked topic's lane closes after 30 idle minutes. */
export const DEFAULT_PARKED_IDLE_MS = 30 * 60_000;

export { ConfigError };

/**
 * `.env.live` keys the older block's instances get besides their kinds' own (`legacy.envPrefixes`);
 * everything else (Lark, mail secrets) stays in this process.
 */
const PROXY_ENV = /^(HTTPS?_PROXY|NO_PROXY)$/;

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
  /** The harness kinds `use` may name (default the built-in ones, `bundle.ts`); give `Gateway.start` the same. */
  harnessRegistry?: HarnessRegistry;
  /** The channel types `channels[].type` may name (default the built-in ones, `bundle.ts`); give `Gateway.start` the same. */
  channelRegistry?: ChannelRegistry;
  /** The feature modules whose config sections the file may have (default the built-in ones, `bundle.ts`); give `Gateway.start` the same. */
  moduleRegistry?: ModuleRegistry;
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
  const c = resolveConfig(raw, {
    env,
    fileEnv,
    baseDir: dirname(path),
    harness: o.harness,
    cwd,
    channels: o.channels,
    ...(o.harnessRegistry ? { harnessRegistry: o.harnessRegistry } : {}),
    ...(o.channelRegistry ? { channelRegistry: o.channelRegistry } : {}),
    ...(o.moduleRegistry ? { moduleRegistry: o.moduleRegistry } : {}),
  });
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
  /** The harness kinds `use` may name (default the built-in ones, `bundle.ts`). */
  harnessRegistry?: HarnessRegistry;
  /** The channel types `channels[].type` may name (default the built-in ones, `bundle.ts`); give `Gateway.start` the same. */
  channelRegistry?: ChannelRegistry;
  /** The feature modules whose config sections the file may have (default the built-in ones, `bundle.ts`); give `Gateway.start` the same. */
  moduleRegistry?: ModuleRegistry;
}

/** Validate a parsed config file and fill defaults. Error messages name keys, never values. */
export function resolveConfig(raw: unknown, ctx: ResolveContext): Config {
  const registry = ctx.harnessRegistry ?? builtinHarnesses;
  const channelRegistry = ctx.channelRegistry ?? builtinChannels;
  const moduleRegistry = ctx.moduleRegistry ?? builtinModules;
  const schema = configFileSchema(registry, channelRegistry, moduleRegistry);
  const errs = errors(schema, raw);
  if (errs.length) throw new ConfigError(`invalid config: ${[...errs.slice(0, 5), ...unregistered(raw, schema, registry, channelRegistry)].join('; ')}`);
  const c = raw as ConfigFile;
  const env = ctx.env;
  const path = (p: string) => {
    const home = p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
    return isAbsolute(home) || home === ':memory:' ? home : resolve(ctx.baseDir, home);
  };

  const warnings: string[] = [];
  const dataDir = path(c.dataDir ?? join(homedir(), '.agents-io', 'aio'));
  const { harnesses, defaultHarness } = resolveHarnesses(c, ctx, path, registry);

  const owners = [...(c.policy?.owners ?? []), ...(env.AGENTS_IO_OWNERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  const ownerSessionKey = c.policy?.ownerSessionKey;
  // Off unless asked for (principle 2, decision 13: the default was true before 2026-10-11).
  const outputTools = c.outputTools ?? false;
  const presets = resolvePresets(c, harnesses);
  // Which modules are on now (the tool catalog needs it); their settings resolve last (below).
  const switches = moduleSwitches(raw as Record<string, unknown>, moduleRegistry);
  const { agents, defaultAgent } = resolveAgents(c, harnesses, presets, defaultHarness, outputTools, path, registry.configDirKeys(), toolCatalog(moduleRegistry, switches));
  const identities = c.identities ?? [];
  const localSession = c.local?.session ?? ownerSessionKey ?? 'local:main';
  const table: BindingTable | undefined = c.bindings ? { version: 'config', bindings: c.bindings, identities: [] } : undefined;
  checkTable({ agents, defaultAgent, owners, identities, table, ownerSessionKey, localSession });

  const config: Config = {
    dataDir,
    logPath: path(c.logPath ?? join(dataDir, 'log.sqlite')),
    socketPath: path(c.socketPath ?? join(dataDir, 'run', 'aio.sock')),
    blobs: { dir: path(c.blobs?.dir ?? join(dataDir, 'blobs')), maxBytes: c.blobs?.maxBytes ?? DEFAULT_BLOB_MAX_BYTES },
    cwd: path(c.cwd ?? ctx.cwd ?? process.cwd()),
    harnesses,
    defaultHarness,
    presets,
    agents,
    defaultAgent,
    ...(table ? { table } : {}),
    identities,
    channels: ctx.channels === false ? [] : resolveChannels(c.channels ?? [], env, path, warnings, channelRegistry),
    outputTools,
    topics: { parkedIdleMs: c.topics?.parkedIdleMs ?? DEFAULT_PARKED_IDLE_MS },
    hostCallouts: {
      resolveTimeoutMs: c.hostCallouts?.resolve?.timeoutMs ?? 3000,
      reviewTimeoutMs: c.hostCallouts?.review?.timeoutMs ?? 15_000,
      outboundTimeoutMs: c.hostCallouts?.outbound?.timeoutMs ?? 2000,
      externalTimeoutMs: c.hostCallouts?.external?.timeoutMs ?? 2000,
    },
    policy: {
      owners,
      selfAccounts: c.policy?.selfAccounts ?? [],
      agentAccounts: c.policy?.agentAccounts ?? [],
      ...(ownerSessionKey ? { ownerSessionKey } : {}),
      strangers: c.policy?.strangers ?? 'drop',
      routes: c.policy?.routes ?? [],
      watchAllowlist: c.policy?.watchAllowlist ?? [],
      answerOnBehalf: c.policy?.answerOnBehalf ?? false,
      loopGuard: c.policy?.loopGuard ?? {},
      agentContacts: (c.policy?.agentContacts ?? []) as AgentContactRule[],
    },
    watches: c.watches ?? [],
    local: {
      principal: { id: c.local?.principal ?? owners[0] ?? 'local:owner', labels: c.local?.labels ?? ['owner'] },
      session: localSession,
    },
    console: resolveConsole(c.console, channelRegistry),
    host: c.host?.tokenFile !== undefined ? { tokenFile: path(c.host.tokenFile) } : {},
  };
  // After everything else, where the external MCP endpoint's settings were resolved before it was a
  // module: a file with several mistakes fails on the one it always did.
  const modules = moduleSettings(switches, { raw: raw as Record<string, unknown>, env, path });
  const fields = moduleRegistry.fields;
  for (const m of modules) {
    // Where a module's on/off was before it was a module (`policy.strangers`): what it is now (deprecated).
    const sw = fields.get(m.id)?.switch;
    if (sw !== undefined) {
      const keys = sw.path.split('.');
      const parent = keys.slice(0, -1).reduce<unknown>((o, k) => (o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>)[k] : undefined), config);
      if (!parent || typeof parent !== 'object' || Array.isArray(parent)) throw new Error(`module ${m.id}: Config.${sw.path} is not in an object of the config`);
      (parent as Record<string, unknown>)[keys.at(-1)!] = m.enabled ? sw.on : sw.off;
    }
    const field = fields.get(m.id)?.config;
    if (field === undefined || !m.enabled || m.config === undefined) continue;
    if (Object.hasOwn(config, field) || ['table', 'modules', 'warnings', 'source'].includes(field)) throw new Error(`module ${m.id}: Config.${field} is one of the config's own fields`);
    (config as unknown as Record<string, unknown>)[field] = m.config;
  }
  return {
    ...config,
    ...(moduleRegistry.size ? { modules } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A name the errors below may quote (a type or kind name, not a value that could be a secret). */
const quotable = (v: string) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? ` ${JSON.stringify(v)}` : '');

/**
 * What a file that fails its schema uses of a module these registries do not have (CF-4): a
 * channel type, a harness kind, a config section, a console setting. Said after the schema's
 * errors, so a config written for modules the daemon lacks (one built with `coreRegistries`, an
 * embedder's own registries) fails naming them, not only the schema path.
 */
function unregistered(raw: unknown, schema: TObject, harnesses: HarnessRegistry, channels: ChannelRegistry): string[] {
  if (!isRecord(raw)) return [];
  const out: string[] = [];
  const listed = (names: string[]) => (names.length ? names.join(', ') : 'none');
  if (Array.isArray(raw.channels)) {
    raw.channels.forEach((e, i) => {
      const type = isRecord(e) ? e.type : undefined;
      if (typeof type === 'string' && !channels.get(type)) out.push(`channels[${i}].type: no channel module${quotable(type)} is registered (registered types: ${listed(channels.types)})`);
    });
  }
  const kinds = `registered kinds: ${listed(harnesses.kinds)}`;
  if (isRecord(raw.harnesses)) {
    for (const [name, e] of Object.entries(raw.harnesses)) {
      const use = isRecord(e) ? e.use : undefined;
      if (typeof use === 'string' && use !== 'module' && !harnesses.get(use)) out.push(`harnesses.${name}.use: no harness module${quotable(use)} is registered (${kinds}; or "module")`);
    }
  }
  if (isRecord(raw.harness)) {
    for (const [k, v] of Object.entries(raw.harness)) {
      const kind = k === 'use' ? v : k;
      if (typeof kind === 'string' && kind !== 'module' && !harnesses.get(kind)) out.push(`harness.${k}: no harness module${quotable(kind)} is registered (${kinds})`);
    }
  }
  for (const k of Object.keys(raw)) if (!Object.hasOwn(schema.properties, k)) out.push(`${k}: not a key of the config, and no registered module has a section of that name`);
  if (isRecord(raw.console)) {
    const settings = (consoleSchema(channels) as unknown as TObject).properties;
    for (const k of Object.keys(raw.console)) if (!Object.hasOwn(settings, k)) out.push(`console.${k}: not a console setting, and no registered channel module adds one of that name`);
  }
  return out;
}

/** The value at a dotted path of the file (`policy.strangers`), if set. */
function at(raw: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = raw;
  for (const k of dotted.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Step 1 of the module lifecycle (core-slimming G6): every registered module, on or off, with its
 * settings. A module without a config section is on. One with a section: the section present is on
 * unless `enabled: false` (`resolve` gets the rest); absent, the first of its `aliases` that is set
 * decides: on unless its `aliasEnabled` says false or, without one, the value is an object with
 * `enabled: false` (`resolve` gets the value as it is); with neither, `defaultEnabled` (`resolve`
 * gets `{}`). A module that is on and needs another (`module:<id>`) that is off fails the config.
 * Whether each is on is settled first, for all of them; then the ones that are on resolve.
 */
export function resolveModules(raw: Record<string, unknown>, registry: ModuleRegistry, env: Record<string, string | undefined>, path: (p: string) => string): ResolvedModule[] {
  return moduleSettings(moduleSwitches(raw, registry), { raw, env, path });
}

/** A module on or off, and, when on, what its `config.resolve` gets. */
interface ModuleSwitch {
  m: ModuleManifest<unknown>;
  id: string;
  enabled: boolean;
  value?: unknown;
  where?: string;
  alias?: string;
}

/** `resolveModules`, first half: every module on or off (and the `needs` between them). */
function moduleSwitches(raw: Record<string, unknown>, registry: ModuleRegistry): ModuleSwitch[] {
  const out: ModuleSwitch[] = [];
  for (const { manifest: m } of registry.modules) {
    const cfg = m.config;
    if (!cfg) {
      out.push({ m, id: m.id, enabled: true });
      continue;
    }
    const section = Object.hasOwn(raw, cfg.section) ? (raw[cfg.section] as Record<string, unknown>) : undefined;
    let value: unknown;
    let where = cfg.section;
    let alias: string | undefined;
    let enabled: boolean;
    if (section !== undefined) {
      const { enabled: on, ...rest } = section;
      enabled = on !== false;
      value = rest;
    } else {
      alias = cfg.aliases?.find((a) => at(raw, a) !== undefined);
      if (alias !== undefined) {
        value = at(raw, alias);
        where = alias;
        if (cfg.aliasEnabled) {
          const on: unknown = cfg.aliasEnabled(value, alias);
          if (typeof on !== 'boolean') fail(`module ${m.id}: config.aliasEnabled must return a boolean (got ${typeof on} for ${alias})`);
          enabled = on;
        } else enabled = !(value && typeof value === 'object' && !Array.isArray(value) && (value as { enabled?: unknown }).enabled === false);
      } else {
        enabled = cfg.defaultEnabled;
        value = {};
      }
    }
    out.push(enabled ? { m, id: m.id, enabled, value, where, ...(alias !== undefined ? { alias } : {}) } : { m, id: m.id, enabled });
  }
  const on = new Set(out.filter((x) => x.enabled).map((x) => x.id));
  for (const { manifest: m } of registry.modules) {
    if (!on.has(m.id)) continue;
    for (const n of m.needs ?? []) if (n.startsWith('module:') && !on.has(n.slice('module:'.length))) fail(`module ${m.id} needs module ${n.slice('module:'.length)}, which is off`);
  }
  return out;
}

/** `resolveModules`, second half: the settings of the modules that are on, in registration order. */
function moduleSettings(switches: readonly ModuleSwitch[], o: { raw: Record<string, unknown>; env: Record<string, string | undefined>; path: (p: string) => string }): ResolvedModule[] {
  return switches.map((x): ResolvedModule => {
    if (!x.enabled) return { id: x.id, enabled: false };
    if (!x.m.config) return { id: x.id, enabled: true };
    const config = x.m.config.resolve(x.value, {
      where: x.where!,
      ...(x.alias !== undefined ? { alias: x.alias } : {}),
      env: o.env,
      substitute: (v, w) => substituteEnv(v, o.env, w),
      path: o.path,
      valueAt: (dotted) => structuredClone(at(o.raw, dotted)),
      fail: (msg) => fail(msg),
    });
    return { id: x.id, enabled: true, config };
  });
}

/**
 * The model tools agents may list (`agents.<name>.tools`): the kernel's six, then the modules' that
 * are on (the watch, live and topic tools are the built-in modules'), in that order; and whose tools are off.
 */
interface ToolCatalog {
  names: readonly string[];
  /** A tool of a registered module that is off → that module. */
  off: ReadonlyMap<string, string>;
}

function toolCatalog(registry: ModuleRegistry, modules: readonly { id: string; enabled: boolean }[]): ToolCatalog {
  const on = new Set(modules.filter((x) => x.enabled).map((x) => x.id));
  const names: string[] = [...KERNEL_TOOL_NAMES];
  const off = new Map<string, string>();
  for (const { manifest: m } of registry.modules) for (const t of m.mcpTools ?? []) (on.has(m.id) ? names.push(t.name) : off.set(t.name, m.id));
  return { names, off };
}

/** The synthesized agent of a config without `agents`: the default instance, bare route-key sessions. */
export const DEFAULT_AGENT = 'default';

/** `/preset default` goes back to the agent's own: no preset may have this name. */
export const DEFAULT_PRESET = 'default';

function resolvePresets(c: ConfigFile, harnesses: Record<string, HarnessInstance>): Record<string, PresetConfig> {
  const presets: Record<string, PresetConfig> = {};
  for (const [name, p] of Object.entries(c.presets ?? {})) {
    const where = `presets.${name}`;
    if (!INSTANCE_NAME.test(name)) fail(`${where}: preset names are letters, digits, '.', '_' and '-' (at most 64)`);
    if (name === DEFAULT_PRESET) fail(`${where}: "${DEFAULT_PRESET}" is reserved (\`/preset ${DEFAULT_PRESET}\` goes back to the agent's own)`);
    if (!harnesses[p.harness]) fail(`${where}.harness: unknown harness instance ${JSON.stringify(p.harness)} (configured: ${Object.keys(harnesses).join(', ')})`);
    presets[name] = {
      name,
      harness: p.harness,
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(p.effort !== undefined ? { effort: p.effort } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
    };
  }
  return presets;
}

function resolveAgents(
  c: ConfigFile,
  harnesses: Record<string, HarnessInstance>,
  presets: Record<string, PresetConfig>,
  defaultHarness: string,
  outputTools: boolean,
  path: (p: string) => string,
  configDirKeys: readonly string[],
  catalog: ToolCatalog,
): { agents: Record<string, AgentConfig>; defaultAgent: string | undefined } {
  if (!c.agents) {
    if (c.defaultAgent !== undefined && c.defaultAgent !== DEFAULT_AGENT) fail('`defaultAgent` needs `agents`');
    return { agents: { [DEFAULT_AGENT]: { name: DEFAULT_AGENT, harness: defaultHarness, mode: 'interactive', tools: outputTools, configured: false } }, defaultAgent: DEFAULT_AGENT };
  }
  const agents: Record<string, AgentConfig> = {};
  for (const [name, a] of Object.entries(c.agents)) {
    const where = `agents.${name}`;
    if (!INSTANCE_NAME.test(name)) fail(`${where}: agent names are letters, digits, '.', '_' and '-' (at most 64)`);
    if ((a.harness === undefined) === (a.preset === undefined)) fail(`${where}: give either \`harness\` or \`preset\``);
    let preset: PresetConfig | undefined;
    if (a.preset !== undefined) {
      preset = presets[a.preset];
      if (!preset) fail(`${where}.preset: unknown preset ${JSON.stringify(a.preset)} (${Object.keys(presets).length ? `configured: ${Object.keys(presets).join(', ')}` : 'no `presets` configured'})`);
    } else if (!harnesses[a.harness!]) fail(`${where}.harness: unknown harness instance ${JSON.stringify(a.harness)} (configured: ${Object.keys(harnesses).join(', ')})`);
    const model = a.model ?? preset?.model;
    const effort = a.effort ?? preset?.effort;
    let instructions: string | undefined;
    if (a.instructionsFile !== undefined) {
      const file = path(a.instructionsFile);
      try {
        instructions = readFileSync(file, 'utf8');
      } catch (e) {
        fail(`${where}.instructionsFile: cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      }
    }
    const sessionParams = a.sessionParams && resolveSessionParams(a.sessionParams, `${where}.sessionParams`, a.mode ?? 'interactive', path, configDirKeys);
    let toolNames: string[] | undefined;
    if (Array.isArray(a.tools)) {
      const unknown = a.tools.filter((t) => !catalog.names.includes(t) && !catalog.off.has(t));
      if (unknown.length) fail(`${where}.tools: unknown tool ${unknown.map((t) => JSON.stringify(t)).join(', ')} (tools: ${catalog.names.join(', ')})`);
      const off = a.tools.find((t) => catalog.off.has(t));
      if (off !== undefined) fail(`${where}.tools: ${JSON.stringify(off)} is a tool of module ${catalog.off.get(off)}, which is off`);
      toolNames = [...new Set(a.tools)];
    }
    agents[name] = {
      name,
      harness: preset?.harness ?? a.harness!,
      ...(preset ? { preset: preset.name } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(a.profile !== undefined ? { profile: a.profile } : {}),
      ...(a.cwd !== undefined ? { cwd: path(a.cwd) } : {}),
      mode: a.mode ?? 'interactive',
      tools: toolNames ? toolNames.length > 0 : (a.tools as boolean | undefined) ?? outputTools,
      ...(toolNames?.length ? { toolNames } : {}),
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

function resolveSessionParams(p: NonNullable<AgentEntry['sessionParams']>, where: string, mode: 'interactive' | 'task', path: (p: string) => string, configDirKeys: readonly string[]): SessionParams {
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
  // Each harness kind's config-dir variables (`HarnessModule.defaults.configDirEnv`).
  for (const k of configDirKeys) {
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

type Section = { run?: { model?: string; effort?: string }; profiles?: Record<string, Record<string, unknown>>; options?: Record<string, unknown> };

/**
 * The name and kind of the one instance of a config resolved with no harness kind registered that
 * configures no harness (a kernel with no modules, `coreRegistries`): it stands for the adapter the
 * embedder passes the gateway (`GatewayOptions.harness` or `buildHarness`), which builds nothing
 * for it. Its run has no model (the embedder's adapter decides); it has no launch, env or profiles.
 */
export const EMBEDDED_HARNESS = 'embedded';

function resolveHarnesses(c: ConfigFile, ctx: ResolveContext, path: (p: string) => string, registry: HarnessRegistry): { harnesses: Record<string, HarnessInstance>; defaultHarness: string } {
  const env = ctx.env;
  if (c.harness && c.harnesses) fail('use either `harnesses` (named instances) or the older `harness` block, not both');
  const out: Record<string, HarnessInstance> = {};
  let def: string;
  if (c.harnesses) {
    const names = Object.keys(c.harnesses);
    if (!names.length) fail('`harnesses` is empty');
    for (const name of names) out[name] = resolveInstance(name, c.harnesses[name], env, path, registry);
    def = c.defaultHarness ?? names[0]!;
    if (!out[def]) fail(`defaultHarness ${JSON.stringify(def)} is not one of the harnesses (${names.join(', ')})`);
  } else {
    if (c.defaultHarness) fail('`defaultHarness` needs `harnesses`');
    // Older form: one instance per present section, named after its kind, with the
    // harness-ish `.env.live` keys (the kinds' `legacy.envPrefixes`, proxies) passed through as before.
    const block = (c.harness ?? {}) as Record<string, unknown> & { use?: string };
    const prefixes = registry.modules.flatMap((m) => m.legacy?.envPrefixes ?? []);
    const legacyEnv = Object.fromEntries(Object.entries(ctx.fileEnv ?? {}).filter(([k]) => PROXY_ENV.test(k) || prefixes.some((x) => k.startsWith(x))));
    // With no kind registered (the file schema then admits no `use` and no section), the embedder's adapter.
    def = block.use ?? registry.defaultKind ?? EMBEDDED_HARNESS;
    if (registry.defaultKind === undefined) out[def] = { ...base(def, undefined, {}), env: {}, kind: def, launch: undefined };
    for (const m of registry.modules) {
      const sec = block[m.kind] as (Section & Record<string, unknown>) | undefined;
      if (!sec && def !== m.kind) continue;
      out[m.kind] = m.legacy
        ? { ...base(m.kind, m, sec ?? {}), env: legacyEnv, kind: m.kind, launch: m.legacy.resolve(sec ?? {}, { name: m.kind, where: `harness.${m.kind}`, path, fail }) }
        : { ...resolveInstance(m.kind, { use: m.kind }, env, path, registry), env: legacyEnv };
    }
  }

  // --harness: an instance name, or a kind (its first instance, else one with defaults).
  const pick = ctx.harness;
  if (pick !== undefined && !out[pick]) {
    const kind = registry.get(pick) ? pick : undefined;
    if (!kind) fail(`unknown harness instance ${JSON.stringify(pick)} (configured: ${Object.keys(out).join(', ')})`);
    const first = Object.values(out).find((i) => i.kind === kind);
    if (first) def = first.name;
    else {
      out[kind] = resolveInstance(kind, { use: kind }, env, path, registry);
      def = kind;
    }
  } else if (pick !== undefined) def = pick;

  // Env model override applies to the default instance only (other instances may target other providers).
  const d = out[def]!;
  const modelEnv = registry.get(d.kind)?.defaults?.modelEnv;
  const envModel = modelEnv !== undefined ? env[modelEnv] : undefined;
  if (envModel) d.run = { ...d.run, model: envModel };

  // Rules across one kind's instances (e.g. two codex instances never share a stateDir).
  for (const m of registry.modules) {
    const broken = m.checkAll?.(Object.values(out).filter((i) => i.kind === m.kind).map((i) => ({ name: i.name, launch: i.launch })));
    if (broken) fail(broken);
  }
  for (const i of Object.values(out)) launchAlias(i, i.kind === 'module' ? 'module' : registry.launchAlias(i.kind));
  return { harnesses: out, defaultHarness: def };
}

/**
 * Deprecated, for one release: `i[field]` reads and writes `i.launch` (hosts written before `launch`
 * read `claude` / `codex` / `module`, and set one before `buildHarness`). Not enumerable, so copies
 * and JSON show `launch` only.
 */
function launchAlias(i: HarnessInstance, field: string | undefined): void {
  if (!field) return;
  Object.defineProperty(i, field, {
    get(this: HarnessInstance) {
      return this.launch;
    },
    set(this: HarnessInstance, v: unknown) {
      this.launch = v;
    },
    enumerable: false,
    configurable: true,
  });
}

/** An instance's name, RunSpec defaults (the kind's default model), profiles and options. */
function base(name: string, kind: HarnessModule | undefined, sec: Section) {
  return {
    name,
    run: { harness: name, model: sec.run?.model ?? kind?.defaults?.model ?? '', ...(sec.run?.effort ? { effort: sec.run.effort } : {}) },
    profiles: sec.profiles ?? {},
    options: sec.options ?? {},
  };
}

function resolveInstance(name: string, raw: unknown, env: Record<string, string | undefined>, path: (p: string) => string, registry: HarnessRegistry): HarnessInstance {
  const where = `harnesses.${name}`;
  if (!INSTANCE_NAME.test(name)) fail(`${where}: instance names are letters, digits, '.', '_' and '-' (at most 64)`);
  const use = (raw as { use: string }).use;
  // `use` is a registered kind or `module` (the file schema says so).
  const kind = use === 'module' ? undefined : registry.get(use);
  const errs = errors(kind ? instanceSchema(kind) : ModuleInstance, raw);
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
  // The kind's module decides which of its settings those are (`HarnessModule.resolve`).
  const secrets: HarnessChildSecrets = {
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
    ...base(name, kind, raw as Section),
    env: envOut,
    ...((raw as { cwd?: string }).cwd ? { cwd: path((raw as { cwd: string }).cwd) } : {}),
  };
  if (!kind) {
    const x = raw as Static<typeof ModuleInstance>;
    const spec = x.module;
    const rel = spec.startsWith('.') || spec.startsWith('~') || isAbsolute(spec);
    const r = resolveModuleFile(spec, rel ? path(spec) : undefined, path('.'));
    if ('error' in r) fail(`${where}.module: ${r.error}`);
    const module: ModuleLaunch = { file: r.file, ...(x.export ? { export: x.export } : {}), ...(x.config !== undefined ? { config: sub(x.config, 'config') } : {}) };
    return { ...common, kind: 'module', launch: module, ...(unavailable ? { unavailable } : {}) };
  }
  const rctx: HarnessResolveContext = { name, where, env: envOut, path, secrets, fail };
  const r: { launch: unknown; unavailable?: string } = kind.resolve ? kind.resolve(raw as Record<string, unknown>, rctx) : { launch: raw };
  unavailable ??= r.unavailable;
  return { ...common, kind: kind.kind, launch: r.launch, ...(unavailable ? { unavailable } : {}) };
}

export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Every channel entry, resolved by its type's module (`ChannelModule.resolve`, in config order),
 * then each type's rules across its entries (`validateAll`, in registration order): e.g. the
 * lark-bot rules of decision 8, and one bridge program per channel id.
 */
function resolveChannels(entries: readonly ChannelEntry[], env: Record<string, string | undefined>, path: (p: string) => string, warnings: string[], registry: ChannelRegistry): ResolvedChannel[] {
  const substitute = (v: unknown, where: string) => substituteEnv(v, env, where);
  const out = entries.map((ch, index): ResolvedChannel => {
    // The file schema admits only registered types.
    const m = registry.get(ch.type)!;
    const ctx: ChannelResolveContext = { index, where: `channels[${index}]`, env, substitute, path, fail };
    return { ...ch, ...m.resolve(ch, ctx), account: ch.account ?? 'default' } as ResolvedChannel;
  });
  const vctx: ChannelValidateContext = { reservedIds: registry.reservedIds, fail, warn: (msg) => void warnings.push(msg) };
  for (const m of registry.modules) {
    if (!m.validateAll) continue;
    m.validateAll(entries.flatMap((entry, index) => (entry.type === m.type ? [{ index, entry, resolved: out[index]! }] : [])), vctx);
  }
  return out;
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
