import type {
  AdminModule,
  AdminSession,
  AdminStatus,
  ChannelAdapter,
  ClientCommand,
  ExternalCalloutAnswer,
  ExternalCalloutArgs,
  ExternalSender,
  IdentifyArgs,
  Identity,
  IdentityEntry,
  InboundEnvelope,
  InboundItem,
  InputRecord,
  KernelContext,
  KernelDatabase,
  KernelHold,
  KernelInputResult,
  KernelLaneHarness,
  KernelOutcome,
  KernelPreset,
  KernelRunOverrides,
  KernelScheduleResult,
  KernelSendResult,
  KernelSessionRun,
  KernelSettledSend,
  KernelUnscheduleResult,
  KernelUnwatchResult,
  KernelWatchResult,
  ModuleActionResult,
  ModuleInstance,
  ModuleManifest,
  ModuleOrigin,
  ModuleToolDef,
  ModuleTopicHandover,
  ModuleTurnStatus,
  Origin,
  Policy,
  RenderedMessage,
  ReplyRoute,
  Resolver,
  RouteExplanation,
  ScheduleDraft,
  ScheduleView,
  SessionEvent,
  SessionScope,
  Topic,
  TurnContext,
  Watch,
  WatchDraft,
} from '@agents-io/protocol';
import { AdminStatus as AdminStatusSchema, IdentityEntry as IdentityEntrySchema, Resolver as ResolverSchema } from '@agents-io/protocol';
import { Value } from '@sinclair/typebox/value';
import { KERNEL_TOOL_NAMES, moduleToolInput, type ModuleTools } from '@agents-io/host-mcp';
import { FinalFiringError, OWNER_LABEL } from '@agents-io/session';
import { CommandTable, KERNEL_COMMAND_NAMES, type ModuleCommand } from './commands.js';
import { ConfigError } from './config-error.js';
import { FEATURES } from './host.js';
import { TokenError } from './token.js';

/*
 * Feature modules (core-slimming G6): the registry the composition root fills (`bundle.ts`), and
 * the five steps of their lifecycle in the daemon:
 *   1. resolve — `loadConfig` / `resolveConfig` read each module's config section (`config.ts`
 *      `resolveModules`): on or off, and its settings;
 *   2. setup — `Gateway.start`, before the gateway builds its ingress: every module that is on
 *      builds its instance (`ModuleHost.setup`); the gateway then assembles its tool catalog,
 *      command table and features from the kernel's own entries and these;
 *   3. start — after the channels, the local socket and the console run (`ModuleHost.start`);
 *   4. stop — first thing when the daemon stops, in reverse order (`ModuleHost.stop`);
 *   5. a config change to a module's section takes effect at the next start (the console answers
 *      `applied: "restart"`; nothing is applied live).
 * A module that is off does not exist for the deployment: no tools, no commands, no features.
 * The hooks the daemon serves are called from when the gateway is built: `onTurnCompleted` until
 * step 4; `inputHint`, `resolver` (pure answers for an input being routed, a request being
 * opened), `statusLines` (a `/status` being answered), `onUndispatched` and `onAction` (inputs,
 * which come in until late in the daemon's stop) to the end; `identities` once, right after the
 * gateway is built and before its channels run.
 */

/** A module as registered: its manifest and where it comes from. */
export interface RegisteredModule {
  manifest: ModuleManifest<any>;
  origin: ModuleOrigin;
  /**
   * Imported from a config file's `modules` entry (`loadConfigModules`, origin `module`): the
   * module file and export the entry names. Such a module is part of a config only while its file
   * has an entry naming them, and its settings are that entry's `config` (its `config.section` and
   * `aliases` are claimed, never read in the file).
   */
  entry?: ModuleEntryRef;
}

/** A config file's `modules` entry as resolved: the module file (absolute) and the export. */
export interface ModuleEntryRef {
  module: string;
  export?: string;
}

/** One key for a file and an export (`ModuleEntryRef`). */
const entryKey = (e: ModuleEntryRef) => JSON.stringify([e.module, e.export ?? null]);

/**
 * Where a module's settings and status were before it was a module (`ModuleRegistryOptions.fields`;
 * `bundle.ts`: the external MCP endpoint's `externalMcp`).
 */
export interface ModuleFields {
  /**
   * A field of the resolved `Config` that also holds what the module's section resolved to (the
   * same object), while the module is on. Deprecated, kept for one release: given another value or
   * removed before `Gateway.start`, it decides over `Config.modules`, as it did before.
   */
  config?: string;
  /**
   * An optional field of `GET /api/status` (one `AdminStatus` declares, not `modules`) that holds
   * what its `status()` returns while it runs, besides its `modules` entry.
   */
  status?: string;
  /**
   * A field of the resolved `Config`, at a dotted path, that said whether the feature was on before
   * it was a module (deprecated, kept for one release; `bundle.ts`: the stranger approval's
   * `policy.strangers`, `ask` / `drop`): `resolveConfig` writes `on` there while the module is on
   * and `off` while it is off. Given the other value (or any other) before `Gateway.start`, or set in
   * a config without `modules` at all, it decides over `Config.modules`, as it did before: the
   * module is then what a file with that value at `path` and nothing else makes it. `path` is one
   * of the module's `config.aliases`, its `aliasEnabled` says on for `on` and off for `off`, and
   * the module needs no other module (it is resolved alone).
   */
  switch?: ModuleSwitchField;
  /**
   * The start of `createdBy` of the schedules the module's peers set before a schedule recorded the
   * module it was set through (`ScheduleView.module`; before 2026-11-24): such a schedule is the
   * module's peer's, and fires only through the module, as for one that records it (SC-3).
   * `bundle.ts`: the external MCP endpoint's clients, `external:`. No two modules' overlap.
   */
  schedules?: string;
}

/** `ModuleFields.switch`: where the old on/off field is and its two values. */
export interface ModuleSwitchField {
  path: string;
  on: string;
  off: string;
}

/** What `ModuleRegistry` takes besides the modules. */
export interface ModuleRegistryOptions {
  /** The origin of the modules given as bare manifests (default `module`; `bundle.ts` registers the built-in ones as `builtin`). */
  origin?: ModuleOrigin;
  /** Fields that keep a module's settings and status where they were before it was a module, by module id. */
  fields?: Readonly<Record<string, ModuleFields>>;
}

/** What `kernel:<capability>` may name in `ModuleManifest.needs`: the members of `KernelContext`. */
export const KERNEL_CAPABILITIES: readonly string[] = [
  'log', 'events', 'head', 'appendNative', 'sessions', 'status', 'stopping', 'policy', 'records', 'db', 'topics', 'watches', 'live', 'agents',
  'router', 'lanes', 'runConfig', 'channelFor', 'resolveRoute', 'send', 'settled', 'outbound', 'hold', 'owner', 'ownerRoute', 'redispatch', 'explain', 'host',
  'schedules',
];

const MODULE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SECTION = /^[A-Za-z][A-Za-z0-9_]*$/;
const ALIAS = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFn = (v: unknown) => typeof v === 'function';
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean';
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** What is wrong with a manifest on its own (the first thing), or undefined. */
function badManifest(m: ModuleManifest<any>): string | undefined {
  if (m.kind !== 'feature') return `kind must be "feature" (got ${JSON.stringify(m.kind)})`;
  if (!isFn(m.setup)) return 'setup must be a function';
  if (m.needs !== undefined) {
    if (!Array.isArray(m.needs)) return 'needs must be an array';
    for (const n of m.needs) {
      if (typeof n === 'string' && n.startsWith('module:') && MODULE_ID.test(n.slice('module:'.length))) continue;
      if (typeof n === 'string' && n.startsWith('kernel:') && KERNEL_CAPABILITIES.includes(n.slice('kernel:'.length))) continue;
      return `needs: ${JSON.stringify(n)} is neither module:<id> nor kernel:<capability> (${KERNEL_CAPABILITIES.join(', ')})`;
    }
  }
  const c = m.config;
  if (c !== undefined) {
    if (!isObject(c)) return 'config must be an object';
    if (typeof c.section !== 'string' || !SECTION.test(c.section)) return `config.section ${JSON.stringify(c.section)} is not a config key (ASCII letters, digits and _, starting with a letter)`;
    if (!isObject(c.schema) || Object.values(c.schema).some((s) => !isObject(s))) return 'config.schema must map each key of the section to a JSON Schema';
    if (Object.hasOwn(c.schema, 'enabled')) return 'config.schema: every section has "enabled"; its module cannot declare it';
    if (c.aliases !== undefined && (!Array.isArray(c.aliases) || c.aliases.some((a) => typeof a !== 'string' || !ALIAS.test(a)))) return 'config.aliases must be dotted paths of the config file (policy.strangers)';
    if (c.aliasEnabled !== undefined) {
      if (!isFn(c.aliasEnabled)) return 'config.aliasEnabled must be a function';
      if (!c.aliases?.length) return 'config.aliasEnabled is for a module with aliases';
    }
    if (typeof c.defaultEnabled !== 'boolean') return 'config.defaultEnabled must be a boolean';
    if (!isFn(c.resolve)) return 'config.resolve must be a function';
  }
  if (m.features !== undefined) {
    if (!Array.isArray(m.features) || m.features.some((f) => !nonEmpty(f))) return 'features must be non-empty strings';
    const own = m.features.find((f) => FEATURES.includes(f));
    if (own !== undefined) return `feature ${JSON.stringify(own)} is the kernel's`;
  }
  if (m.mcpTools !== undefined) {
    if (!Array.isArray(m.mcpTools)) return 'mcpTools must be an array';
    for (const t of m.mcpTools) {
      if (!isObject(t) || typeof t.name !== 'string' || !TOOL_NAME.test(t.name)) return `mcpTools: ${JSON.stringify(isObject(t) ? t.name : t)} is not a tool name (lower-case ASCII letters, digits and _, starting with a letter)`;
      if ((KERNEL_TOOL_NAMES as readonly string[]).includes(t.name)) return `mcpTools: ${t.name} is a kernel tool`;
      if (!nonEmpty(t.description)) return `mcpTools: ${t.name} needs a description`;
      if (!optBool(t.readOnly) || !optBool(t.needsTurn)) return `mcpTools: ${t.name}: readOnly and needsTurn are booleans`;
      try {
        moduleToolInput(t as unknown as ModuleToolDef);
      } catch (e) {
        return `mcpTools: ${(e as Error).message}`;
      }
    }
  }
  if (m.commands !== undefined) {
    if (!Array.isArray(m.commands)) return 'commands must be an array';
    for (const x of m.commands) {
      if (!isObject(x) || typeof x.name !== 'string' || !COMMAND_NAME.test(x.name)) return `commands: ${JSON.stringify(isObject(x) ? x.name : x)} is not a command name (lower-case ASCII letters, digits, _ and -, starting with a letter)`;
      if (x.aliases !== undefined && !Array.isArray(x.aliases)) return `commands: /${x.name}: aliases must be an array of command names`;
      for (const n of [x.name, ...((x.aliases ?? []) as unknown[])]) {
        if (typeof n !== 'string' || !COMMAND_NAME.test(n)) return `commands: /${x.name}: alias ${JSON.stringify(n)} is not a command name (lower-case ASCII letters, digits, _ and -, starting with a letter)`;
        if (KERNEL_COMMAND_NAMES.includes(n)) return `commands: /${n} is a kernel command`;
      }
      if (!nonEmpty(x.help)) return `commands: /${x.name} needs a help line`;
      if (x.helpBefore !== undefined && (typeof x.helpBefore !== 'string' || !KERNEL_COMMAND_NAMES.includes(x.helpBefore)))
        return `commands: /${x.name}: helpBefore ${JSON.stringify(x.helpBefore)} is not a kernel command (${KERNEL_COMMAND_NAMES.join(', ')})`;
      if (!optBool(x.ownerOnly)) return `commands: /${x.name}: ownerOnly is a boolean`;
    }
  }
  if (m.admin !== undefined) return 'admin (an AdminContribution) is not served for feature modules yet';
  return undefined;
}

/** What is wrong with a module's switch field (`ModuleFields.switch`), or undefined. */
function badSwitch(m: ModuleManifest<any>, sw: unknown): string | undefined {
  if (!isObject(sw) || typeof sw.path !== 'string' || !ALIAS.test(sw.path)) return 'must be { path: a dotted path of the config, on, off }';
  if (!nonEmpty(sw.on) || !nonEmpty(sw.off) || sw.on === sw.off) return 'on and off must be two different non-empty strings';
  if (!m.config?.aliases?.includes(sw.path)) return `${sw.path} is not one of the module's config.aliases`;
  const decide = m.config.aliasEnabled;
  if (!decide || decide(sw.on, sw.path) !== true || decide(sw.off, sw.path) !== false) return `the module's config.aliasEnabled must say on for ${JSON.stringify(sw.on)} and off for ${JSON.stringify(sw.off)}`;
  if (m.needs?.some((n) => n.startsWith('module:'))) return 'the module needs another module (a module with a switch is resolved alone)';
  return undefined;
}

/** The value at a dotted path of an object (a resolved `Config`), if set. */
function valueAtPath(o: unknown, dotted: string): unknown {
  let cur: unknown = o;
  for (const k of dotted.split('.')) {
    if (!isObject(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** `{ a: { b: value } }` for the dotted path `a.b`: a file with only that value set. */
function fileWith(dotted: string, value: unknown): Record<string, unknown> {
  return dotted.split('.').reduceRight<Record<string, unknown>>((inner, k) => ({ [k]: inner }), value as Record<string, unknown>) as Record<string, unknown>;
}

/**
 * The feature modules a deployment may run (`ModuleManifest`), in registration order: the order
 * their tools, commands, features and status entries come in, and the order they start (they
 * stop in reverse). `bundle.ts` builds the built-in one; an embedder may build its own (its
 * `modules` can start from `builtinModules.modules`) and give it to `resolveConfig` / `loadConfig`
 * and `Gateway.start` (`moduleRegistry`), the same to both. Registering checks every manifest and
 * what they claim together: ids, config sections and aliases, tools, commands and features are
 * each one module's, `module:<id>` needs name a registered module.
 */
export class ModuleRegistry {
  private readonly byId = new Map<string, RegisteredModule>();
  private readonly byEntry = new Map<string, RegisteredModule>();
  /** `ModuleRegistryOptions.fields`, checked. */
  readonly fields: ReadonlyMap<string, ModuleFields>;
  private readonly options: ModuleRegistryOptions;

  constructor(modules: readonly (ModuleManifest<any> | RegisteredModule)[], o: ModuleRegistryOptions = {}) {
    this.options = o;
    const claims = new Map<string, string>();
    const claim = (what: string, by: string) => {
      const had = claims.get(what);
      if (had !== undefined) throw new Error(`module ${by}: ${what} is also module ${had}'s`);
      claims.set(what, by);
    };
    for (const x of modules) {
      const r: RegisteredModule = isObject(x) && 'manifest' in x && 'origin' in x ? (x as RegisteredModule) : { manifest: x as ModuleManifest<any>, origin: o.origin ?? 'module' };
      const m = r.manifest;
      if (!isObject(m)) throw new Error('a module is not an object');
      if (typeof m.id !== 'string' || !MODULE_ID.test(m.id)) throw new Error(`module id ${JSON.stringify(m.id)} is not one (lower-case ASCII letters, digits, ., _ and -, starting with a letter or digit)`);
      if (this.byId.has(m.id)) throw new Error(`module ${JSON.stringify(m.id)} is registered twice`);
      if (r.origin !== 'builtin' && r.origin !== 'module') throw new Error(`module ${m.id}: origin must be "builtin" or "module"`);
      if (r.entry !== undefined) {
        if (r.origin !== 'module' || typeof r.entry.module !== 'string') throw new Error(`module ${m.id}: one loaded from a config file's modules entry is someone else's (origin module) and names its file`);
        const other = this.byEntry.get(entryKey(r.entry));
        if (other) throw new Error(`module ${m.id}: its file and export are module ${other.manifest.id}'s`);
      }
      const bad = badManifest(m);
      if (bad) throw new Error(`module ${m.id}: ${bad}`);
      if (m.config) {
        claim(`config key ${m.config.section}`, m.id);
        for (const a of m.config.aliases ?? []) claim(`config key ${a}`, m.id);
      }
      for (const f of m.features ?? []) claim(`feature ${f}`, m.id);
      for (const t of m.mcpTools ?? []) claim(`tool ${t.name}`, m.id);
      for (const c of m.commands ?? []) for (const n of [c.name, ...(c.aliases ?? [])]) claim(`command /${n}`, m.id);
      const reg: RegisteredModule = { manifest: m, origin: r.origin, ...(r.entry ? { entry: { module: r.entry.module, ...(r.entry.export !== undefined ? { export: r.entry.export } : {}) } } : {}) };
      this.byId.set(m.id, reg);
      if (reg.entry) this.byEntry.set(entryKey(reg.entry), reg);
    }
    for (const { manifest: m } of this.byId.values()) {
      for (const n of m.needs ?? []) {
        if (!n.startsWith('module:')) continue;
        const dep = n.slice('module:'.length);
        if (dep === m.id) throw new Error(`module ${m.id}: needs itself`);
        if (!this.byId.has(dep)) throw new Error(`module ${m.id}: needs module ${dep}, which is not registered`);
      }
    }
    const fields = new Map<string, ModuleFields>();
    for (const [id, f] of Object.entries(o.fields ?? {}) as [string, unknown][]) {
      if (!this.byId.has(id)) throw new Error(`fields: module ${id} is not registered`);
      if (!isObject(f)) throw new Error(`fields.${id} must be an object`);
      const out: ModuleFields = {};
      for (const k of ['config', 'status'] as const) {
        const name = f[k];
        if (name === undefined) continue;
        if (typeof name !== 'string' || !FIELD.test(name)) throw new Error(`fields.${id}.${k}: ${JSON.stringify(name)} is not a field name`);
        if (k === 'status' && (!Object.hasOwn(AdminStatusSchema.properties, name) || name === 'modules' || ((AdminStatusSchema.required ?? []) as readonly string[]).includes(name)))
          throw new Error(`fields.${id}.status: ${name} is not an optional field of the status (AdminStatus) other than modules`);
        claim(`${k} field ${name}`, id);
        out[k] = name;
      }
      if (f.switch !== undefined) {
        const bad = badSwitch(this.byId.get(id)!.manifest, f.switch);
        if (bad) throw new Error(`fields.${id}.switch: ${bad}`);
        const sw = f.switch as ModuleSwitchField;
        claim(`switch field ${sw.path}`, id);
        out.switch = { path: sw.path, on: sw.on, off: sw.off };
      }
      if (f.schedules !== undefined) {
        const prefix = f.schedules;
        if (typeof prefix !== 'string' || !prefix) throw new Error(`fields.${id}.schedules must be the start of a schedule's createdBy (a non-empty string)`);
        for (const [other, g] of fields)
          if (g.schedules !== undefined && (g.schedules.startsWith(prefix) || prefix.startsWith(g.schedules)))
            throw new Error(`fields.${id}.schedules: ${JSON.stringify(prefix)} overlaps module ${other}'s ${JSON.stringify(g.schedules)}`);
        out.schedules = prefix;
      }
      fields.set(id, out);
    }
    this.fields = fields;
  }

  get(id: string): RegisteredModule | undefined {
    return this.byId.get(id);
  }

  /** The module imported from a config file's `modules` entry naming this file and export, if one is registered. */
  fromEntry(e: ModuleEntryRef): RegisteredModule | undefined {
    return this.byEntry.get(entryKey(e));
  }

  /** A registry of this one's modules followed by `more`, with the same options (`fields`); checked as a new one is. */
  with(more: readonly RegisteredModule[]): ModuleRegistry {
    return new ModuleRegistry([...this.modules, ...more], this.options);
  }

  /** In registration order. */
  get modules(): RegisteredModule[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }

  /** The module whose tool `name` is, if a registered one's. */
  toolOwner(name: string): string | undefined {
    for (const { manifest: m } of this.byId.values()) if (m.mcpTools?.some((t) => t.name === name)) return m.id;
    return undefined;
  }
}

/** A module as the config resolved it (`Config.modules`, in registration order). */
export interface ResolvedModule {
  id: string;
  /** On for this run: its section (unless `enabled: false`), else the first alias set (unless its value is off), else its `defaultEnabled`. */
  enabled: boolean;
  /** What its `config.resolve` returned (a module that is on, with a config section). */
  config?: unknown;
}

/** The daemon's log function (`LogFn`). */
type Log = (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => void;

/** What `ModuleHost` takes. */
export interface ModuleHostOptions {
  registry: ModuleRegistry;
  /** As the config resolved them (`Config.modules`), against the same registry. */
  resolved: readonly ResolvedModule[] | undefined;
  /**
   * The resolved config itself (`Config`), for a module's deprecated field (`ModuleFields.config`):
   * one given another value, or removed, since the config was resolved decides over `resolved`, as
   * it did before the setting was a module's (`config.externalMcp = …` before `Gateway.start`); so
   * does one of a config without `modules` at all.
   */
  config?: object;
  /**
   * For a config without `modules` at all (`resolved` undefined: built by hand, as before modules):
   * what the modules resolve to from a file without their sections (`resolveModules({}, …)`). A
   * built-in module without a field takes its entry here: a feature that was the kernel's before
   * it was a module (topic titles) runs as it did. A module of someone else's still fails the start.
   */
  defaults?: readonly ResolvedModule[];
  /**
   * For a module with a switch field (`ModuleFields.switch`) that decides (its value in `config`
   * is not what `resolved` says, or the config has no `modules`): what the module resolves to from
   * `file`, a file with only that value set at the field's path (the gateway: `resolveModules` of
   * the module alone). Without it, switch fields are not read.
   */
  switched?(id: string, file: Record<string, unknown>): ResolvedModule;
  log: Log;
}

/** One module in the daemon: as registered and resolved, its instance once set up, whether it runs. */
interface Running {
  r: RegisteredModule;
  enabled: boolean;
  config: unknown;
  instance?: ModuleInstance;
  started: boolean;
}

/** Hook members the daemon serves (functions, but `onAction`: `{ prefix, handle }`): any other a module sets fails its setup. */
const SERVED_HOOKS: readonly string[] = ['onTurnCompleted', 'inputHint', 'onUndispatched', 'onAction', 'resolver', 'identities', 'statusLines', 'scheduledMessage', 'scheduledWake'];

/** What is wrong with what `setup` returned (the first thing), or undefined. */
function badInstance(m: ModuleManifest<any>, i: ModuleInstance): string | undefined {
  if (!isObject(i)) return 'setup did not return an object (a ModuleInstance)';
  const tools = new Set((m.mcpTools ?? []).map((t) => t.name));
  if (i.tools !== undefined && !isObject(i.tools)) return 'tools must map tool names to handlers';
  for (const t of tools) if (!isFn(i.tools?.[t])) return `tools.${t}: no handler for its tool ${t}`;
  for (const k of Object.keys(i.tools ?? {})) if (!tools.has(k)) return `tools.${k}: not one of its mcpTools`;
  const commands = new Set((m.commands ?? []).map((c) => c.name));
  if (i.commands !== undefined && !isObject(i.commands)) return 'commands must map command names to handlers';
  for (const c of commands) if (!isFn(i.commands?.[c])) return `commands.${c}: no handler for its command /${c}`;
  for (const k of Object.keys(i.commands ?? {})) if (!commands.has(k)) return `commands.${k}: not one of its commands`;
  if (i.hooks !== undefined) {
    if (!isObject(i.hooks)) return 'hooks must be an object';
    for (const [k, v] of Object.entries(i.hooks)) {
      if (v === undefined) continue;
      if (!SERVED_HOOKS.includes(k)) return `hooks.${k} is not served yet`;
      if (k === 'onAction') {
        if (!isObject(v) || !nonEmpty(v.prefix) || !isFn(v.handle)) return 'hooks.onAction must be { prefix: a non-empty string, handle: a function }';
        continue;
      }
      if (!isFn(v)) return `hooks.${k} must be a function`;
    }
  }
  if (i.localFrames !== undefined && (!isObject(i.localFrames) || Object.keys(i.localFrames).length)) return 'localFrames are not served yet';
  for (const k of ['offeredTools', 'features', 'status', 'start', 'stop'] as const) if (i[k] !== undefined && !isFn(i[k])) return `${k} must be a function`;
  return undefined;
}

/** Wait for `p`, at most `ms` (the timer holds the event loop and is cleared when `p` wins). */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise((r) => (t = setTimeout(r, ms)))]);
  clearTimeout(t);
}

/** How long one module's `stop` may take before the daemon goes on stopping. */
export const MODULE_STOP_MS = 2000;

/**
 * The daemon's modules for one run: steps 2-4 of the lifecycle, and what the gateway assembles
 * from them (tools, commands, features, status). The config must have been resolved with the
 * same registry (`Config.modules` names exactly its modules).
 */
export class ModuleHost {
  private readonly all: Running[];
  private setUp = false;
  /** Step 4 began: no more hooks. */
  private stopping = false;

  constructor(private readonly o: ModuleHostOptions) {
    const byId = new Map((o.resolved ?? []).map((r) => [r.id, r]));
    for (const id of byId.keys()) if (!o.registry.get(id)) throw new ConfigError(`the config was resolved with module ${id}, which this daemon does not register: give loadConfig and Gateway.start the same moduleRegistry`);
    const defaults = new Map((o.defaults ?? []).map((r) => [r.id, r]));
    this.all = o.registry.modules.map((r) => {
      const field = o.registry.fields.get(r.manifest.id)?.config;
      // A config without `modules` at all (one built by hand, as before modules): such a module is what its field
      // says; a built-in one without a field is as a file without its section makes it.
      const bare = o.resolved === undefined;
      const res =
        byId.get(r.manifest.id) ??
        (bare && field !== undefined && o.config !== undefined ? { id: r.manifest.id, enabled: false } : bare && field === undefined && r.origin === 'builtin' ? defaults.get(r.manifest.id) : undefined);
      if (!res) throw new ConfigError(`module ${r.manifest.id} is registered but the config was resolved without it: give loadConfig and Gateway.start the same moduleRegistry`);
      if (field !== undefined && o.config !== undefined) {
        // `resolveConfig` puts the module's settings there (the same object) while it is on; anything else was written since.
        const legacy = (o.config as Record<string, unknown>)[field];
        if (legacy !== (res.enabled ? res.config : undefined)) return { r, enabled: legacy !== undefined, config: legacy, started: false };
      }
      const sw = o.registry.fields.get(r.manifest.id)?.switch;
      if (sw !== undefined && o.config !== undefined && o.switched) {
        // `resolveConfig` writes `on` there while the module is on, `off` while it is off; anything else was written since.
        const legacy = valueAtPath(o.config, sw.path);
        if (bare || legacy !== (res.enabled ? sw.on : sw.off)) {
          const now = o.switched(r.manifest.id, fileWith(sw.path, legacy));
          return { r, enabled: now.enabled, config: now.config, started: false };
        }
      }
      return { r, enabled: res.enabled, config: res.config, started: false };
    });
  }

  /**
   * Step 2: set up every module that is on, in registration order (`kernel` builds each one's
   * context). What one returns is checked against its manifest; a `setup` that throws or returns
   * something wrong fails the start (a config error naming the module).
   */
  async setup(kernel: (id: string) => KernelContext): Promise<void> {
    if (this.setUp) throw new Error('modules are set up once');
    this.setUp = true;
    for (const m of this.all) {
      if (!m.enabled) continue;
      const id = m.r.manifest.id;
      let instance: ModuleInstance;
      try {
        instance = await m.r.manifest.setup(kernel(id), m.config);
      } catch (e) {
        throw new ConfigError(`module ${id}: setup failed: ${(e as Error).message}`);
      }
      const bad = badInstance(m.r.manifest, instance);
      if (bad) throw new ConfigError(`module ${id}: ${bad}`);
      // One module's clicks: a prefix that starts another's (or is its start) would take them.
      const prefix = instance.hooks?.onAction?.prefix;
      if (prefix !== undefined) {
        for (const other of this.active()) {
          const theirs = other.instance!.hooks?.onAction?.prefix;
          if (theirs !== undefined && (theirs.startsWith(prefix) || prefix.startsWith(theirs)))
            throw new ConfigError(`module ${id}: hooks.onAction: its prefix ${JSON.stringify(prefix)} overlaps module ${other.r.manifest.id}'s ${JSON.stringify(theirs)}`);
        }
      }
      m.instance = instance;
    }
  }

  /** Whether a set-up module has the hook (the gateway hands its ingress `onUndispatched` / `onAction` only then). */
  hooked(name: 'onUndispatched' | 'onAction'): boolean {
    return this.active().some((m) => m.instance!.hooks?.[name] !== undefined);
  }

  /**
   * The set-up modules' identity entries when the daemon starts (`ModuleHooks.identities`), each
   * module's given to `set` (its own extra entries). A hook that throws or answers anything but an
   * array of identity entries fails the start, naming the module.
   */
  identities(set: (id: string, entries: IdentityEntry[]) => void): void {
    for (const m of this.active()) {
      const hook = m.instance!.hooks?.identities;
      if (!hook) continue;
      const id = m.r.manifest.id;
      let entries: unknown;
      try {
        entries = hook();
      } catch (e) {
        throw new Error(`module ${id}: identities failed: ${(e as Error)?.message ?? String(e)}`);
      }
      if (!Array.isArray(entries) || !entries.every((x) => Value.Check(IdentityEntrySchema, x))) throw new Error(`module ${id}: identities must return an array of identity entries`);
      set(id, entries as IdentityEntry[]);
    }
  }

  /**
   * An input no rule dispatched and no host took (`ModuleHooks.onUndispatched`): each set-up
   * module's hook in registration order, each awaited; one that throws or rejects is logged, the
   * next still hears it.
   */
  async undispatched(a: { env: InboundEnvelope; origin: Origin; input: InputRecord; addressed: boolean }): Promise<void> {
    for (const m of this.active()) {
      const hook = m.instance!.hooks?.onUndispatched;
      if (!hook) continue;
      try {
        await hook({ env: a.env, origin: a.origin, input: a.input, addressed: a.addressed });
      } catch (e) {
        this.o.log('warn', `module ${m.r.manifest.id}: onUndispatched failed: ${(e as Error)?.message ?? String(e)}`);
      }
    }
  }

  /**
   * A click (`ModuleHooks.onAction`): the module whose prefix the action id starts with answers
   * (prefixes never overlap); undefined when none does, or it leaves the click to be routed. Only
   * what a result may say comes back (`{ ok: true }`, or `{ ok: false, reason }` with `refused` for
   * a reason that is not a string). A throw is the click's.
   */
  async action(a: { actionId: string; env: InboundEnvelope; origin: Origin }): Promise<ModuleActionResult | undefined> {
    for (const m of this.active()) {
      const hook = m.instance!.hooks?.onAction;
      if (!hook || !a.actionId.startsWith(hook.prefix)) continue;
      const r: unknown = await hook.handle({ actionId: a.actionId, env: a.env, origin: a.origin });
      if (r === undefined || r === null) return undefined;
      if (isObject(r) && r.ok === true) return { ok: true };
      return { ok: false, reason: isObject(r) && typeof r.reason === 'string' ? r.reason : 'refused' };
    }
    return undefined;
  }

  /**
   * Who answers a request of the turn (`ModuleHooks.resolver`): the first set-up module, in
   * registration order, that gives a resolver; undefined when none does. A hook that throws, or
   * answers something that is no resolver, throws (the policy's error: the lane denies the request).
   */
  resolver(ctx: TurnContext): Resolver | undefined {
    for (const m of this.active()) {
      const hook = m.instance!.hooks?.resolver;
      if (!hook) continue;
      const r: unknown = hook(ctx);
      if (r === undefined || r === null) continue;
      if (!Value.Check(ResolverSchema, r)) throw new Error(`module ${m.r.manifest.id}: resolver answered no Resolver`);
      return r as Resolver;
    }
    return undefined;
  }

  /**
   * The set-up modules' tools, for the host MCP endpoint (`HostToolsOptions.modules`); modules
   * without tools are left out. A module whose instance has `offeredTools` says at every request
   * which it offers then (a throw is logged and offers none of them).
   */
  tools(): ModuleTools[] {
    return this.active()
      .filter((m) => m.r.manifest.mcpTools?.length)
      .map((m) => {
        const id = m.r.manifest.id;
        const instance = m.instance!;
        const offered = (): string[] => {
          try {
            return [...instance.offeredTools!()];
          } catch (e) {
            this.o.log('warn', `module ${id}: offeredTools failed: ${(e as Error).message}`);
            return [];
          }
        };
        return { module: id, tools: m.r.manifest.mcpTools!, handlers: instance.tools ?? {}, ...(instance.offeredTools ? { offered } : {}) };
      });
  }

  /** The chat command table: the kernel's commands, then the set-up modules'. */
  commandTable(): CommandTable {
    const commands: ModuleCommand[] = [];
    for (const m of this.active()) for (const def of m.r.manifest.commands ?? []) commands.push({ module: m.r.manifest.id, def, handler: m.instance!.commands![def.name]! });
    return new CommandTable(commands);
  }

  /**
   * `host.hello` features of the modules that run (started, not stopped), in registration order:
   * the manifest's, or those of them its instance's `features()` says it advertises now.
   */
  features(): string[] {
    return this.all.filter((m) => m.started).flatMap((m) => {
      const all = [...(m.r.manifest.features ?? [])];
      if (!m.instance?.features) return all;
      let now: Set<string>;
      try {
        now = new Set(m.instance.features());
      } catch (e) {
        this.o.log('warn', `module ${m.r.manifest.id}: features failed: ${(e as Error).message}`);
        return [];
      }
      return all.filter((f) => now.has(f));
    });
  }

  /** `GET /api/status` `modules`: every registered module; `status` from a module that runs. */
  status(): AdminModule[] {
    return this.report().modules;
  }

  /**
   * `GET /api/status`: `modules` (as `status()`), and the fields the registry keeps a module's
   * status in where it was before it was a module (`ModuleFields.status`), for each that runs and
   * shows one. Each module's `status()` is asked once.
   */
  report(): { modules: AdminModule[]; fields: Record<string, unknown> } {
    const fields: Record<string, unknown> = {};
    const modules = this.all.map((m): AdminModule => {
      const id = m.r.manifest.id;
      let status: unknown;
      if (m.started && m.instance?.status) {
        try {
          status = m.instance.status();
        } catch (e) {
          this.o.log('warn', `module ${id}: status failed: ${(e as Error).message}`);
        }
      }
      const field = this.o.registry.fields.get(id)?.status;
      if (field !== undefined && status !== undefined) fields[field] = status;
      return { id, origin: m.r.origin, enabled: m.enabled, ...(status !== undefined ? { status } : {}) };
    });
    return { modules, fields };
  }

  /**
   * Step 3: start the set-up modules in registration order; one that throws fails the start (those
   * started before it are stopped by `stop`). Its error says which module, unless it is a
   * `ConfigError` or a `TokenError` (a setting or a token file it was given is wrong): that one
   * names the setting itself and is thrown as it is (`aio serve` exits 2 for both).
   */
  async start(): Promise<void> {
    for (const m of this.active()) {
      try {
        await m.instance!.start?.();
      } catch (e) {
        if (e instanceof ConfigError || e instanceof TokenError) throw e;
        throw new Error(`module ${m.r.manifest.id}: start failed: ${(e as Error).message}`);
      }
      m.started = true;
    }
  }

  /**
   * A turn of a session ended (`ModuleHooks.onTurnCompleted`): each set-up module's hook, in
   * registration order, until step 4 begins. One that throws or rejects is logged; the others still run.
   */
  turnCompleted(a: { sessionKey: string; turnId: string; status: ModuleTurnStatus }): void {
    if (this.stopping) return;
    for (const m of this.active()) {
      const hooks = m.instance!.hooks;
      if (!hooks?.onTurnCompleted) continue;
      const failed = (e: unknown) => this.o.log('warn', `module ${m.r.manifest.id}: onTurnCompleted failed: ${(e as Error)?.message ?? String(e)}`);
      try {
        const r: unknown = hooks.onTurnCompleted(a);
        if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, failed);
      } catch (e) {
        failed(e);
      }
    }
  }

  /**
   * The line inputs routed to a current topic carry for `agent` (`ModuleHooks.inputHint`): the
   * set-up modules' lines, in registration order, joined with a newline; undefined when none gives
   * one. Asked also while the daemon stops (inputs routed then still carry it). A hook that throws
   * is logged and gives no line.
   */
  inputHint(agent: string | undefined): string | undefined {
    const lines: string[] = [];
    for (const m of this.active()) {
      const hint = m.instance!.hooks?.inputHint;
      if (!hint) continue;
      try {
        const line: unknown = hint(agent);
        if (typeof line === 'string' && line) lines.push(line);
      } catch (e) {
        this.o.log('warn', `module ${m.r.manifest.id}: inputHint failed: ${(e as Error)?.message ?? String(e)}`);
      }
    }
    return lines.length ? lines.join('\n') : undefined;
  }

  /**
   * The lines `/status` shows for a session after the line of what it runs
   * (`ModuleHooks.statusLines`): the set-up modules' lines, in registration order. Asked also
   * while the daemon stops (commands are answered then). A hook that throws, or answers anything
   * but an array, is logged and gives no line; entries that are not strings are left out.
   */
  statusLines(sessionKey: string): string[] {
    const lines: string[] = [];
    for (const m of this.active()) {
      const hook = m.instance!.hooks?.statusLines;
      if (!hook) continue;
      try {
        const got: unknown = hook(sessionKey);
        if (!Array.isArray(got)) throw new Error('statusLines must return an array of lines');
        for (const line of got) if (typeof line === 'string') lines.push(line);
      } catch (e) {
        this.o.log('warn', `module ${m.r.manifest.id}: statusLines failed: ${(e as Error)?.message ?? String(e)}`);
      }
    }
    return lines;
  }

  /**
   * A `message` schedule that is no peer's (`peerModule`) fires (`ModuleHooks.scheduledMessage`): the
   * first set-up module, in registration order, whose hook answers true sent it (as its client);
   * false when none did (the kernel sends it). A hook's throw or rejection is the firing's failure, as
   * it is (`final: true` ends the firing; anything else is tried again later, SC-1). Served from when
   * the daemon runs; while the modules stop it throws (the gateway stops its schedules first, so only
   * a stray call gets here): a module's client's schedule never goes out as the daemon's message, and
   * the firing is redone at the next start.
   */
  async scheduledMessage(a: { schedule: ScheduleView; operationId: string }): Promise<boolean> {
    if (this.stopping) throw new Error('the daemon is stopping: the firing is redone at the next start');
    for (const m of this.active()) {
      const hook = m.instance!.hooks?.scheduledMessage;
      if (!hook) continue;
      const got: unknown = await hook({ schedule: { ...a.schedule }, operationId: a.operationId });
      if (got === true) return true;
    }
    return false;
  }

  /**
   * The module a peer's schedule fires through (SC-3): the one it was set through (`module`), or, for
   * one set before schedules recorded it, the module whose `ModuleFields.schedules` its `createdBy`
   * starts with (registered, on or off). Undefined for anyone else's (the owner's, a host's, an agent's).
   */
  peerModule(s: Pick<ScheduleView, 'module' | 'createdBy'>): string | undefined {
    if (s.module !== undefined) return s.module;
    for (const [id, f] of this.o.registry.fields) if (f.schedules !== undefined && s.createdBy.startsWith(f.schedules)) return id;
    return undefined;
  }

  /**
   * A peer's schedule fires, set through `module` (SC-3): only that module answers, as its peer. A
   * message: its `ModuleHooks.scheduledMessage` sends it; a wake (`action: "host"`): its
   * `ModuleHooks.scheduledWake` says it still acts for it, and the caller hands it to the host. The
   * module not registered, off, without the hook, or answering anything but true: the firing is over
   * (`FinalFiringError`, SC-1) and nothing goes out, never as the daemon's; the schedule is kept
   * (`keep`: a one-shot stays at its time for the next start, when the module may act for the peer
   * again, SC-2). A hook's throw or rejection is the firing's failure, as it is. While the modules
   * stop it throws (redone at the next start).
   */
  async peerSchedule(a: { schedule: ScheduleView; operationId: string }, module: string): Promise<void> {
    if (this.stopping) throw new Error('the daemon is stopping: the firing is redone at the next start');
    const by = a.schedule.createdBy;
    const wake = a.schedule.action === 'host';
    const not = (why: string) => new FinalFiringError(`set by ${by} through module ${module}, which ${why}; ${wake ? 'not handed to the host' : 'not sent'}`, { keep: true });
    const m = this.all.find((x) => x.r.manifest.id === module);
    if (!m) throw not('this daemon does not have');
    if (!m.instance) throw not('is off');
    const hook = wake ? m.instance.hooks?.scheduledWake : a.schedule.action === 'message' ? m.instance.hooks?.scheduledMessage : undefined;
    const got: unknown = hook ? await hook({ schedule: { ...a.schedule }, operationId: a.operationId }) : false;
    if (got !== true) throw not(`does not act for ${by} now`);
  }

  /** Step 4: stop the started modules in reverse order, each bounded (`MODULE_STOP_MS`); failures are logged. Their hooks are no longer called. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const m of [...this.all].reverse()) {
      if (!m.started) continue;
      m.started = false;
      const id = m.r.manifest.id;
      const stopping = Promise.resolve()
        .then(() => m.instance!.stop?.())
        .catch((e: Error) => this.o.log('warn', `module ${id}: stop failed: ${e.message}`));
      await within(stopping, MODULE_STOP_MS);
    }
  }

  private active(): Running[] {
    return this.all.filter((m) => m.instance !== undefined);
  }
}

/**
 * What the gateway gives every module's kernel context (`kernelContext` namespaces it per module):
 * existing capabilities of the gateway, late-bound (`ready` is false until setup returned).
 * Exported for an embedder that builds `KernelContext`s over a kernel of its own; it grows with
 * what the modules need (every member is required, so each G6 step that adds one is a breaking
 * change for such an embedder: packages/daemon/README.md lists them). `Gateway` implements it.
 */
export interface KernelBackend {
  ready(): boolean;
  log: Log;
  events(sessionKey: string, fromSeq: number): SessionEvent[];
  head(sessionKey: string): number;
  appendNative(logKey: string, e: Parameters<KernelContext['appendNative']>[1]): void;
  sessions(): AdminSession[];
  knownSession(sessionKey: string): boolean;
  agentOf(sessionKey: string): string | undefined;
  status(): AdminStatus;
  stopping(): boolean;
  policy(): Policy;
  flag(name: string): string | undefined;
  setFlag(name: string, value: string | undefined): void;
  db(): KernelDatabase;
  topic(sessionKey: string): Topic | undefined;
  siblings(sessionKey: string): Topic[];
  titleSource(topicId: string): 'auto' | 'explicit' | undefined;
  /** Set while still auto and `expected` (U20: once the scoped host allowed it), then the cards that show it refreshed (`KernelContext.topics.setAutoTitle`). */
  setAutoTitle(topicId: string, expected: string | undefined, title: string, turnId: string | undefined): Promise<boolean>;
  /** A watch as the session's agent, delivering into the session (`KernelContext.watches.add`). */
  addWatch(sessionKey: string, draft: WatchDraft): Promise<KernelWatchResult>;
  removeWatch(sessionKey: string, id: string): Promise<KernelUnwatchResult>;
  listWatches(sessionKey: string): Watch[];
  /** A schedule as the session's agent (`KernelContext.schedules.add`): a route only from its running turn `turnId`, where it may send. */
  addSchedule(sessionKey: string, draft: ScheduleDraft, turnId: string | undefined): Promise<KernelScheduleResult>;
  removeSchedule(sessionKey: string, id: string): Promise<KernelUnscheduleResult>;
  listSchedules(sessionKey: string): ScheduleView[];
  /** A schedule as a peer of `module` (`KernelContext.schedules.addAs`; the origin is checked before): it fires only through that module (SC-3). */
  addScheduleAs(origin: Origin, draft: ScheduleDraft, module: string): Promise<KernelScheduleResult>;
  removeScheduleAs(origin: Origin, id: string): Promise<KernelUnscheduleResult>;
  /** The schedules the origin set (`creatorOf`). */
  listSchedulesAs(origin: Origin): ScheduleView[];
  /** The kernel's handover of the running turn `turnId` under TP-1 (`KernelContext.topics.rotate` / `switch`). */
  rotateTopic(sessionKey: string, turnId: string, a: { title: string; summary: string; operationId: string }): Promise<ModuleTopicHandover>;
  switchTopic(sessionKey: string, turnId: string, a: { topicId: string; operationId: string }): Promise<ModuleTopicHandover>;
  /** The kernel's live mechanism (`KernelContext.live`). */
  joinLive(sessionKey: string, turnId: string, a: { target: string; channel?: string; instructions?: string; voice?: string }): Promise<{ liveId: string; title: string; route: string }>;
  sayLive(sessionKey: string, text: string, a: { operationId: string; turnId: string }): Promise<void>;
  leaveLive(sessionKey: string): Promise<boolean>;
  /** The running channels that can open a live (`KernelContext.live.channels`). */
  liveChannels(): string[];
  /** The sessions with a running live (`KernelContext.live.running`). */
  liveSessions(): string[];
  /** The tools an agent's sessions are offered (`KernelContext.agents.tools`). */
  agentTools(agent: string | undefined): string[];
  /** The agents a chat may talk to (`KernelContext.agents.names`). */
  agentNames(): string[];
  identify(a: IdentifyArgs): Identity;
  /** One owner's extra identity entries (a module's, by id), merged with the others'. */
  setExtraIdentities(owner: string, entries: IdentityEntry[]): void;
  newTopic(agent: string, conversation: string, title: string | undefined): string;
  conversationAgent(conversation: string): string | undefined;
  /** Throws for an agent a chat may not talk to. */
  setConversationAgent(conversation: string, agent: string): void;
  record(e: RouteExplanation & { at: number }): void;
  hasLane(sessionKey: string): boolean;
  openLane(sessionKey: string, agent: string | undefined): Promise<void>;
  command(cmd: ClientCommand, origin: Origin): Promise<KernelOutcome>;
  /** The lane's answer to the input (the lane opened when it is not). */
  laneInput(sessionKey: string, input: InputRecord, mode: 'queue' | 'steer' | 'interrupt'): Promise<KernelInputResult>;
  /** What a module (`module`: its id, which names the ephemeral turn's session, profile and input) may run beside the lane (`KernelContext.lanes.harness`). */
  laneHarness(sessionKey: string, module: string): KernelLaneHarness | undefined;
  /** What a session's next turn runs, and what is set for it (`KernelContext.runConfig`). */
  sessionRun(sessionKey: string): KernelSessionRun;
  /** Throws for a preset that is not configured. */
  setSessionRun(sessionKey: string, o: KernelRunOverrides): void;
  presets(): KernelPreset[];
  offering(cap: 'plan' | 'ownerProfileSwitch'): string[];
  channelFor(route: { channel: string; account: string }): ChannelAdapter | undefined;
  resolveRoute(route: ReplyRoute): { ok: true; route: ReplyRoute } | { ok: false; message: string };
  send(route: ReplyRoute, msg: RenderedMessage, a: { operationId: string; sessionKey: string; turnId?: string; external?: ExternalSender }): Promise<KernelSendResult | undefined>;
  settled(operationId: string): KernelSettledSend | undefined;
  outbound(from: TurnContext, to: ReplyRoute, content: RenderedMessage | undefined): Promise<'allow' | 'deny' | KernelHold>;
  /** Settle a send held at the outbound check (`KernelContext.hold`). */
  hold(route: ReplyRoute, a: { operationId: string; sessionKey: string; external?: ExternalSender; reason?: string }): KernelSendResult;
  /** The owner's principals and fixed session (`KernelContext.owner`). */
  owner(): { principals: string[]; sessionKey?: string };
  ownerRoute(): ReplyRoute | null;
  redispatch(item: InboundItem, o: { by: string; session?: SessionScope; agent?: string }): Promise<{ ok: true; sessionKey: string; inputId: string } | { ok: false; code: string; message: string }>;
  explain(inputId: string, chain: boolean): KernelOutcome;
  hostConnected(): boolean;
  hostAnswers(hook: string): boolean;
  hostHeldBy(hook: 'outbound' | 'external'): string | undefined;
  hostExternal(args: ExternalCalloutArgs): Promise<ExternalCalloutAnswer>;
  isHostToken(token: string): boolean;
}

const frozenPolicies = new WeakMap<Policy, Policy>();

/** The policy as a module sees it (`KernelContext.policy`): a frozen copy (its hooks, never a way to replace them). */
function frozenPolicy(p: Policy): Policy {
  let f = frozenPolicies.get(p);
  if (!f) frozenPolicies.set(p, (f = Object.freeze({ ...p })));
  return f;
}

/** One module's `KernelContext` over the gateway's backend: its log prefix, its records namespace, its own extra identities. */
export function kernelContext(id: string, k: KernelBackend): KernelContext {
  const live = (): KernelBackend => {
    if (!k.ready()) throw new Error(`module ${id}: the kernel is not ready during setup (only id and log are)`);
    return k;
  };
  const flag = (name: string) => `module:${id}:${name}`;
  const text = (v: unknown, what: string): string => {
    if (typeof v !== 'string') throw new Error(`module ${id}: ${what} must be a string`);
    return v;
  };
  return {
    id,
    log: (level, msg, data) => k.log(level, `module ${id}: ${msg}`, data),
    events: (sessionKey, fromSeq) => live().events(sessionKey, fromSeq ?? 0),
    head: (sessionKey) => live().head(sessionKey),
    appendNative: (logKey, e) => live().appendNative(logKey, e),
    sessions: {
      list: () => live().sessions(),
      known: (sessionKey) => live().knownSession(sessionKey),
      agentOf: (sessionKey) => live().agentOf(sessionKey),
    },
    status: () => live().status(),
    stopping: () => live().stopping(),
    // Asked, never set (a module cannot change what the lanes decide with): a frozen view, the same while the policy object is.
    get policy() {
      return frozenPolicy(live().policy());
    },
    records: {
      get: (name) => live().flag(flag(name)),
      set: (name, value) => live().setFlag(flag(name), value),
    },
    get db() {
      return live().db();
    },
    topics: {
      bySession: (sessionKey) => live().topic(sessionKey),
      siblings: (sessionKey) => live().siblings(sessionKey),
      titleSource: (topicId) => live().titleSource(topicId),
      setAutoTitle: async (topicId, expected, title, turnId) => live().setAutoTitle(topicId, expected, title, typeof turnId === 'string' ? turnId : undefined),
      // Only what the module may say (strings): its untyped code passes nothing else on.
      rotate: async (sessionKey, turnId, a) =>
        live().rotateTopic(sessionKey, turnId, { title: text(a?.title, 'topics.rotate: title'), summary: text(a?.summary, 'topics.rotate: summary'), operationId: text(a?.operationId, 'topics.rotate: operationId') }),
      switch: async (sessionKey, turnId, a) => live().switchTopic(sessionKey, turnId, { topicId: text(a?.topicId, 'topics.switch: topicId'), operationId: text(a?.operationId, 'topics.switch: operationId') }),
    },
    watches: {
      add: async (sessionKey, draft) => live().addWatch(sessionKey, draft),
      remove: async (sessionKey, wid) => live().removeWatch(sessionKey, wid),
      list: (sessionKey) => live().listWatches(sessionKey),
    },
    schedules: {
      add: async (sessionKey, draft, turnId) => live().addSchedule(sessionKey, draft, typeof turnId === 'string' ? turnId : undefined),
      remove: async (sessionKey, sid) => live().removeSchedule(sessionKey, sid),
      list: (sessionKey) => live().listSchedules(sessionKey),
      // As lanes.input: a module sets schedules for someone else only as a peer, never as a person, a host, the kernel or an owner.
      addAs: async (origin, draft) => {
        const refused = peerRefusal(origin, live().owner().principals);
        if (refused) throw new Error(`module ${id}: schedules.addAs takes a peer's origin (${refused})`);
        return live().addScheduleAs(origin, draft, id);
      },
      removeAs: async (origin, sid) => {
        const refused = peerRefusal(origin, live().owner().principals);
        if (refused) throw new Error(`module ${id}: schedules.removeAs takes a peer's origin (${refused})`);
        return live().removeScheduleAs(origin, sid);
      },
      listAs: (origin) => live().listSchedulesAs(origin),
    },
    live: {
      join: async (sessionKey, turnId, a) => {
        const opt = (k: 'channel' | 'instructions' | 'voice') => (typeof a?.[k] === 'string' ? { [k]: a[k] } : {});
        return live().joinLive(sessionKey, turnId, { target: text(a?.target, 'live.join: target'), ...opt('channel'), ...opt('instructions'), ...opt('voice') });
      },
      say: async (sessionKey, said, a) => live().sayLive(sessionKey, said, { operationId: text(a?.operationId, 'live.say: operationId'), turnId: text(a?.turnId, 'live.say: turnId') }),
      leave: async (sessionKey) => live().leaveLive(sessionKey),
      channels: () => [...live().liveChannels()],
      running: () => [...live().liveSessions()],
    },
    agents: {
      names: () => [...live().agentNames()],
      tools: (agent) => live().agentTools(agent),
    },
    router: {
      identify: async (a) => live().identify(a),
      setExtraIdentities: (entries) => live().setExtraIdentities(`module:${id}`, entries),
      newTopic: (agent, conversation, title) => live().newTopic(agent, conversation, title),
      conversationAgent: (conversation) => live().conversationAgent(conversation),
      setConversationAgent: (conversation, agent) => live().setConversationAgent(text(conversation, 'router.setConversationAgent: conversation'), text(agent, 'router.setConversationAgent: agent')),
      record: (e) => live().record(e),
    },
    lanes: {
      has: (sessionKey) => live().hasLane(sessionKey),
      open: (sessionKey, agent) => live().openLane(sessionKey, agent),
      command: async (cmd, origin) => {
        // As lanes.input: a module acts in a session only as a peer, never as a person, a host, the kernel or an owner.
        const refused = peerRefusal(origin, live().owner().principals);
        if (refused) throw new Error(`module ${id}: lanes.command takes a peer's origin (${refused})`);
        return live().command(cmd, origin);
      },
      input: async (sessionKey, input, mode) => {
        // A module stamps only peers (agents outside this daemon): a person's or the kernel's origin is the kernel's to give.
        if (input?.origin?.kind !== 'peer') throw new Error(`module ${id}: lanes.input takes a peer's input (origin.kind "peer", not ${JSON.stringify(input?.origin?.kind)})`);
        const refused = peerRefusal(input.origin, live().owner().principals);
        if (refused) throw new Error(`module ${id}: lanes.input takes a peer's input (${refused})`);
        // Only the kernel marks a harness's native command (CT-2), and the loop guard's label is the lane's.
        const { nativeCommand: _n, loopGuard: _l, ...channelContext } = input.channelContext ?? {};
        return live().laneInput(sessionKey, { ...input, channelContext }, mode ?? 'queue');
      },
      harness: (sessionKey) => {
        const lane = live().laneHarness(sessionKey, id);
        if (!lane) return undefined;
        // Only what the module may say (a turn and text): its untyped code passes nothing else on.
        return {
          ephemeral: (turnId) => lane.ephemeral(turnId),
          ephemeralTurn: async (a) => {
            for (const k of ['turnId', 'prompt', 'instructions'] as const) {
              if (typeof a?.[k] !== 'string') throw new Error(`module ${id}: lanes.harness(…).ephemeralTurn: ${k} must be a string`);
            }
            return lane.ephemeralTurn({ turnId: a.turnId, prompt: a.prompt, instructions: a.instructions });
          },
        };
      },
    },
    runConfig: {
      get: (sessionKey) => live().sessionRun(sessionKey),
      set: (sessionKey, o) => live().setSessionRun(sessionKey, runOverrides(id, o)),
      presets: () => live().presets(),
      offering: (cap) => {
        if (cap !== 'plan' && cap !== 'ownerProfileSwitch') throw new Error(`module ${id}: runConfig.offering: ${JSON.stringify(cap)} is neither plan nor ownerProfileSwitch`);
        return live().offering(cap);
      },
    },
    channelFor: (route) => live().channelFor(route),
    resolveRoute: (route) => live().resolveRoute(route),
    send: (route, msg, a) => live().send(route, msg, a),
    settled: (operationId) => live().settled(operationId),
    outbound: (from, to, content) => live().outbound(from, to, content),
    hold: (route, a) =>
      live().hold(route, {
        operationId: text(a?.operationId, 'hold: operationId'),
        sessionKey: text(a?.sessionKey, 'hold: sessionKey'),
        ...(a?.external !== undefined ? { external: a.external } : {}),
        ...(a?.reason !== undefined ? { reason: text(a.reason, 'hold: reason') } : {}),
      }),
    owner: () => {
      const o = live().owner();
      return { principals: [...o.principals], ...(o.sessionKey !== undefined ? { sessionKey: o.sessionKey } : {}) };
    },
    ownerRoute: () => live().ownerRoute(),
    redispatch: (item, o) => live().redispatch(item, o),
    explain: (inputId, chain) => live().explain(inputId, chain ?? false),
    host: {
      connected: () => live().hostConnected(),
      answers: (hook) => live().hostAnswers(hook),
      heldBy: (hook) => live().hostHeldBy(hook),
      external: (args) => live().hostExternal(args),
      isToken: (token) => live().isHostToken(token),
    },
  };
}

/**
 * Why a module may not act in a session as `origin` (`KernelContext.lanes.command` / `input`), if
 * it may not: only as a peer (an agent outside this daemon), never one carrying the owner label or
 * named as an owner (`policy.owners`). A person's, a host's or the kernel's origin is the kernel's
 * to give, and an owner's would make the policy run the turn as the owner's (`Policy.plan`: bypass).
 */
function peerRefusal(origin: Origin | undefined, owners: readonly string[]): string | undefined {
  if (origin?.kind !== 'peer') return `origin.kind "peer", not ${JSON.stringify(origin?.kind)}`;
  const p = origin.principal;
  if (Array.isArray(p?.labels) && p.labels.includes(OWNER_LABEL)) return `a peer never carries the ${OWNER_LABEL} label`;
  if (p && owners.includes(p.id)) return `${p.id} is an owner, never a peer`;
  return undefined;
}

/** Only what `KernelContext.runConfig.set` may say: its untyped code passes nothing else on. */
function runOverrides(id: string, o: KernelRunOverrides): KernelRunOverrides {
  if (!isObject(o)) throw new Error(`module ${id}: runConfig.set takes an object`);
  const bad = (k: string, what: string): never => {
    throw new Error(`module ${id}: runConfig.set: ${k} must be ${what}`);
  };
  const out: KernelRunOverrides = {};
  for (const k of ['preset', 'model', 'effort'] as const) {
    const v = o[k];
    if (v === undefined) continue;
    out[k] = v === null || nonEmpty(v) ? v : bad(k, 'a non-empty string or null');
  }
  if (o.mode !== undefined) out.mode = o.mode === 'default' || o.mode === 'plan' ? o.mode : bad('mode', '"default" or "plan"');
  if (o.profile !== undefined) out.profile = o.profile === null || o.profile === 'bypass' || o.profile === 'restricted' ? o.profile : bad('profile', '"bypass", "restricted" or null');
  return out;
}
