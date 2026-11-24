import { Type, type Static } from '@sinclair/typebox';
import type { ModuleManifest } from '@agents-io/protocol';

/*
 * The presets, as a built-in feature module (core-slimming §2: a host-level feature whose default
 * implementation is a module, decision 16; `bundle.ts` registers it, nothing else in the daemon
 * imports it): named run defaults, each a harness instance with a model and effort. Its section is
 * `presets` (`presets: { <name>: { harness, model?, effort?, description? } }`, a map of names:
 * `ModuleConfig.entries`), and it gives them through the run-defaults seam
 * (`ModuleManifest.runDefaults`), which the kernel asks for an agent's `preset` (while the config
 * resolves), a task run's `overrides.preset` (RN-2), a session's preset (`KernelContext.runConfig`,
 * which the owner-commands module's `/preset` sets and lists) and a turn's plan. On whenever it is
 * registered (the section has no `enabled`: any name is a preset's), so the presets are what they
 * were when the kernel read them; a build without it has none, and a config naming one fails,
 * saying no registered module provides presets (CF-4).
 */

const Closed = { additionalProperties: false } as const;

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

/**
 * The `presets` section of the config file, as written: named presets, harness instance + model +
 * effort. An agent's `preset` is its default; the owner switches one session to another with
 * `/preset <name>` (`default` is reserved).
 */
export type PresetsSection = Record<string, Static<typeof PresetEntry>>;

/** A named run preset (`presets.<name>`), resolved. */
export interface PresetConfig {
  name: string;
  /** Harness instance name. */
  harness: string;
  model?: string;
  effort?: string;
  description?: string;
}

/** What the section resolves to: the presets by name, in config order (`Config.presets`, deprecated, is the same object). */
export type PresetsConfig = Record<string, PresetConfig>;

/** `/preset default` goes back to the agent's own: no preset may have this name. */
export const DEFAULT_PRESET = 'default';

/** As an instance name. */
const PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const presetsModule: ModuleManifest<PresetsConfig> = {
  id: 'presets',
  kind: 'feature',
  config: {
    section: 'presets',
    schema: {},
    entries: PresetEntry,
    // On, as the presets were before they were a module (and with no `enabled`, on whenever the section is there).
    defaultEnabled: true,
    resolve: (raw, ctx) => {
      const presets: PresetsConfig = {};
      for (const [name, p] of Object.entries(raw as PresetsSection)) {
        const where = `${ctx.where}.${name}`;
        if (!PRESET_NAME.test(name)) ctx.fail(`${where}: preset names are letters, digits, '.', '_' and '-' (at most 64)`);
        if (name === DEFAULT_PRESET) ctx.fail(`${where}: "${DEFAULT_PRESET}" is reserved (\`/preset ${DEFAULT_PRESET}\` goes back to the agent's own)`);
        if (!ctx.harnesses.includes(p.harness)) ctx.fail(`${where}.harness: unknown harness instance ${JSON.stringify(p.harness)} (configured: ${ctx.harnesses.join(', ')})`);
        presets[name] = {
          name,
          harness: p.harness,
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.effort !== undefined ? { effort: p.effort } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
        };
      }
      return presets;
    },
  },
  runDefaults: {
    names: (presets) => Object.keys(presets),
    resolve: (presets, name) => {
      if (!Object.hasOwn(presets, name)) return undefined;
      const { name: _name, ...given } = presets[name]!;
      return given;
    },
  },
  // Nothing runs: the kernel asks `runDefaults`.
  setup: () => ({}),
};
