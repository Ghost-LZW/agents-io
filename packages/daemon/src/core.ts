import { ChannelRegistry } from './channel-registry.js';
import { HarnessRegistry } from './harness-registry.js';
import { ModuleRegistry } from './modules.js';

/*
 * The kernel with no modules (docs/design/core-slimming §5: "无模块也是产品"). This file imports
 * no module package and not the composition root (`bundle.ts`); `core-only.local.test.ts` checks it.
 */

/**
 * The registries a config is resolved with and a gateway runs: give `resolveConfig` / `loadConfig`
 * and `Gateway.start` the same ones (a spread of this object fits both).
 */
export interface Registries {
  harnessRegistry: HarnessRegistry;
  channelRegistry: ChannelRegistry;
  moduleRegistry: ModuleRegistry;
}

/**
 * Registries with nothing registered: no harness kind, no channel type, no feature module. A config
 * resolved with them may configure no harness (its one instance, `EMBEDDED_HARNESS`, stands for the
 * adapter the embedder passes, `GatewayOptions.harness` or `buildHarness`) and no channel (the
 * embedder's adapters are `GatewayOptions.channels`); one naming a channel type, harness kind,
 * config section or console setting of a module fails, naming it (CF-4). What runs is the kernel
 * alone: the kernel's chat commands, model tools and `host.hello` features, nothing a module adds.
 * New objects each call: registries are compared by identity (the config file schema is cached per set).
 */
export function coreRegistries(): Registries {
  return {
    harnessRegistry: new HarnessRegistry([]),
    channelRegistry: new ChannelRegistry([]),
    moduleRegistry: new ModuleRegistry([]),
  };
}
