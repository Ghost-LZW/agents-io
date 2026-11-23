import type { HarnessModule } from '@agents-io/protocol';

/**
 * The harness kinds a deployment's config may `use` (besides `module`), each a `HarnessModule`,
 * in registration order: the first is the default kind (the one instance of a config that names
 * no harness). `bundle.ts` builds the built-in one; an embedder may build its own and hand it to
 * `resolveConfig` / `loadConfig` and `Gateway.start` (`harnessRegistry`), the same to both.
 */
export class HarnessRegistry {
  private readonly byKind = new Map<string, HarnessModule>();

  constructor(modules: readonly HarnessModule[]) {
    for (const m of modules) {
      if (m.kind === 'module') throw new Error('harness kind "module" is the host\'s own (`use: "module"`); a registered kind needs another name');
      if (this.byKind.has(m.kind)) throw new Error(`harness kind ${JSON.stringify(m.kind)} is registered twice`);
      this.byKind.set(m.kind, m);
    }
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
}
