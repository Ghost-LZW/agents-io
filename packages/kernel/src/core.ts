import { ChannelRegistry } from './channel-registry.js';
import { HarnessRegistry } from './harness-registry.js';
import { ModuleRegistry } from './modules.js';

/*
 * The kernel with no modules (docs/design/core-slimming §5: "无模块也是产品"). The kernel package
 * (`@agents-io/kernel`) depends on no module package, and nothing here registers one: a registry not
 * given is an empty one. `@agents-io/daemon` is the composition root that registers the built-in
 * modules (its `bundle.ts`) and gives them as the defaults. `core-only.local.test.ts` checks it.
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

/**
 * What the kernel takes when it is given no registry (`ResolveContext`, `LoadOptions`,
 * `GatewayOptions`, `ConfigStoreOptions`, `importConfigModules`, `buildHarness`, the console's
 * credential marks): nothing registered, one set for all of them (registries never change; `with`
 * makes new ones), so a config resolved and a gateway started without registries agree.
 */
export const NO_REGISTRIES: Readonly<Registries> = Object.freeze(coreRegistries());
