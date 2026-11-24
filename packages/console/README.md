# @agents-io/console

The agents-io console API (`packages/protocol/src/admin.ts`; `docs/design/core-slimming/` §4 P2
item 4): the admin HTTP endpoints under `/api` and the WebSocket `/ws` for web UIs, login links
and console sessions, the config file as the console shows, checks and writes it (credentials
redacted, literal secrets refused), and the admin routes modules contribute
(`AdminContribution`: a channel type's `ChannelModule.admin`, a harness kind's
`HarnessModule.admin`), served after the core endpoints with the same auth.

- `src/console.ts`: `ConsoleServer` (HTTP and `/ws`), `ConsoleAuth` (one-time login tokens,
  sessions), `consoleProof` (what `aio console-link` checks), `adminEndpoints(channels, harnesses)`
  (the core endpoints, then the channel types' routes, then the harness kinds').
- `src/console-config.ts`: `ConfigStore` (`GET/PUT /api/config`, `POST /api/config/validate`; the
  `ConfigAccess` modules' admin contributions get), `isCredential`, `redact`, `unredact`,
  `implicitEnv`, `envRefs`, `writeFileAtomic`.
- `src/index.ts`: both, and `consoleFactory`, the console as the gateway takes it.

It depends on `@agents-io/protocol` and the kernel (`@agents-io/kernel`) only; the kernel does not
depend on it. What the gateway gives the console and takes of it is the kernel's
`src/console-host.ts` (`ConsoleHost`, `ConsoleConfigStore`, `ConsoleFactory`); the gateway mounts
the modules' admin contributions itself and hands their routes over with their contexts. The
composition root wires the two:

```ts
import { Gateway } from '@agents-io/kernel';
import { consoleFactory } from '@agents-io/console';

const gw = await Gateway.start({ config, ...registries, console: true, consoleFactory /* , … */ });
```

`@agents-io/daemon` (`aio`) does this for you (its `Gateway.start` gives `consoleFactory` when
the options do not) and re-exports this package's API with the built-in registries as the
defaults; its README documents the console API in full ("Console API (for web UIs)").
