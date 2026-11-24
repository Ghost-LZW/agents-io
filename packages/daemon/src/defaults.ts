import { fileURLToPath } from 'node:url';
import type { TObject } from '@sinclair/typebox';
import type { BlobAccess, HarnessAdapter } from '@agents-io/protocol';
import {
  ConfigStore as ConfigStoreBase,
  consoleFactory,
  implicitEnv as consoleImplicitEnv,
  isCredential as consoleIsCredential,
  redact as consoleRedact,
  unredact as consoleUnredact,
  type ConsoleServer,
  type CredentialMarks,
} from '@agents-io/console';
import {
  Gateway as KernelGateway,
  InstanceHarness as KernelInstanceHarness,
  buildHarness as kernelBuildHarness,
  configFileSchema as kernelConfigFileSchema,
  importConfigModules as kernelImportConfigModules,
  loadConfig as kernelLoadConfig,
  loadConfigModules as kernelLoadConfigModules,
  resolveConfig as kernelResolveConfig,
  type ChannelCommonFields,
  type ChannelRegistry,
  type Config as KernelConfig,
  type ConfigFile as KernelConfigFile,
  type ConfigModules,
  type ConfigStoreOptions,
  type GatewayOptions,
  type HarnessInstance,
  type HarnessRegistry,
  type LoadOptions,
  type ModuleRegistry,
  type Registries,
  type ResolveContext,
} from '@agents-io/kernel';
import { builtinChannels, builtinHarnesses, builtinModules, type BuiltinChannelEntry, type BuiltinChannelSettings, type BuiltinModuleSections } from './bundle.js';
import type { ExternalMcpConfig } from './external-mcp.js';
import type { PresetConfig } from './presets.js';

/*
 * The kernel's API (`@agents-io/kernel`) and the console's (`@agents-io/console`) as
 * `@agents-io/daemon` always had them: a registry not given is the built-in one (`bundle.ts`), where
 * theirs is empty, and the gateway serves the console package's console. These names shadow theirs
 * in the package's index; the types are theirs, typed for the built-in channel types and modules.
 * The classes are theirs with these defaults: `instanceof` either class is true for the instances of both.
 */

/** `o` with the built-in registry for each it does not give. */
function builtin<T extends Partial<Registries>>(o: T): T & Registries {
  return { ...o, harnessRegistry: o.harnessRegistry ?? builtinHarnesses, channelRegistry: o.channelRegistry ?? builtinChannels, moduleRegistry: o.moduleRegistry ?? builtinModules };
}

/** A `channels[]` entry of a built-in type, as written. */
export type ChannelEntry = ChannelCommonFields & BuiltinChannelEntry;

/**
 * A `channels[]` entry as resolved: `type`, the keys every entry has, `account` (default `default`)
 * and what the type's module made of the rest (`ChannelModule.resolve`; a `module` entry's `module`
 * is the resolved file to import). Typed for the built-in types; another registry's resolve the same way.
 */
export type ResolvedChannel = ChannelCommonFields & { account: string } & BuiltinChannelSettings;

/** The config file as written, over the built-in harness kinds, channel types and modules. */
export type ConfigFile = Omit<KernelConfigFile, 'channels'> & { channels?: ChannelEntry[] } & BuiltinModuleSections;

/** The kernel's `Config`, with the fields the built-in modules' settings are also on (`ModuleFields.config`, `bundle.ts`). */
export interface Config extends KernelConfig {
  /**
   * Deprecated, kept for one release: the presets (section `presets`: harness instance + model +
   * effort, in config order), the same object as the presets module's settings in `modules`
   * (`ModuleFields.config`, set by `bundle.ts`), while it is on (absent in a build without it).
   * Given another value or removed before `Gateway.start`, it still decides what the runs take.
   */
  presets?: Record<string, PresetConfig>;
  /**
   * Deprecated, kept for one release: the external MCP endpoint's settings (section `externalMcp`),
   * when it is on; the same object as its module's in `modules` (`ModuleFields.config`, set by
   * `bundle.ts`). Given another value or removed before `Gateway.start`, it still turns the
   * endpoint on, changes or off.
   */
  externalMcp?: ExternalMcpConfig;
}

/**
 * Channel ids of the built-in adapters, local ends and agent addresses (`agent:<agent>:<sessionKey>`
 * routes, the `agent` identity namespace the daemon stamps, ID-7): no bridge or module channel may use them.
 * The ones the built-in types declare (`ChannelModule.ids`), then the daemon's own (`CORE_CHANNEL_IDS`).
 */
export const RESERVED_CHANNEL_IDS: readonly string[] = builtinChannels.reservedIds;

/** Variables naming a built-in harness's config dir (`HarnessModule.defaults.configDirEnv`): in `envKeys` only with roots in `envPathRoots`. */
export const CONFIG_DIR_KEYS: string[] = builtinHarnesses.configDirKeys();

/** The config file's schema over a registry's harness kinds and the given channel types and modules (default the built-in ones): the kernel's `configFileSchema`. */
export function configFileSchema(registry: HarnessRegistry, channels: ChannelRegistry = builtinChannels, modules: ModuleRegistry = builtinModules): TObject {
  return kernelConfigFileSchema(registry, channels, modules);
}

/**
 * The config file's schema over the built-in harness kinds, channel types and modules (`bundle.ts`):
 * the kernel's keys and the built-in modules' sections (`externalMcp`).
 */
export const ConfigFile: TObject = configFileSchema(builtinHarnesses, builtinChannels, builtinModules);

/** The kernel's `resolveConfig`, the built-in registries where `ctx` gives none. */
export function resolveConfig(raw: unknown, ctx: ResolveContext): Config {
  return kernelResolveConfig(raw, builtin(ctx));
}

/** The kernel's `loadConfig`, the built-in registries where `o` gives none. */
export function loadConfig(o: LoadOptions = {}): Config {
  return kernelLoadConfig(builtin(o));
}

/** The kernel's `importConfigModules`, over the built-in feature modules, channel types and harness kinds where `o` gives none. */
export function importConfigModules(raw: unknown, o: { baseDir: string; moduleRegistry?: ModuleRegistry; channelRegistry?: ChannelRegistry; harnessRegistry?: HarnessRegistry }): Promise<ConfigModules> {
  return kernelImportConfigModules(raw, builtin(o));
}

/** The kernel's `loadConfigModules`, over the built-in feature modules, channel types and harness kinds where `o` gives none. */
export function loadConfigModules(o: LoadOptions = {}): Promise<ConfigModules> {
  return kernelLoadConfigModules(builtin(o));
}

/** The console's `isCredential`, by the built-in channel types' marks unless `channels` says. */
export function isCredential(doc: unknown, at: (string | number)[], channels: CredentialMarks = builtinChannels): boolean {
  return consoleIsCredential(doc, at, channels);
}

/** The console's `redact`, by the built-in channel types' marks unless `channels` says. */
export function redact(raw: unknown, channels: CredentialMarks = builtinChannels): unknown {
  return consoleRedact(raw, channels);
}

/** The console's `implicitEnv`, by the built-in channel types unless `channels` says. */
export function implicitEnv(raw: unknown, channels: ChannelRegistry = builtinChannels, skip: readonly string[] = []): string[] {
  return consoleImplicitEnv(raw, channels, skip);
}

/** The console's `unredact`, by the built-in channel types' marks unless `channels` says. */
export function unredact(next: unknown, stored: unknown, channels: CredentialMarks = builtinChannels): ReturnType<typeof consoleUnredact> {
  return consoleUnredact(next, stored, channels);
}

/**
 * The kernel's `Gateway`: `start` takes the built-in registries where `o` gives none, the console
 * package's console (`GatewayOptions.consoleFactory`: its `ConsoleServer` and `ConfigStore`), and
 * this package's `aio` as the CLI a terminal UI's helpers run (`GatewayOptions.cli`, next to this module).
 */
export class Gateway extends KernelGateway {
  /** The console API server (`GatewayOptions.console`): the console package's. */
  declare console: ConsoleServer | undefined;
  /** The config file as the console edits it (when the config came from a file): the console package's. */
  declare readonly configStore: ConfigStoreBase | undefined;

  static override start(o: GatewayOptions): Promise<Gateway> {
    return KernelGateway.start({ ...builtin(o), consoleFactory: o.consoleFactory ?? consoleFactory, cli: o.cli ?? fileURLToPath(new URL('./cli.js', import.meta.url)) }) as Promise<Gateway>;
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return v instanceof KernelGateway;
  }
}

/** The kernel's `InstanceHarness`: without `profilesInOpen`, also what the built-in registry says of the instance's kind. */
export class InstanceHarness extends KernelInstanceHarness {
  constructor(instance: HarnessInstance, inner: HarnessAdapter, env?: Record<string, string>, instructions?: string, profilesInOpen?: boolean) {
    super(instance, inner, env, instructions, profilesInOpen ?? (instance.kind === 'module' || builtinHarnesses.get(instance.kind)?.profilesInOpen === true));
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return v instanceof KernelInstanceHarness;
  }
}

/** The kernel's `buildHarness`, over the built-in harness kinds unless `o.registry` says. */
export function buildHarness(i: HarnessInstance, blobs?: BlobAccess, o: NonNullable<Parameters<typeof kernelBuildHarness>[2]> = {}): InstanceHarness {
  return kernelBuildHarness(i, blobs, { ...o, registry: o.registry ?? builtinHarnesses });
}

/** The console's `ConfigStore`: the built-in registries where `o` gives none. */
export class ConfigStore extends ConfigStoreBase {
  constructor(o: ConfigStoreOptions) {
    super(builtin(o));
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return v instanceof ConfigStoreBase;
  }
}
