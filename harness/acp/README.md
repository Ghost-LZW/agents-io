# @agents-io/harness-acp

agents-io harness adapter for any [Agent Client Protocol](https://agentclientprotocol.com) agent:
the daemon is the ACP client, the agent runs as its child and speaks ACP v1 JSON-RPC on stdio (the
official TypeScript SDK, `@agentclientprotocol/sdk`). The harness kind is `acp`
(`acpHarnessModule`, registered by the daemon's composition root `packages/daemon/src/bundle.ts`).
It only starts the command you configure; it never installs an agent from the ACP registry. Design:
`docs/design/core-slimming/` §3 G9; promises in `docs/INVARIANTS.md` (HC-1, HC-2, RS-1, …).

```json
"harnesses": {
  "claude-acp": {
    "use": "acp",
    "command": "/opt/acp/node_modules/.bin/claude-agent-acp",
    "env": { "ANTHROPIC_API_KEY": "env:ANTHROPIC_API_KEY" },
    "profiles": { "bypass": { "mode": "bypassPermissions" } }
  }
}
```

| Key | Meaning |
|---|---|
| `command`, `args` | The agent program (a path, `~` and relative to the config file, or a name on PATH) and its arguments, as written: other local users can read them (`ps`), so no secrets here; put them in `env`. |
| `env`, `cwd` | The agent process's environment (over the daemon's) and working directory (also its sessions' unless an agent or launch gives another). |
| `profiles` | Profile name → `{ "mode": "<session mode id>" }`: the session mode (`session/set_mode`) a turn of that profile runs in, set before its prompt whenever it differs. Without `mode`, `bypass` runs in the mode the session opened in, and every other profile (the built-in `restricted`: guests, admitted strangers, peers, tasks) in the agent's mode that asks before it acts, as Claude Code's `default` and Codex's `on-request` do: the flavor's `restrictedMode`, generic `default` when the agent offers it (Claude Code's ACP agent opens in `auto`, where it decides by itself; its `default` asks). An agent offering modes none of which the flavor knows to ask does not start such a turn, saying so, until the profile's `mode` is configured; an agent with no session modes runs as it is. Nothing else is allowed in an acp profile (a config error). A mode the agent does not offer fails the turn's start. |
| `mcp` | How the host's MCP endpoint (agents-io's tools) reaches the agent: `http` (an `http` MCP server, the bearer token in its `Authorization` header; the agent must advertise `mcpCapabilities.http`) or `stdio-bridge` (a stdio MCP server, `bin/mcp-stdio-bridge.mjs` of this package run with node, which forwards each message to the endpoint; the URL and token go in its environment, never on a command line; every ACP agent takes stdio). Default: `http` when the agent advertises it, else `stdio-bridge`. |
| `flavor` | The agent's quirks by name (`generic`, `claude`); default: picked by the agent's `initialize` answer (`agentInfo.name`), else `generic`. |
| `planMode` | The session mode Plan mode selects. Declares Plan mode at once (otherwise only once a session showed the flavor's plan mode, `plan`, among its modes). |
| `compact` | The command that compacts a session's context (default: `/compact` once the agent advertises a `compact` command). |
| `displayName` | The name in chat replies (default: the flavor's, else the instance's). |
| `elicitation` | Offer form elicitation (`elicitation/create`), so the agent can ask questions. Default `true`. |
| `authMethod` | Call `authenticate` with this method (one of the agent's `authMethods`) after `initialize`. |

## What comes from the agent

`probe` starts the agent and sends `initialize` (protocol version 1, client info `agents-io`). The
client capabilities offered are **form elicitation only**: no `fs`, no `terminal`. The agent reads,
writes and runs things itself, under its own permissions, and asks (`session/request_permission`)
when it decides to. An agent answering another protocol version is refused, clearly (HC-1).

| `HarnessCaps` / declaration | From |
|---|---|
| `steer: 'none'` | ACP has no prompt while a prompt runs: an input during a turn waits in the lane's queue for the next one. |
| `interrupt` | `session/cancel` (every request the agent waits on is answered cancelled first, as the protocol asks; the turn ends when the prompt answers `cancelled`, or after 15 s anyway, as interrupted, `cancel_timeout`). A prompt the agent goes on with after that keeps the session: ACP updates carry no turn id, so what it streams is `native` (in no turn) and the next turn's `session/prompt` waits for it to answer, at most another 15 s (`cancelTimeoutMs`); still no answer, the session is closed and opened again and a `continuity` notice says which: the same session is loaded again only with `session/close` answered, `loadSession`, and then the prompt answered too, within another 15 s (an agent may take close as the `session/cancel` it ignored, and a prompt still running would stream into the session loaded under the same id); otherwise a new one is started and bound, its context given in full in the next preface, and nothing the old one goes on with reaches it (INVARIANTS LN-2, DL-3). A session closed while the agent has not answered its prompt (it would not stop, or the session closed mid-turn) leaves that prompt with the agent process: until it answers, what it streams reaches no session, and that session id is not loaded again (see `resume`). |
| `approvals` | `session/request_permission` → `request.opened` (kind `file_change` for edit/delete/move tools, else `tool_approval`); `allow_once` picks the agent's one-time allow option and never a wider one, `allow_session` its "always" option (else the one-time one), `deny` its reject option (else the `cancelled` outcome), `native` an option by `{ optionId }`; the "always" options are the request's `suggestions`. A decision that picks nothing offered is answered as a deny and `respond` says so. |
| `questions` | `elicitation/create` in form mode → `request.opened` kind `question` (the agent asks its user, as Codex's `requestUserInput`: the host asks the turn's person, a question card in the chat, and never approves it for them, on an owner's bypass turn either), one question per field (choices by their titles); an `answer` goes back typed (numbers, booleans, a choice's `const`), a `deny` as `decline`. Only with `elicitation` on. URL elicitations are declined. |
| `resume` | `loadSession`: `open({ resume })` sends `session/load`; the conversation the agent replays is not turned into events (updates outside a turn only change what the session knows), so the log holds it once. An agent that cannot load starts a new session, with a `continuity` notice. While the same agent process still runs a prompt of that session, closed before the agent answered it (a parked topic closing, a harness switch and back, a release), the open first waits for that prompt to answer, at most 15 s (`cancelTimeoutMs`), and loads the session only then; still no answer, it starts a new session, with a `continuity` notice (INVARIANTS LN-2, DL-3). |
| `modes` (Plan) | `availableModes` of `session/new` / `session/load` (or `planMode`). |
| `compact` | The commands it advertises (`available_commands_update`), through the flavor (or `compact`). |
| `adopts` | Never: the agent process dies with the daemon. At stop sessions close (a running turn ends interrupted) and the process is shut down (stdin closed, then SIGTERM, then SIGKILL, 1 s apart); the next input resumes the session with `session/load` (RS-1). |
| `sessionEnv: 'own-process'` | One process serves every session of the instance; a launched session with its own env, and each task run, gets a process of its own (`ownProcess`). |

Instructions (`HarnessOpenArgs.instructions`) go as `systemPrompt` (`append`) when the agent
advertises `sessionCapabilities.systemPrompt`; otherwise the open fails, saying so. A run's `model`
is selected when the session offers a model config option (`category: "model"`) with that value;
otherwise a notice says the agent runs its own. Images and audio go inline (base64) when the agent's
`promptCapabilities` take them (up to 10 MiB), else as a `resource_link` to the stored file, as do
files.

Turn mapping: `agent_message_chunk` → `text.delta` (answer), each message's text as a
`text.snapshot`, and what the agent wrote after its last tool call as the final answer;
`agent_thought_chunk` → reasoning deltas; `tool_call` / `tool_call_update` → `item.started` /
`item.progress` / `item.completed` (type by tool kind: `command`, `file_change`, `web_search`,
`tool`; an MCP tool, named `mcp__<server>__<tool>`, is `mcp_tool` with `tool: { server, name }` and a
title starting `<server>.<tool>`; the claude flavor's `Agent` / `Task` is `subagent`); diffs →
`diff.updated`; `plan` → `plan.updated`; the prompt's usage (else the last `usage_update`) →
`turn.completed.usage`; other updates → `native` (ephemeral). Stop reasons: `end_turn` completed,
`cancelled` interrupted, `refusal` / `max_tokens` / `max_turn_requests` failed with that code, an
unknown or missing one ambiguous (`unknown_stop_reason`: the SDK does not check the answer, so a
`null` one is taken as no stop reason; anything else that goes wrong mapping it also ends the turn
ambiguous, `adapter_error`, and never takes the daemon down). The sender preface is Codex's (INVARIANTS ID-2): context that stays the same
across a conversation or a sender is shown when it changes, and in full again after an input the
agent may not have read, a turn of the compaction command, or a compaction the flavor recognises in
the agent's updates (`compaction`). A prompt answered with an error fails the turn (`prompt_failed`; its inputs not
consumed unless the agent said something first); an agent that exits mid-turn ends it ambiguous
(`agent_exited`), and the next open starts the agent again.

## What ACP loses against a native adapter

Native steer, native turn and item ids, truncation and rollback, context without a turn, adoption
across a daemon restart, approvals that survive the agent process, subagent visibility (beyond a
flavor's guess), stable usage figures, the agent's own compactions (ACP v1 has no such update: only
a flavor that recognises one sees it, so the sender preface gives its context in full again only
then and after the compaction command). Mid-session model switches only through the agent's
(unstable) config options.

## Flavors

`src/flavors.ts`: named hooks for an agent's quirks, never in the kernel (the boundary guard keeps
vendor names out of core files). `generic` is the protocol as written; `claude` (Claude Code's ACP
agent, `@agentclientprotocol/claude-agent-acp`) adds its display name, its `Agent` / `Task`
subagent tool and its compaction report (a tool call "Compact conversation" whose
`_meta.claudeCode.toolName` is `compact`, sent for its own compactions and `/compact`'s). A hook not
given is `generic`'s: `matches`, `displayName`, `planMode`, `restrictedMode` (the asking mode a
profile without `mode` runs in), `compactCommand`, `mcpTool`, `subagent`, `compaction`,
`elicitationQuestions`. Embedders may pass a flavor object
of their own (`AcpHarnessOptions.flavor`).

## Tests and transcripts

- `test/fake-agent.ts`: a fake ACP agent on stdio built on the SDK's agent side; `test/acp.test.ts`
  (core: the conformance suite, version refusal, env, permissions, a prompt the agent will not
  cancel, questions, load, exits, MCP) and
  `acp.local.test.ts`; `packages/daemon/test/harness-acp.test.ts` in the daemon.
- Recorded transcripts (docs/design/conformance-fixtures §2, protocol `acp`):
  `packages/testkit/conformance/transcripts/acp/` (`plain-turn`, `permission`, `cancel`, `load`),
  replayed through the real adapter by `test/transcripts.test.ts` with `aio-transcript-replay` in the
  agent's place. `plain-turn`, `cancel` and `load` are owner turns (`bypass`, the mode the session
  opened in: no `session/set_mode`); `permission` is a `restricted` turn with no profiles configured,
  which selects the agent's `default` mode. Re-record them (real model, by hand) when the frames the adapter writes change on
  purpose:

  ```sh
  # Claude Code's ACP agent, installed into a throwaway directory (never globally)
  mkdir -p /tmp/acp-agents && cd /tmp/acp-agents && echo '{"private":true}' > package.json \
    && npm install --ignore-scripts @agentclientprotocol/claude-agent-acp@0.110.1
  cd <repo> && mkdir -p /tmp/acp-claude-config && \
  AIO_ACP_COMMAND=/tmp/acp-agents/node_modules/.bin/claude-agent-acp \
  CLAUDE_CONFIG_DIR=/tmp/acp-claude-config ANTHROPIC_BASE_URL=<gateway> ANTHROPIC_AUTH_TOKEN=<key> \
  ANTHROPIC_MODEL=<model> ANTHROPIC_SMALL_FAST_MODEL=<model> DISABLE_TELEMETRY=1 \
    node --experimental-transform-types --disable-warning=ExperimentalWarning \
    --import ./scripts/source-loader.mjs harness/acp/scripts/record-transcripts.ts [scenario…]
  ```

  A fresh `CLAUDE_CONFIG_DIR` keeps your own settings, skills and history out of the recording.
  `AIO_RECORD_OUT` writes elsewhere. The 2026-11-25 recording: claude-agent-acp 0.110.1, model
  `gpt-6-sol`.
- Live: `test/acp.live.test.ts` (`AGENTS_IO_LIVE_ACP=1`, `AIO_ACP_COMMAND`, the agent's env;
  `docs/E2E.md` §1.6).
