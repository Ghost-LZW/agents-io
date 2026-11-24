import type { ModuleRunDefaults, NamedRunDefaults } from '@agents-io/protocol';
import { ConfigError } from './config-error.js';

/*
 * Named run defaults, the kernel's side of the seam (core-slimming §4: "模块之间共享配置段"). A
 * preset (an agent's `preset`, `run.start` `overrides.preset`, a session's preset) is a name the
 * kernel asks the one registered module that provides named run defaults about
 * (`ModuleManifest.runDefaults`: the bundled presets module, `presets.ts`), with what that module's
 * section resolved to; the kernel never reads the section itself. The config asks while it
 * resolves (`config.ts` `resolveAgents`), the gateway while it runs (a turn's plan, a task run's
 * overrides, `KernelContext.runConfig`): the same provider, so a name the config takes is one the
 * runs take.
 */

/** The module that provides named run defaults, as a config or a run has it. */
export interface RunDefaultsProvider {
  /** Its id. */
  id: string;
  /** Its config section in the file, when it has one there (not a `modules` entry's module): what "none configured" names. */
  section?: string;
  /** On for this config (or run). */
  enabled: boolean;
  /** Its manifest's `runDefaults`. */
  runDefaults: ModuleRunDefaults<unknown>;
  /** What its config section resolved to (while it is on). */
  config: unknown;
}

/** A name of the named run defaults and what it gives, checked: a configured instance, strings. */
export interface NamedRun extends NamedRunDefaults {
  name: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The named run defaults of one config or run: what the provider gives (`provider`: none when no
 * registered module provides them), each answer checked against the configured instances
 * (`configured`). A provider whose call throws or answers something else fails with a
 * `ConfigError` naming the module.
 */
export class NamedRuns {
  constructor(
    private readonly provider: RunDefaultsProvider | undefined,
    private readonly configured: (instance: string) => boolean,
  ) {}

  /** The module that provides them (on or off), if one is registered. */
  get module(): string | undefined {
    return this.provider?.id;
  }

  /** The names, in the provider's order; none while no module that is on provides them. */
  names(): string[] {
    const p = this.provider;
    if (!p?.enabled) return [];
    const got: unknown = this.ask('names', () => p.runDefaults.names(p.config));
    if (!Array.isArray(got) || got.some((n) => typeof n !== 'string' || !n)) throw this.bad('runDefaults.names must return an array of names (non-empty strings)');
    return [...new Set(got as string[])];
  }

  /** What `name` gives, checked; undefined when no module that is on gives it. */
  get(name: string): NamedRun | undefined {
    const p = this.provider;
    if (!p?.enabled) return undefined;
    const d: unknown = this.ask(`resolve(${JSON.stringify(name)})`, () => p.runDefaults.resolve(p.config, name));
    if (d === undefined || d === null) return undefined;
    const where = `runDefaults.resolve(${JSON.stringify(name)})`;
    if (!isObject(d) || typeof d.harness !== 'string' || !d.harness) throw this.bad(`${where} must answer { harness, model?, effort?, description? }`);
    for (const k of ['model', 'effort', 'description'] as const) if (d[k] !== undefined && typeof d[k] !== 'string') throw this.bad(`${where}: ${k} must be a string`);
    if (!this.configured(d.harness)) throw this.bad(`${where}: harness instance ${JSON.stringify(d.harness)} is not configured`);
    return {
      name,
      harness: d.harness,
      ...(d.model !== undefined ? { model: d.model as string } : {}),
      ...(d.effort !== undefined ? { effort: d.effort as string } : {}),
      ...(d.description !== undefined ? { description: d.description as string } : {}),
    };
  }

  /** Every name the provider lists, as `get` checks it: a provider's mistake fails the config (or the start), not a turn. */
  check(): void {
    for (const n of this.names()) if (!this.get(n)) throw this.bad(`runDefaults.names lists ${JSON.stringify(n)}, which runDefaults.resolve does not give`);
  }

  /**
   * Why no name gives anything: no registered module provides presets, or the one that does is
   * off; undefined while one is on.
   */
  missing(): string | undefined {
    if (!this.provider) return 'no registered module provides presets';
    if (!this.provider.enabled) return `module ${this.provider.id}, which provides presets, is off`;
    return undefined;
  }

  /**
   * A name nothing gives, as a config naming it and `run.start` say it: `unknown preset "p"
   * (configured: a, b)`, `(no \`presets\` configured)` (the provider's section), or why there are
   * none at all (`missing`).
   */
  unknown(name: string): string {
    const names = this.names();
    const none = this.provider?.section !== undefined ? `no \`${this.provider.section}\` configured` : `module ${this.provider?.id} provides none`;
    return `unknown preset ${JSON.stringify(name)} (${this.missing() ?? (names.length ? `configured: ${names.join(', ')}` : none)})`;
  }

  private ask<T>(what: string, call: () => T): T {
    try {
      return call();
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw this.bad(`runDefaults.${what} failed: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  private bad(msg: string): ConfigError {
    return new ConfigError(`module ${this.provider!.id}: ${msg}`);
  }
}
