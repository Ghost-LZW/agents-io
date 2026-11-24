/*
 * @agents-io/kernel: the daemon kernel with no module in it (docs/design/core-slimming §4, §6). It
 * depends on no module package; a registry not given is an empty one (`coreRegistries`).
 * `@agents-io/daemon` is the composition root: it registers the built-in modules and re-exports this
 * API with them as the defaults.
 */
export * from './config.js';
export * from './config-modules.js';
export * from './harness-registry.js';
export * from './channel-registry.js';
export * from './modules.js';
export * from './run-defaults.js';
export { ChannelModuleFiles, isModuleChannelType, moduleChannelModule, moduleChannelType, moduleSpec, type ModuleChannelEntry, type ModuleChannelSettings } from './module-channel.js';
export { coreRegistries, type Registries } from './core.js';
export * from './gateway.js';
export * from './client.js';
export * from './host.js';
export * from './runs.js';
export * from './records.js';
export * from './token.js';
export { FrameConn, LocalServer, type FrameTransport, type HostFrames, type LocalHost, type Peer } from './local-server.js';
export * from './console.js';
export * from './console-config.js';
// What a composition root's own modules and CLI use: the owner commands' reply in a fixed session,
// the kernel's ephemeral turn (topic titles), a module harness's CLI commands, the test hooks' switch.
export { FIXED_SESSION } from './commands.js';
export { EPHEMERAL_TURN_MS, ephemeralTurn } from './ephemeral-turn.js';
export { harnessModuleCommands } from './module-loader.js';
export { TEST_HOOKS_ENV, testHooksFromEnv } from './test-hooks.js';
