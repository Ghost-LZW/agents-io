import type {
  AdminModule,
  ChannelAdapter,
  ClientCommand,
  IdentifyArgs,
  Identity,
  IdentityEntry,
  InboundItem,
  KernelContext,
  KernelDatabase,
  KernelOutcome,
  KernelSendResult,
  ModuleInstance,
  ModuleManifest,
  ModuleOrigin,
  ModuleToolDef,
  Origin,
  Policy,
  RenderedMessage,
  ReplyRoute,
  SessionEvent,
  SessionScope,
  Topic,
} from '@agents-io/protocol';
import { TOOL_NAMES, moduleToolInput, type ModuleTools } from '@agents-io/host-mcp';
import { CommandTable, KERNEL_COMMAND_NAMES, type ModuleCommand } from './commands.js';
import { ConfigError } from './config-error.js';
import { FEATURES } from './host.js';

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
 */

/** A module as registered: its manifest and where it comes from. */
export interface RegisteredModule {
  manifest: ModuleManifest<any>;
  origin: ModuleOrigin;
}

/** What `ModuleRegistry` takes besides the modules. */
export interface ModuleRegistryOptions {
  /** The origin of the modules given as bare manifests (default `module`; `bundle.ts` registers the built-in ones as `builtin`). */
  origin?: ModuleOrigin;
}

/** What `kernel:<capability>` may name in `ModuleManifest.needs`: the members of `KernelContext`. */
export const KERNEL_CAPABILITIES: readonly string[] = ['log', 'events', 'policy', 'records', 'db', 'topics', 'router', 'lanes', 'channelFor', 'send', 'ownerRoute', 'redispatch', 'explain', 'host'];

const MODULE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SECTION = /^[A-Za-z][A-Za-z0-9_]*$/;
const ALIAS = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;

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
  /** On for this run: its section (unless `enabled: false`), an alias, or its `defaultEnabled`. */
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

/** Hook members the daemon serves (none yet): any other a module sets fails its setup. */
const SERVED_HOOKS: readonly string[] = [];

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
    for (const [k, v] of Object.entries(i.hooks)) if (v !== undefined && !SERVED_HOOKS.includes(k)) return `hooks.${k} is not served yet`;
  }
  if (i.localFrames !== undefined && (!isObject(i.localFrames) || Object.keys(i.localFrames).length)) return 'localFrames are not served yet';
  for (const k of ['status', 'start', 'stop'] as const) if (i[k] !== undefined && !isFn(i[k])) return `${k} must be a function`;
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

  constructor(private readonly o: ModuleHostOptions) {
    const byId = new Map((o.resolved ?? []).map((r) => [r.id, r]));
    for (const id of byId.keys()) if (!o.registry.get(id)) throw new ConfigError(`the config was resolved with module ${id}, which this daemon does not register: give loadConfig and Gateway.start the same moduleRegistry`);
    this.all = o.registry.modules.map((r) => {
      const res = byId.get(r.manifest.id);
      if (!res) throw new ConfigError(`module ${r.manifest.id} is registered but the config was resolved without it: give loadConfig and Gateway.start the same moduleRegistry`);
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

  /** `host.hello` features of the modules that run (started, not stopped), in registration order. */
  features(): string[] {
    return this.all.filter((m) => m.started).flatMap((m) => [...(m.r.manifest.features ?? [])]);
  }

  /** `GET /api/status` `modules`: every registered module; `status` from a module that runs. */
  status(): AdminModule[] {
    return this.all.map((m) => {
      let status: unknown;
      if (m.started && m.instance?.status) {
        try {
          status = m.instance.status();
        } catch (e) {
          this.o.log('warn', `module ${m.r.manifest.id}: status failed: ${(e as Error).message}`);
        }
      }
      return { id: m.r.manifest.id, origin: m.r.origin, enabled: m.enabled, ...(status !== undefined ? { status } : {}) };
    });
  }

  /** Step 3: start the set-up modules in registration order; one that throws fails the start (those started before it are stopped by `stop`). */
  async start(): Promise<void> {
    for (const m of this.active()) {
      try {
        await m.instance!.start?.();
      } catch (e) {
        throw new Error(`module ${m.r.manifest.id}: start failed: ${(e as Error).message}`);
      }
      m.started = true;
    }
  }

  /** Step 4: stop the started modules in reverse order, each bounded (`MODULE_STOP_MS`); failures are logged. */
  async stop(): Promise<void> {
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
  policy(): Policy;
  flag(name: string): string | undefined;
  setFlag(name: string, value: string | undefined): void;
  db(): KernelDatabase;
  topic(sessionKey: string): Topic | undefined;
  siblings(sessionKey: string): Topic[];
  identify(a: IdentifyArgs): Identity;
  /** One owner's extra identity entries (a module's, by id), merged with the others'. */
  setExtraIdentities(owner: string, entries: IdentityEntry[]): void;
  newTopic(agent: string, conversation: string, title: string | undefined): string;
  conversationAgent(conversation: string): string | undefined;
  hasLane(sessionKey: string): boolean;
  openLane(sessionKey: string, agent: string | undefined): Promise<void>;
  command(cmd: ClientCommand, origin: Origin): Promise<KernelOutcome>;
  channelFor(route: { channel: string; account: string }): ChannelAdapter | undefined;
  send(route: ReplyRoute, msg: RenderedMessage, a: { operationId: string; sessionKey: string; turnId?: string }): Promise<KernelSendResult | undefined>;
  ownerRoute(): ReplyRoute | null;
  redispatch(item: InboundItem, o: { by: string; session?: SessionScope; agent?: string }): Promise<{ ok: true; sessionKey: string; inputId: string } | { ok: false; code: string; message: string }>;
  explain(inputId: string, chain: boolean): KernelOutcome;
  hostConnected(): boolean;
  hostAnswers(hook: string): boolean;
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
    },
    router: {
      identify: async (a) => live().identify(a),
      setExtraIdentities: (entries) => live().setExtraIdentities(`module:${id}`, entries),
      newTopic: (agent, conversation, title) => live().newTopic(agent, conversation, title),
      conversationAgent: (conversation) => live().conversationAgent(conversation),
    },
    lanes: {
      has: (sessionKey) => live().hasLane(sessionKey),
      open: (sessionKey, agent) => live().openLane(sessionKey, agent),
      command: (cmd, origin) => live().command(cmd, origin),
    },
    channelFor: (route) => live().channelFor(route),
    send: (route, msg, a) => live().send(route, msg, a),
    ownerRoute: () => live().ownerRoute(),
    redispatch: (item, o) => live().redispatch(item, o),
    explain: (inputId, chain) => live().explain(inputId, chain ?? false),
    host: {
      connected: () => live().hostConnected(),
      answers: (hook) => live().hostAnswers(hook),
    },
  };
}
