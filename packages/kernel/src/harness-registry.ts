import type { AdminContribution, HarnessCliCommand, HarnessModule } from '@agents-io/protocol';
import { AdminClaims, badAdmin } from './admin-contributions.js';

/** What `HarnessRegistry` takes besides the modules. */
export interface HarnessRegistryOptions {
  /**
   * Deprecated, kept for one release: per kind, the `HarnessInstance` field its launch settings
   * were under before they became `launch` (the built-in kinds: `claude`, `codex`). The instances
   * `resolveConfig` returns carry it as an alias of `launch` (see there). A kind it names must be
   * registered; the field is never one of `HarnessInstance`'s own.
   */
  launchAliases?: Readonly<Record<string, string>>;
}

/** One registered kind's admin contribution (`HarnessModule.admin`). */
export interface HarnessAdminContribution {
  kind: string;
  admin: AdminContribution;
}

/** `HarnessInstance`'s own fields (and `module`, a module instance's alias): never a kind's launch alias. */
const INSTANCE_FIELDS = new Set(['name', 'kind', 'launch', 'run', 'profiles', 'options', 'cwd', 'env', 'unavailable', 'module']);

/**
 * The harness kinds a deployment's config may `use` (besides `module`), each a `HarnessModule`,
 * in registration order: the first is the default kind (the one instance of a config that names
 * no harness). `bundle.ts` builds the built-in one; an embedder may build its own and hand it to
 * `resolveConfig` / `loadConfig` and `Gateway.start` (`harnessRegistry`), the same to both.
 */
export class HarnessRegistry {
  private readonly byKind = new Map<string, HarnessModule>();
  private readonly aliases = new Map<string, string>();
  private readonly commands = new Map<string, { kind: string; run: HarnessCliCommand }>();
  /**
   * The registered kinds' admin contributions (`HarnessModule.admin`), in registration order: checked
   * (`badAdmin`) and claimed against the core's endpoints and one another (`AdminClaims`: a route, a
   * console key or a schema name belongs to one kind), as a channel registry does its types'. Against
   * a channel registry's where both meet (`adminContributions`).
   */
  readonly adminContributions: readonly HarnessAdminContribution[];

  constructor(modules: readonly HarnessModule[], o: HarnessRegistryOptions = {}) {
    const admins: HarnessAdminContribution[] = [];
    const claims = new AdminClaims();
    for (const m of modules) {
      if (m.kind === 'module') throw new Error('harness kind "module" is the host\'s own (`use: "module"`); a registered kind needs another name');
      if (this.byKind.has(m.kind)) throw new Error(`harness kind ${JSON.stringify(m.kind)} is registered twice`);
      if (m.admin !== undefined) {
        const bad = badAdmin(m.admin);
        if (bad) throw new Error(`harness kind ${JSON.stringify(m.kind)}: bad ${bad}`);
        claims.claim({ owner: 'harness kind', name: m.kind }, m.admin);
        admins.push({ kind: m.kind, admin: m.admin });
      }
      this.byKind.set(m.kind, m);
      for (const [name, run] of Object.entries(m.cli ?? {})) {
        const at = `harness kind ${JSON.stringify(m.kind)}: cli ${JSON.stringify(name)}`;
        if (!CLI_NAME.test(name)) throw new Error(`${at}: a command name is lowercase letters, digits and -, starting with a letter`);
        if (typeof run !== 'function') throw new Error(`${at} is not a function`);
        const other = this.commands.get(name);
        if (other) throw new Error(`${at}: harness kind ${JSON.stringify(other.kind)} adds it too`);
        this.commands.set(name, { kind: m.kind, run });
      }
    }
    for (const [kind, field] of Object.entries(o.launchAliases ?? {})) {
      if (!this.byKind.has(kind)) throw new Error(`launchAliases: harness kind ${JSON.stringify(kind)} is not registered`);
      if (INSTANCE_FIELDS.has(field)) throw new Error(`launchAliases: ${JSON.stringify(field)} is a HarnessInstance field`);
      this.aliases.set(kind, field);
    }
    this.adminContributions = Object.freeze(admins);
  }

  get(kind: string): HarnessModule | undefined {
    return this.byKind.get(kind);
  }

  /** In registration order. */
  get modules(): HarnessModule[] {
    return [...this.byKind.values()];
  }

  get kinds(): string[] {
    return [...this.byKind.keys()];
  }

  /** The kind of a config that names none: the first registered. */
  get defaultKind(): string | undefined {
    return this.kinds[0];
  }

  /** Every kind's config-dir variables (`defaults.configDirEnv`), in registration order. */
  configDirKeys(): string[] {
    return this.modules.flatMap((m) => m.defaults?.configDirEnv ?? []);
  }

  /** Deprecated: the field a kind's instances also carry their `launch` under (`HarnessRegistryOptions.launchAliases`). */
  launchAlias(kind: string): string | undefined {
    return this.aliases.get(kind);
  }

  /** The CLI command a registered kind adds under this name (`HarnessModule.cli`), if one does. */
  cliCommand(name: string): HarnessCliCommand | undefined {
    return this.commands.get(name)?.run;
  }
}

/** A name `HarnessModule.cli` may give a command. */
const CLI_NAME = /^[a-z][a-z0-9-]*$/;
