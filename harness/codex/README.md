# @agents-io/harness-codex

agents-io harness adapter for Codex: drives `codex app-server` over JSON-RPC, either as a child
process on stdio or as WebSocket frames over a Unix socket to a server that outlives the daemon
(`transport: { kind: "unix", spawn: "own" | "daemon" | "none" }`). Configuration fields are in
`docs/E2E.md` (harness instances); promises in `docs/INVARIANTS.md` (HC-1, RS-2, LN-8, …).

## Supported codex-cli versions

`SUPPORTED_CODEX_LINES` in `src/version.ts`: **0.160.x and 0.171.x** are verified. The version comes
from the `userAgent` of the `initialize` answer. Codex updates itself, so the adapter does not stop
working when it does (decision 17, HC-1):

- Older than the oldest verified line (below 0.160): refused on first use with
  `codex app-server <version> is not supported by @agents-io/harness-codex (supported: …)`
  (`UnsupportedCodexVersionError`).
- A verified line: runs, no warning.
- Newer and not verified (0.172, 0.180, 1.x, or between the verified lines), or a version that cannot
  be read (no parsable `userAgent`; `probe()` reports `unknown`): runs, with one warning per adapter
  (adapters made by `ownProcess` count as the same one). The warning is a `warn` line in the daemon
  log (`log`, i.e. `HarnessFactoryInit.log`) on the first connection, usually the start-up probe, and
  a detail-level `notice` in the first session's stream. It names the version and the verified lines
  and points at `scripts/gen-types.sh`.
- `allowUnknownVersion: true` runs any version, also an older or unreadable one, without a warning.
  `strictVersion: true` brings back the old policy: anything outside the verified lines, and an
  unreadable version, is refused. `allowUnknownVersion` wins when both are set.

Whatever the version, protocol the adapter does not know never stalls a turn (HC-9). Every server
request is answered. A method it does not implement gets `-32601`. A request without a thread id gets
an error at once and is recorded as `native` on the connection's sessions. A request for a thread no
session registers within 10 s gets `-32603`. An approval with fields or decision kinds it does not
know still opens, offering the decisions that map back. An approval whose params cannot be read is
declined, with a notice, and the turn goes on. A notification with an unexpected shape is recorded as
`native` with a detail-level notice, and the session continues.

The app-server protocol types in `src/generated/` are generated from 0.171.0 (`CODEX_GENERATED_VERSION`).
One code path drives both lines. Checked against both binaries on 2026-11-24 (`generate-ts`, with
and without `--experimental`, and real turns). From 0.160 to 0.171 the protocol only grew:

- Requests the adapter sends (`initialize`, `thread/start`, `thread/resume`, `thread/unsubscribe`,
  `thread/turns/list`, `thread/inject_items`, `thread/settings/update`, `turn/start` with
  `collaborationMode`, `turn/steer`, `turn/interrupt`, `thread/realtime/*`) are unchanged, apart
  from new optional fields it does not set.
- No notification or server request it handles was removed or renamed. Items carry
  `startedAtMs` / `completedAtMs`, turns carry `rootTurnId`, agent messages carry `moderation`, and
  `item/completed` can carry `contentTokenCount`. The adapter ignores all of these.
- New values: the `partial_answer` message phase is treated as answer text, like an unphased
  message, so the turn's last answer item is its final text. `CodexErrorInfo` adds
  `modelNotFound` and others, which are not retryable. The `humanCommand` command approval kind
  is tied to the client capability `requiredHumanApproval`, which this adapter does not declare.
  If one arrives anyway, it opens as a command approval that offers only one-time decisions
  (no "always": Codex takes only a one-time decision for it).
- New notifications the adapter does not map (`thread/readState/changed`, `thread/section/changed`,
  `thread/prediction/updated`, `thread/search/partial`) are in `DEFAULT_OPT_OUT`, so the event
  stream is the same on both lines. 0.160 accepts the unknown names.
- The CLI surface the adapter uses is the same: `app-server --listen unix://PATH`, `-c` / `--enable` / `--disable`
  (still no `--profile`), `app-server daemon start` and its control socket
  `$CODEX_HOME/app-server-control/app-server-control.sock`, and `codex --remote unix://… resume <thread>`
  for the TUI. A TUI attaching this way does not override the thread's approval policy, sandbox or model
  (`docs/design/external-holder/README.md` §10.1).
- Threads in `CODEX_HOME` written by one line resume and continue on the other, in both directions.

`spawn: "daemon"` uses the app-server daemon that Codex installs and updates itself. Its version
does not follow `executable`. On 2026-11-24 it had already moved to 0.172.0, which is not verified.
Since decision 17 it runs with the warning above. It was checked on 2026-11-25 with a real turn
(`codex.live.test.ts`, the daemon's 0.172.0 binary as a stdio `app-server`). Between 0.171.0 and
0.172.0, `generate-ts` (stable) adds `CodexErrorInfo` values (spend limits; not retryable here) and a
few fields (app tools, login, model access), and renames one realtime item variant the adapter does
not read. Nothing the adapter sends or reads was removed or renamed. The experimental schema was not
diffed, so 0.172 is still not a verified line.

## Switching a deployment's codex version

Point the instance's `executable` at the release you want, for example
`~/.codex/packages/standalone/releases/0.171.0-aarch64-apple-darwin/bin/codex`. A bare `codex`
follows `PATH`, and Codex updates that link by itself.

- stdio: restart `aio serve`.
- unix `spawn: "own"`: the app-server outlives the daemon, and its launch fingerprint
  (`<stateDir>/server.json`: binary, `CODEX_HOME`, launch flags) refuses a reattach with another
  binary. Follow these steps:
  1. Stop `aio serve`. Let a running turn finish first: once the old server is gone, a new one
     cannot adopt that turn, and the next start settles it.
  2. Stop the old app-server. Its pid is in `server.json`; `CodexHarness.shutdownOwnServer()` does
     the same thing.
  3. Change `executable`, then start `aio serve`.

  Sessions continue: they `thread/resume` their thread on the new server. Switching back works the
  same way.

## Supporting a new codex line

1. `scripts/gen-types.sh <codex-bin>` regenerates `src/generated/` from that binary (stable API, the
   closure of the root types the adapter imports) and records its version.
2. Diff the result, and also `codex app-server generate-ts --experimental` of the old and new binaries
   (the adapter sends some experimental fields: `collaborationMode`, `thread/settings/update`, realtime).
   Check for removed or renamed methods, notifications and fields. Opt out of new notifications the
   adapter does not map.
3. Add the line to `SUPPORTED_CODEX_LINES`, which ends the warning for it. Keep the lines still deployed
   (the first entry is the oldest version that still runs). Run `pnpm test`, then the live
   checks: `AGENTS_IO_LIVE_CODEX=1 CODEX_BIN=<bin> npx vitest run --project live harness/codex/test/codex.live.test.ts`
   and `aio-e2e --harness <codex instance>` (`docs/E2E.md` §1.1).
4. Record the transcripts again on the new line (`scripts/record-transcripts.ts`, below) and run
   `harness/codex/test/transcripts.test.ts`: the adapter must still write exactly what it wrote, and
   map what the new line sends.

## Recorded transcripts

Real `codex app-server` exchanges, as language-neutral transcripts (`docs/design/conformance-fixtures/`
§2): `packages/testkit/conformance/transcripts/codex/` (`plain-turn`, `steer`, `approval`,
`interrupt`; codex 0.171, model `gpt-6-sol`). `recordTransport(transport, tap)` hands every line the
adapter's `Transport` carries to a tap (testkit's `TranscriptRecorder`); `scripts/record-transcripts.ts`
runs the sessions of `test/transcript-scenarios.ts` through the real adapter on a throwaway stdio
app-server and writes them, without what is particular to the machine (home directory, host name,
workspace, the ids Codex makes up):

```sh
CODEX_HOME=<a Codex home with a model provider> node --experimental-transform-types \
  --disable-warning=ExperimentalWarning --import ./scripts/source-loader.mjs \
  harness/codex/scripts/record-transcripts.ts [plain-turn|steer|approval|interrupt]…
```

It calls a real model: run it by hand, when the adapter's frames or the codex line change on purpose,
never in CI. `test/transcripts.test.ts` replays them through `CodexHarness`, with testkit's stdio
replay (`aio-transcript-replay`) where `codex app-server` would be: a frame the adapter writes that the
recording does not have fails it. Never edit a recorded transcript by hand to make it pass.
