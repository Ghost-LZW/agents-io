import type { ConsoleFactory } from '@agents-io/kernel';
import { ConsoleServer } from './console.js';
import { ConfigStore } from './console-config.js';

/*
 * @agents-io/console: the console API (packages/protocol/src/admin.ts) as its own package
 * (core-slimming §4 P2 item 4): the HTTP endpoints and `/ws` (`ConsoleServer`), login links and
 * sessions (`ConsoleAuth`), the routes modules contribute (`adminEndpoints`), and the config file
 * as the console shows, checks and writes it (`ConfigStore`, `redact`, `unredact`). It depends on
 * the protocol and the kernel (`@agents-io/kernel`, whose `console-host.ts` says what the gateway
 * gives it) only; the composition root hands `consoleFactory` to `Gateway.start`
 * (`GatewayOptions.consoleFactory`; `@agents-io/daemon` does).
 */
export * from './console.js';
export * from './console-config.js';

/** The console for `GatewayOptions.consoleFactory`: a `ConfigStore` for the config file, a `ConsoleServer` over the gateway. */
export const consoleFactory: ConsoleFactory = {
  configStore: (o) => new ConfigStore(o),
  server: (o) => new ConsoleServer(o),
};
