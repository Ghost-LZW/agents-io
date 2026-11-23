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
  InboundItem,
  InputRecord,
  KernelContext,
  KernelDatabase,
  KernelInputResult,
  KernelLaneHarness,
  KernelOutcome,
  KernelSendResult,
  KernelSettledSend,
  ModuleInstance,
  ModuleManifest,
  ModuleOrigin,
  ModuleToolDef,
  ModuleTurnStatus,
  Origin,
  Policy,
  RenderedMessage,
  ReplyRoute,
  RouteExplanation,
  SessionEvent,
  SessionScope,
  Topic,
  TurnContext,
} from '@agents-io/protocol';
import { AdminStatus as AdminStatusSchema } from '@agents-io/protocol';
import { TOOL_NAMES, moduleToolInput, type ModuleTools } from '@agents-io/host-mcp';
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
 * The hooks the daemon serves (`onTurnCompleted`) are called from when the gateway is built until
 * step 4.
 */

/** A module as registered: its manifest and where it comes from. */
export interface RegisteredModule {
  manifest: ModuleManifest<any>;
  origin: ModuleOrigin;
}

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
  'log', 'events', 'head', 'appendNative', 'sessions', 'status', 'stopping', 'policy', 'records', 'db', 'topics', 'router', 'lanes',
  'channelFor', 'resolveRoute', 'send', 'settled', 'outbound', 'ownerRoute', 'redispatch', 'explain', 'host',
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
      if ((TOOL_NAMES as readonly string[]).includes(t.name)) return `mcpTools: ${t.name} is a kernel tool`;
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
      if (KERNEL_COMMAND_NAMES.includes(x.name)) return `commands: /${x.name} is a kernel command`;
      if (!nonEmpty(x.help)) return `commands: /${x.name} needs a help line`;
      if (!optBool(x.ownerOnly)) return `commands: /${x.name}: ownerOnly is a boolean`;
    }
  }
  if (m.admin !== undefined) return 'admin (an AdminContribution) is not served for feature modules yet';
  return undefined;
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
  /** `ModuleRegistryOptions.fields`, checked. */
  readonly fields: ReadonlyMap<string, ModuleFields>;

  constructor(modules: readonly (ModuleManifest<any> | RegisteredModule)[], o: ModuleRegistryOptions = {}) {
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
      const bad = badManifest(m);
      if (bad) throw new Error(`module ${m.id}: ${bad}`);
      if (m.config) {
        claim(`config key ${m.config.section}`, m.id);
        for (const a of m.config.aliases ?? []) claim(`config key ${a}`, m.id);
      }
      for (const f of m.features ?? []) claim(`feature ${f}`, m.id);
      for (const t of m.mcpTools ?? []) claim(`tool ${t.name}`, m.id);
      for (const c of m.commands ?? []) claim(`command /${c.name}`, m.id);
      this.byId.set(m.id, { manifest: m, origin: r.origin });
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
      fields.set(id, out);
    }
    this.fields = fields;
  }

  get(id: string): RegisteredModule | undefined {
    return this.byId.get(id);
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

/** Hook members the daemon serves (functions): any other a module sets fails its setup. */
const SERVED_HOOKS: readonly string[] = ['onTurnCompleted'];

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
      if (!isFn(v)) return `hooks.${k} must be a function`;
    }
  }
  if (i.localFrames !== undefined && (!isObject(i.localFrames) || Object.keys(i.localFrames).length)) return 'localFrames are not served yet';
  for (const k of ['features', 'status', 'start', 'stop'] as const) if (i[k] !== undefined && !isFn(i[k])) return `${k} must be a function`;
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
      m.instance = instance;
    }
  }

  /** The set-up modules' tools, for the host MCP endpoint (`HostToolsOptions.modules`); modules without tools are left out. */
  tools(): ModuleTools[] {
    return this.active()
      .filter((m) => m.r.manifest.mcpTools?.length)
      .map((m) => ({ module: m.r.manifest.id, tools: m.r.manifest.mcpTools!, handlers: m.instance!.tools ?? {} }));
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
  /** Set while still auto and `expected`, then the cards that show it refreshed (`KernelContext.topics.setAutoTitle`). */
  setAutoTitle(topicId: string, expected: string | undefined, title: string): boolean;
  identify(a: IdentifyArgs): Identity;
  /** One owner's extra identity entries (a module's, by id), merged with the others'. */
  setExtraIdentities(owner: string, entries: IdentityEntry[]): void;
  newTopic(agent: string, conversation: string, title: string | undefined): string;
  conversationAgent(conversation: string): string | undefined;
  record(e: RouteExplanation & { at: number }): void;
  hasLane(sessionKey: string): boolean;
  openLane(sessionKey: string, agent: string | undefined): Promise<void>;
  command(cmd: ClientCommand, origin: Origin): Promise<KernelOutcome>;
  /** The lane's answer to the input (the lane opened when it is not). */
  laneInput(sessionKey: string, input: InputRecord, mode: 'queue' | 'steer' | 'interrupt'): Promise<KernelInputResult>;
  laneHarness(sessionKey: string): KernelLaneHarness | undefined;
  channelFor(route: { channel: string; account: string }): ChannelAdapter | undefined;
  resolveRoute(route: ReplyRoute): { ok: true; route: ReplyRoute } | { ok: false; message: string };
  send(route: ReplyRoute, msg: RenderedMessage, a: { operationId: string; sessionKey: string; turnId?: string; external?: ExternalSender }): Promise<KernelSendResult | undefined>;
  settled(operationId: string): KernelSettledSend | undefined;
  outbound(from: TurnContext, to: ReplyRoute): Promise<'allow' | 'deny'>;
  ownerRoute(): ReplyRoute | null;
  redispatch(item: InboundItem, o: { by: string; session?: SessionScope; agent?: string }): Promise<{ ok: true; sessionKey: string; inputId: string } | { ok: false; code: string; message: string }>;
  explain(inputId: string, chain: boolean): KernelOutcome;
  hostConnected(): boolean;
  hostAnswers(hook: string): boolean;
  hostHeldBy(hook: 'outbound' | 'external'): string | undefined;
  hostExternal(args: ExternalCalloutArgs): Promise<ExternalCalloutAnswer>;
  isHostToken(token: string): boolean;
}

/** One module's `KernelContext` over the gateway's backend: its log prefix, its records namespace, its own extra identities. */
export function kernelContext(id: string, k: KernelBackend): KernelContext {
  const live = (): KernelBackend => {
    if (!k.ready()) throw new Error(`module ${id}: the kernel is not ready during setup (only id and log are)`);
    return k;
  };
  const flag = (name: string) => `module:${id}:${name}`;
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
    get policy() {
      return live().policy();
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
      setAutoTitle: (topicId, expected, title) => live().setAutoTitle(topicId, expected, title),
    },
    router: {
      identify: async (a) => live().identify(a),
      setExtraIdentities: (entries) => live().setExtraIdentities(`module:${id}`, entries),
      newTopic: (agent, conversation, title) => live().newTopic(agent, conversation, title),
      conversationAgent: (conversation) => live().conversationAgent(conversation),
      record: (e) => live().record(e),
    },
    lanes: {
      has: (sessionKey) => live().hasLane(sessionKey),
      open: (sessionKey, agent) => live().openLane(sessionKey, agent),
      command: (cmd, origin) => live().command(cmd, origin),
      input: async (sessionKey, input, mode) => {
        // A module stamps only peers (agents outside this daemon): a person's or the kernel's origin is the kernel's to give.
        if (input?.origin?.kind !== 'peer') throw new Error(`module ${id}: lanes.input takes a peer's input (origin.kind "peer", not ${JSON.stringify(input?.origin?.kind)})`);
        return live().laneInput(sessionKey, input, mode ?? 'queue');
      },
      harness: (sessionKey) => live().laneHarness(sessionKey),
    },
    channelFor: (route) => live().channelFor(route),
    resolveRoute: (route) => live().resolveRoute(route),
    send: (route, msg, a) => live().send(route, msg, a),
    settled: (operationId) => live().settled(operationId),
    outbound: (from, to) => live().outbound(from, to),
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
