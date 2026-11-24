# @agents-io/kernel

The agents-io daemon kernel with no module in it (`docs/design/core-slimming/` §1, §5): the
gateway (ingress, the binding-table router, one lane per session, the hub, compositors and the
outbox, watches, schedules, task runs, the host inbound queue), config resolution, the feature
module host and the harness, channel and module registries, the module file loader, the local
Unix socket with the client and host frames (`docs/HOSTS.md`), the daemon's records, and the
console API's core.

It depends on no module package: no channel (`channel/*`) or harness (`harness/*`) package, and
not `@agents-io/daemon`, the composition root that registers the built-in ones. A registry not
given is an empty one, so what runs is the kernel alone, with the channels and the harness the
embedder passes:

```ts
import { Gateway, coreRegistries, resolveConfig } from '@agents-io/kernel';

const registries = coreRegistries(); // or a HarnessRegistry, ChannelRegistry and ModuleRegistry of your own
const config = resolveConfig({ dataDir, policy: { owners: ['chat:alice'] } }, { env: process.env, baseDir, ...registries });
const gw = await Gateway.start({
  config,
  ...registries,
  harness: myHarness, // a HarnessAdapter: every instance of the config is this one
  channels: [{ adapter: myChannel }], // ChannelAdapters: with no channel type, the only channels
});
```

`@agents-io/daemon` (`aio`) re-exports this API with the built-in registries as the defaults; its
README documents the configuration, the host connection, the console API and the library in
full ("Library", "The kernel without modules"). `test/core-only.test.ts` runs the kernel's
promises on this package alone, and `pnpm boundaries:check` keeps it free of modules: its source
imports and its package.json dependencies (`scripts/boundaries.json`, `test/boundaries.local.test.ts`).
