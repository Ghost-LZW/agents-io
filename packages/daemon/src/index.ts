/*
 * @agents-io/daemon: the composition root. The kernel's API (`@agents-io/kernel`), with the built-in
 * registries (`bundle.ts`) as the defaults where the kernel has empty ones (`defaults.ts`), and the
 * built-in modules.
 */
export * from '@agents-io/kernel';
export {
  CONFIG_DIR_KEYS,
  ConfigFile,
  ConfigStore,
  Gateway,
  Gateway as Daemon,
  InstanceHarness,
  RESERVED_CHANNEL_IDS,
  buildHarness,
  configFileSchema,
  implicitEnv,
  importConfigModules,
  isCredential,
  loadConfig,
  loadConfigModules,
  redact,
  resolveConfig,
  unredact,
  type ChannelEntry,
  type Config,
  type ResolvedChannel,
} from './defaults.js';
export * from './bundle.js';
