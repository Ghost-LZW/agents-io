import type { Static, TSchema } from '@sinclair/typebox';
import type { AdminSession, AdminStatus } from './admin.js';
import type { AdminContribution } from './admin-module.js';
import type { ChannelAdapter, RenderedMessage } from './channel.js';
import type { ClientCommand, WatchDraft } from './client.js';
import type { ReplyRoute } from './common.js';
import type { Audience, Level, SessionEvent } from './events.js';
import type { HarnessAdapter } from './harness.js';
import type { ExternalCallout, ExternalCalloutAnswer, ExternalSender, IdentityEntry, InboundItem, RouteExplanation, ScheduleView, SessionScope } from './host.js';
import type { InboundEnvelope, InputRecord, Origin } from './inbound.js';
import type { IdentifyArgs, Identity, Policy, TurnContext, TurnDraft } from './policy.js';
import type { Resolver } from './requests.js';
import type { RunSpec } from './run.js';
import type { ScheduleDraft } from './schedule.js';
import type { Topic } from './topic.js';
import type { Watch } from './watch.js';

/*
 * A feature of the host as a module (core-slimming G6): what it adds to the deployment (a config
 * section, `host.hello` features, model tools, chat commands) and what it runs, registered by the
 * host's composition root (the daemon's `bundle.ts`). The host assembles its chat command table,
 * its model tool catalog and its `host.hello` features from its own entries and the active
 * modules' entries; a module that is off is not there at all (no tools, no commands, no
 * features). Built-in modules and a third party's are the same shape; `ModuleOrigin` tells them
 * apart in the host's status. A third party's comes from an embedder's registry or from the
 * deployment's config file (the daemon's `modules` entries, imported when the daemon starts).
 * Channel types and harness kinds keep their own contracts (`ChannelModule`, `HarnessModule`).
 *
 * In progress: the daemon reads the manifest (`id`, `kind`, `needs`, `config`, `features`,
 * `mcpTools`, `commands`, `runDefaults`, `cli`, `setup`) and, of the instance, `tools`, `offeredTools`, `commands`,
 * `features`, `status`, `connect`, `start`, `stop` and the hooks `onTurnCompleted`, `inputHint`, `onUndispatched`,
 * `onAction`, `resolver`, `identities`, `statusLines`, `scheduledMessage` and `scheduledWake`. `admin`, the other `hooks` and
 * `localFrames` were sketched for the Claude Code terminal (G6 step 6), which became a harness
 * capability instead (`HarnessAdapter.takeover`); they are served when a module needs them. Until
 * the daemon serves one, a module that sets it fails to register (`admin`) or to set up
 * (`hooks.<name>`, `localFrames`), naming it, rather than being silently ignored. The built-in
 * modules are the topic titles (step 2), the watch, live and topic tools (step 3), the stranger
 * approval (step 4), the presets (named run defaults: `runDefaults`), the owner's run-config
 * commands (step 5), the north projections (G9: the ACP server with its `aio acp`, and the AG-UI
 * endpoint) and the external MCP endpoint (step 1).
 */

/**
 * Where a registered module comes from: shipped with the host (`builtin`), or someone else's
 * (`module`): an embedder's, or one the deployment's config file names (the daemon's `modules`
 * entries). Both get the same `KernelContext`.
 */
export type ModuleOrigin = 'builtin' | 'module';

/** What a module is. Only `feature` for now; channel types and harness kinds register as `ChannelModule` / `HarnessModule`. */
export type ModuleKind = 'feature';

/** What `ModuleConfig.resolve` gets besides the value. */
export interface ModuleResolveContext {
  /** Where the value is, for messages: the section's key, or the alias path it was read from (`policy.strangers`). */
  where: string;
  /** The alias path the value was read from, when it came from one (the section is absent). */
  alias?: string;
  /** The deployment's environment (the process's over `.env.live`), read-only. SECRET: never put a value in a message. */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * `v` with every string `"env:NAME"` in it replaced by the variable's value. A variable that is
   * not set fails the config: `<where>…: environment variable NAME is not set`.
   */
  substitute(v: unknown, where: string): unknown;
  /** A path from the config: `~` is the home directory, a relative one is relative to the config file. */
  path(p: string): string;
  /**
   * A value elsewhere in the config file, at a dotted path, as written (a copy; undefined when it
   * is not set): for a rule across sections (an external MCP client's principal is none of
   * `policy.owners`). The file schema has checked it. Never put a value in a message.
   */
  valueAt(dotted: string): unknown;
  /**
   * The configured harness instances, by name (`RunSpec.harness`), in config order: for settings
   * that name one (a preset's `harness`). Empty where no config is being resolved (a module
   * resolved alone, from a file with nothing but its own value).
   */
  readonly harnesses: readonly string[];
  /** Fail the config with this message. Messages name keys and variables, never values. */
  fail(msg: string): never;
}

/**
 * A module's section of the host's config file: a top-level key (`section`) holding an object of
 * the module's own keys (`schema`) and `enabled`, which the host adds and owns; the host closes the
 * object (an unknown key is a config error). Present, the module is on unless `enabled` is
 * `false`; absent, the first alias path that is set decides instead (on or off: see `aliases`);
 * with neither, the module is on when `defaultEnabled`. A section may instead be a map of names the
 * deployment chooses (`entries`: the presets' `presets: { <name>: { … } }`). A config change to a
 * section or an alias takes effect at the next start (the console answers `applied: "restart"`).
 */
export interface ModuleConfig<C = unknown> {
  /** The top-level key: ASCII letters, digits and `_`, starting with a letter; never one of the host's own keys. */
  readonly section: string;
  /** The section's own keys, in the order the schema lists them (not `enabled`: the host's). Empty (`{}`) with `entries`. */
  readonly schema: Readonly<Record<string, TSchema>>;
  /**
   * The section is a map from names the deployment chooses to entries of this schema (the presets:
   * `presets: { <name>: { harness, … } }`) instead of an object of the module's own keys: `schema`
   * is then empty, and the section has no `enabled` (any name is an entry's), so present it is on;
   * absent, its aliases and `defaultEnabled` decide as for any section. `resolve` gets the map as
   * written (`{}` when absent) and checks the names. A `modules` entry's `config` is such a map too.
   */
  readonly entries?: TSchema;
  /**
   * Where the settings were before they were the module's, as dotted paths of the config file
   * (`policy.strangers`): read when the section is absent, as valued there (the file schema checks
   * them where they are). The first that is set decides whether the module is on: `aliasEnabled`
   * says, when the module has it; without it, an object with `enabled: false` is off, as a section
   * is, and any other value is on. A path is no other module's section or alias. (A module whose
   * settings keep their old top-level key takes it as its `section`: the external MCP endpoint's
   * `externalMcp`.)
   */
  readonly aliases?: readonly string[];
  /**
   * Whether the value set at an alias path (`alias`) turns the module on: for an old setting whose
   * off value is not `enabled: false` (`policy.strangers: "drop"`). Returns a boolean (anything
   * else fails the config); only for a module with `aliases`.
   */
  aliasEnabled?(value: unknown, alias: string): boolean;
  /** Whether the module is on when neither its section nor an alias is in the file. */
  readonly defaultEnabled: boolean;
  /**
   * The section's value (valid against `schema`, without `enabled`; for `entries`, the map as
   * written; `{}` when absent) or an alias's value as it is there (an object keeps its `enabled`),
   * as the module's settings; called only when the module is on. Throwing (`ctx.fail`) fails the
   * config.
   */
  resolve(raw: unknown, ctx: ModuleResolveContext): C;
}

/**
 * What one name of a module's named run defaults gives (`ModuleRunDefaults.resolve`; a preset): a
 * harness instance with a model and effort over that instance's own. A run that takes it runs on
 * that instance as its agent still (the agent's cwd, instructions and tools).
 */
export interface NamedRunDefaults {
  /** The harness instance: one the host configured (`ModuleResolveContext.harnesses`). */
  harness: string;
  /** Over the instance's model (`RunSpec.model`). */
  model?: string;
  /** Over the instance's effort (`RunSpec.effort`). */
  effort?: string;
  /** One line a listing shows next to the name (`/preset`). */
  description?: string;
}

/**
 * Named run defaults a module provides (the presets): what the host's config and requests name by
 * name (the daemon: an agent's `preset`, `run.start` `overrides.preset`, a session's preset set
 * through `KernelContext.runConfig.set`, the listing `runConfig.presets()`). The host asks them
 * without running the module, from what its config section resolved to (`config`; undefined
 * without a section): while the config resolves (an agent naming one, right after the module's
 * section resolved) and while it runs (a turn's plan, a task run's overrides). At most one
 * registered module provides them; with none, or with that module off, every name is unknown (a
 * config naming one fails, saying so). Synchronous, quick and pure: the same `config` and name give
 * the same answer.
 */
export interface ModuleRunDefaults<C = unknown> {
  /** The names it gives, in the order they are listed (the config's). */
  names(config: C): readonly string[];
  /** What `name` gives; undefined for a name it does not give. The host checks the answer (a configured instance, strings). */
  resolve(config: C, name: string): NamedRunDefaults | undefined;
}

/**
 * A model tool a module adds to the host's MCP endpoint, next to the host's own (`send_message`, …),
 * under the same per-agent switch (`agents.<name>.tools`: `true`, or a list naming it).
 */
export interface ModuleToolDef {
  /** The tool's name: lower-case ASCII letters, digits and `_`, starting with a letter; never one of the host's own tools. */
  readonly name: string;
  /** What the model reads: written so that a model uses the tool correctly with no extra prompt. */
  readonly description: string;
  /** The tool's arguments, as a JSON Schema object (`Type.Object({ … })`). */
  readonly input: TSchema;
  /** Only reads (MCP `readOnlyHint`; default false). */
  readonly readOnly?: boolean;
  /** Works only while a turn runs in the caller's session (default true; the host refuses the call otherwise, as for its own tools). */
  readonly needsTurn?: boolean;
}

/** A call of a module's tool, as its handler gets it. */
export interface ModuleToolCall {
  /** The session of the harness binding that called. */
  sessionKey: string;
  /** The running turn, when one runs in the session; always set for a tool that needs one (`ModuleToolDef.needsTurn`). */
  turn?: TurnContext;
  /** The arguments, valid against the tool's `input`. */
  args: Record<string, unknown>;
  /** The side effect's id while a turn runs (`tool:<sessionKey>:<the harness's call id>`): the same for a retried call. */
  operationId?: string;
}

/**
 * Runs a module's tool; the result goes to the model as JSON (`null` for undefined). An error the
 * model should fix is thrown with `name` `ToolError` (the model reads its message); anything else
 * is answered `internal error: <message>`.
 */
export type ModuleToolHandler = (call: ModuleToolCall) => unknown | Promise<unknown>;

/** A chat command a module adds (`/<name> args` from a chat with the deployment), next to the host's own. */
export interface ModuleCommandDef {
  /** The name after `/`: lower-case ASCII letters, digits, `_` and `-`, starting with a letter; never one of the host's own commands. */
  readonly name: string;
  /**
   * Other names that run the same command, with the same handler (`ModuleCommandCall.name` is the
   * one typed): names as `name` is, one module's each. Its one `/help` line covers them
   * (`/model [name], /effort [level] — …`).
   */
  readonly aliases?: readonly string[];
  /** Its line in `/help` (`/name [args] — what it does`), after the host's own lines (unless `helpBefore`). */
  readonly help: string;
  /**
   * One of the host's own commands (`tui`) whose `/help` line its line comes right before, instead
   * of after all of the host's own lines; the lines placed before the same command keep the
   * modules' registration order.
   */
  readonly helpBefore?: string;
  /** Only who may operate the session (`Policy.control`, the owner) runs it; anyone else's `/name` is an ordinary message (default true). */
  readonly ownerOnly?: boolean;
}

/** A chat command of a module, as its handler gets it. */
export interface ModuleCommandCall {
  name: string;
  /** What follows the name, trimmed. */
  args: string;
  /** The session the message is addressed to. */
  sessionKey: string;
  /** The agent of that session's delivery, when the route names one. */
  agent?: string;
  /** The flat conversation the session is a topic of, when it is one. */
  conversation?: string;
  origin: Origin;
  env: InboundEnvelope;
  input: InputRecord;
  /**
   * Queue the compaction command of the harness the session's next turn runs on
   * (`KernelSessionRun.compact`, `HarnessAdapter.compact`: Claude Code `/compact`) as this
   * command's message (its id, origin and reply route), behind anything running: the one text
   * the kernel hands a harness as it is (`channelContext.nativeCommand`, which only the kernel
   * sets), a turn of its own (CT-2). The lane's answer; `unsupported` when that harness declares
   * none, `forbidden` when the sender may not operate the session (for a command anyone may run).
   */
  compact(): Promise<KernelInputResult>;
}

/**
 * Answers a module's command: the reply goes back on the route the command came from, and nothing
 * reaches the session (no turn). Undefined: not a command after all; the message goes on as usual.
 */
export type ModuleCommandHandler = (call: ModuleCommandCall) => Promise<{ ok: boolean; reply: string } | undefined>;

/** What a module's click handler answers (`ModuleHooks.onAction`). */
export type ModuleActionResult = { ok: true } | { ok: false; reason: string };

/** A topic change, as a module's hook gets it. */
export interface ModuleTopicChange {
  conversation: string;
  from?: Topic;
  to: Topic;
  /** `to` was just created. */
  created: boolean;
}

/** What a handover of a turn to another topic did (`KernelContext.topics.rotate` / `switch`). */
export interface ModuleTopicHandover {
  /** The topic now current, which got the turn's messages. */
  topic: Topic;
  /** The topic left. */
  previous?: Topic;
  /** The input ids as handed to `topic`. */
  handed: string[];
}

/** How a watch the kernel was asked to create ended (`KernelContext.watches.add`). */
export type KernelWatchResult = { ok: true; watch: Watch } | { ok: false; code: string; message: string };

/** How a watch the kernel was asked to remove ended (`KernelContext.watches.remove`). */
export type KernelUnwatchResult = { ok: true; removed: boolean } | { ok: false; code: string; message: string };

/** How a schedule the kernel was asked to set ended (`KernelContext.schedules.add` / `addAs`). */
export type KernelScheduleResult = { ok: true; schedule: ScheduleView } | { ok: false; code: string; message: string };

/** How a schedule the kernel was asked to remove ended (`KernelContext.schedules.remove` / `removeAs`). */
export type KernelUnscheduleResult = { ok: true; removed: boolean } | { ok: false; code: string; message: string };

/** How a turn ended (`turn.completed.status`). */
export type ModuleTurnStatus = Extract<SessionEvent['body'], { t: 'turn.completed' }>['status'];

/**
 * What a module hooks into. The daemon serves `onTurnCompleted`, `inputHint`, `onUndispatched`,
 * `onAction`, `resolver`, `identities`, `statusLines`, `scheduledMessage` and `scheduledWake`; a module that sets any
 * other fails to set up, naming it (see the file comment). Each says which feature it is for.
 */
export interface ModuleHooks {
  /**
   * An input no rule dispatched and no host took (dropped, or only recorded as context), after it
   * was routed: for every module in registration order, each awaited, from when the daemon runs
   * (inputs come in once its channels run, before the modules' `start`) to the end (its stop too,
   * until it refuses inbound). `addressed`: the input addresses the deployment (a DM, an @ of one
   * of its accounts, a click: what a binding's `mentions: ["self"]` matches), unless the adapter
   * says it does not (`admission: "observe"`, a reaction). A throw or a rejected promise is logged
   * (`module <id>: onUndispatched failed: …`); the next module still hears it. The stranger
   * approval: a stranger's message to ask the owner about.
   */
  onUndispatched?(a: { env: InboundEnvelope; origin: Origin; input: InputRecord; addressed: boolean }): void | Promise<void>;
  /**
   * Clicks on buttons whose action id starts with `prefix` (a non-empty string no other module's
   * prefix starts, or is the start of: the stranger cards' `aio:stranger:`), before the click is
   * routed and after the kernel's own buttons (approvals, questions, stop) are told apart, for
   * clicks that are not the deployment's own echo or dropped by the adapter. A result means it was
   * handled: nothing is routed, and the click's result is it (a `reason` that is not a string is
   * `refused`). Undefined routes the click as usual (a binding's `actionPrefix`). A throw is the
   * click's error, as the ingress's own would be. Served from when the daemon runs to the end. The
   * stranger approval: the owner's answer on a card.
   */
  onAction?: { prefix: string; handle(a: { actionId: string; env: InboundEnvelope; origin: Origin }): ModuleActionResult | undefined | Promise<ModuleActionResult | undefined> };
  /**
   * A turn of a session ended, whatever its status (not a task run's turn): called right after its
   * `turn.completed` is in the session's log, from when the daemon runs until it stops its modules,
   * for every module in registration order; a turn an `outbound.scoped` host checks (U20, its
   * `turn.started.checked`) once its checked answers settled (past the host's exit check, or held),
   * at most the host's outbound timeout and 5 s later. Return at once (start the work, don't await
   * it): a throw or a rejected promise is logged, nothing else. Topic titles.
   */
  onTurnCompleted?(a: { sessionKey: string; turnId: string; status: ModuleTurnStatus }): void;
  /** A conversation's current topic changed. */
  onTopicChanged?(c: ModuleTopicChange): void;
  /**
   * Who answers a request of a turn (`ctx`), before the local policy's resolver: the first module,
   * in registration order, that gives one decides; with none, the local policy's (`Policy.resolve`
   * of the built-in policy) does. A connected host whose hello lists `resolve` is asked before
   * both, and they decide when it cannot answer; an embedder's own `Policy.resolve` replaces both.
   * Synchronous and quick; a throw is the policy's error (the lane denies the request). Served
   * from when the daemon runs to the end. The stranger approval: a guest's turn asks the owner.
   */
  resolver?(ctx: TurnContext): Resolver | undefined;
  /**
   * The run of a session's next turn, over what the agent's policy planned. (What the owner set
   * for a session, a preset too, is the kernel's to apply: `KernelContext.runConfig`.)
   */
  planRun?(a: { sessionKey: string; run: RunSpec; draft: TurnDraft }): RunSpec;
  /** The adapter a session's instance runs on instead of its own (a native terminal holding the session). */
  harnessFor?(a: { sessionKey: string; instance: string }): HarnessAdapter | undefined;
  /**
   * A line the inputs routed to a conversation's current topic carry for the model
   * (`channelContext.topicTools`: how to move between topics), for the agent the input goes to
   * (undefined: the deployment's default agent); undefined for none. Asked for every such input,
   * from when the daemon runs (its stop too), of every module in registration order: the lines
   * given are joined with a newline. Synchronous and quick; a throw is logged and gives no line.
   * The topic tools.
   */
  inputHint?(agent: string | undefined): string | undefined;
  /**
   * Lines `/status` shows for a session, right after the line of what it runs (agent, harness,
   * model) and before its working directory: of every module in registration order, from when
   * the daemon runs to the end. Synchronous and quick; a throw is logged and gives no line, and so
   * is anything but an array (entries that are not strings are left out). The owner's run-config
   * commands: its Plan mode and the owner's profile switch.
   */
  statusLines?(sessionKey: string): string[];
  /**
   * A `message` schedule fires (`KernelContext.schedules`; SC-1: once per firing): `true` when the
   * module sent it itself, as one of its own principals (the external MCP endpoint: a client's
   * schedule, `schedule.createdBy` its principal, goes out as that client's `send_message`, through
   * its checks); `false` for a schedule that is not its own. A peer's schedule (set through
   * `schedules.addAs`, `schedule.module` the module's id) is asked of that module only: `false`, no
   * hook, or the module being off ends the firing (recorded as failed, SC-1; the schedule is kept, a
   * one-shot at that time for the next start), and it is never sent as the daemon's (SC-3). Anyone
   * else's (the owner's, a host's, an agent's) is asked of every module in registration order until
   * one answers `true`; when none does, the kernel sends it. A throw or a rejected promise is the
   * firing's failure. An error with `final: true` (trying again
   * cannot deliver it: held, denied, out of the client's scope, no channel) ends the firing, recorded
   * as failed, and the schedule moves to its next time; any other is tried again with the same
   * operationId after a growing wait, and at the next start (SC-1). The daemon fires schedules from
   * after the modules' `start` until before their `stop`; called outside that, it throws (the firing
   * is redone at the next start), never sending a module's schedule as the daemon's.
   */
  scheduledMessage?(a: { schedule: ScheduleView; operationId: string }): Promise<boolean> | boolean;
  /**
   * A peer's wake fires (`action: "host"`, set through `schedules.addAs`, `schedule.module` the
   * module's id; SC-3): `true` when the module still acts for it (the external MCP endpoint: the
   * client is configured and its `schedule:` scope still has the route), and the kernel hands it to
   * the host as usual (an item in the host inbound queue); `false`, no hook, or the module being off
   * ends the firing (recorded as failed, SC-1; the schedule is kept as for `scheduledMessage`):
   * nothing goes to the host. A throw is the firing's failure as for `scheduledMessage` (`final:
   * true` ends it, anything else is tried again later).
   * Asked only of the module the schedule was set through, from after the modules' `start` until
   * before their `stop`.
   */
  scheduledWake?(a: { schedule: ScheduleView; operationId: string }): Promise<boolean> | boolean;
  /**
   * The module's identity map entries when the daemon starts (`KernelContext.router.setExtraIdentities`
   * replaces them later): asked once, when the kernel is ready and before any input is identified
   * (before the channels run). They rank below the configured identities and a host's map, which
   * win for the same channel identity. A throw, or anything but an array, fails the start. The
   * stranger approval: its guests.
   */
  identities?(): IdentityEntry[];
}

/**
 * A local socket connection a module took (`ModuleInstance.connect`): from the frame's answer on,
 * it carries the module's own protocol as JSON values both ways (one per line on the Unix socket,
 * one per message on the console's `/ws`), until either end closes it or the daemon stops.
 */
export interface ModuleConnection {
  /** Write one JSON value. False when the connection is gone, or its buffer is full (then wait for `drained`). */
  send(value: unknown): boolean;
  /** Resolves when writing may go on, or once the connection is gone. */
  drained(): Promise<void>;
  /**
   * Hear the values the far end writes, in order (one listener; values that came before it was set
   * are kept for it). A line that is not JSON is dropped.
   */
  onValue(fn: (value: unknown) => void): void;
  /** Aborted when the connection is gone: either end closed it, or the daemon stops. */
  readonly signal: AbortSignal;
  /** Close it after what was written is flushed. */
  close(): void;
}

/**
 * A command a feature module adds to the host's CLI (`ModuleManifest.cli`): `aio <name> [options]
 * [positionals]`. The CLI parses the options (its common `--config`, `--env-file`, `--socket` and
 * the command's own `options`; anything else is a usage error, exit 2) and calls `run`, whose answer
 * is the exit code.
 */
export interface ModuleCliCommand {
  /** What follows `aio <name>` in the CLI's help: its options, and in a few words what it does. */
  readonly usage: string;
  /** Its own options (long names: lower-case letters, digits and `-`), a string value or a flag. */
  readonly options?: Readonly<Record<string, 'string' | 'boolean'>>;
  run(a: ModuleCliArgs): Promise<number>;
}

/** What a module's CLI command gets (`ModuleCliCommand.run`). */
export interface ModuleCliArgs {
  /** The options given (the common ones too), by long name. */
  readonly options: Readonly<Record<string, string | boolean | undefined>>;
  /** What follows the options. */
  readonly positionals: readonly string[];
  /** The process's environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The daemon's local socket: `--socket`, else `$AIO_SOCKET`, else the config's `socketPath`
   * (reading the config: `--config`, `$AIO_CONFIG`, `./aio.config.json`; a config that does not
   * load throws, which the CLI reports as a usage error).
   */
  socket(): string;
}

/** A local socket frame a module answers (`tui.attach`); not served yet. */
export type ModuleFrameHandler = (frame: Record<string, unknown>, from: { origin: Origin; host: boolean }) => Promise<KernelOutcome>;

/** What a module's `setup` returns: the handlers of what its manifest declares, and what it runs. */
export interface ModuleInstance {
  /** A handler for each of the manifest's `mcpTools`, by name (exactly those). */
  tools?: Readonly<Record<string, ModuleToolHandler>>;
  /**
   * Which of the manifest's `mcpTools` the host's endpoint offers now (default: all of them): for a
   * tool the model cannot use without something that comes and goes (the live tools: a running
   * channel that can open a live, or for `live_say` / `live_leave` a live that runs). Asked at
   * every request a harness sends the endpoint, so a tool appears on the harness's next
   * `tools/list` once it can be used, and is gone from the next one after; one not offered at a
   * request is not callable in it either. Names that are not the manifest's are ignored; a throw
   * offers none of its tools (logged).
   */
  offeredTools?(): readonly string[];
  /** A handler for each of the manifest's `commands`, by name (exactly those; its `aliases` run the same handler). */
  commands?: Readonly<Record<string, ModuleCommandHandler>>;
  hooks?: ModuleHooks;
  localFrames?: Readonly<Record<string, ModuleFrameHandler>>;
  /**
   * Which of the manifest's `features` it advertises now (default: all of them while it runs): for
   * a module that runs without what a feature promises (an endpoint that could not listen: logged,
   * not fatal). Names that are not the manifest's are ignored.
   */
  features?(): readonly string[];
  /** What the host's status (`GET /api/status` `modules[]`) shows of it; plain JSON (undefined: nothing). */
  status?(): unknown;
  /**
   * A local socket connection asks to be the module's (the client frame `module.connect` naming its
   * id; `hello` as the far end sent it, unchecked JSON): answer `{ ok: true, value }` to take it
   * (the frame's result carries `value`, and from then on the connection is `conn`), or
   * `{ ok: false, code, message }` to leave it a client connection (`conn` unused). A throw is
   * answered `internal`. Who may take a connection is the module's to check: anyone who can open
   * the socket may ask (the local user, SE-2), so a module stamps nothing on its word alone. Asked
   * from the modules' `start` until their `stop`; a connection that said `host.hello` or subscribed
   * is refused before (`forbidden`). The daemon closes the module's connections when it stops.
   */
  connect?(hello: unknown, conn: ModuleConnection): Promise<KernelOutcome> | KernelOutcome;
  /** After the host's channels and local socket run; throwing fails the start. */
  start?(): Promise<void>;
  /** When the host stops, in reverse registration order, before its channels and lanes; bounded by the host. */
  stop?(): Promise<void>;
}

/**
 * A module: the manifest the host reads without running anything, and `setup`, which builds the
 * instance. `C` is what its config section resolves to.
 */
export interface ModuleManifest<C = unknown> {
  /** Unique among the host's modules: lower-case ASCII letters, digits, `.`, `_` and `-`, starting with a letter or digit (`tools.watch`). */
  readonly id: string;
  readonly kind: ModuleKind;
  /**
   * What it needs: `module:<id>` (another registered module, on whenever this one is: a config
   * error otherwise) or `kernel:<capability>` (one of `KernelContext`'s members, e.g.
   * `kernel:topics`). Anything else fails the registration.
   */
  readonly needs?: readonly string[];
  /** Its config section; without one the module is on whenever it is registered. */
  readonly config?: ModuleConfig<C>;
  /** The named run defaults it provides (the presets), read from what its section resolved to; at most one registered module's. */
  readonly runDefaults?: ModuleRunDefaults<C>;
  /** `host.hello` features it adds while it runs (after the host's own); never one of the host's own. */
  readonly features?: readonly string[];
  readonly mcpTools?: readonly ModuleToolDef[];
  readonly commands?: readonly ModuleCommandDef[];
  /** Admin routes and console settings (G5's `AdminContribution`); not served for feature modules yet. */
  readonly admin?: AdminContribution;
  /**
   * Commands it adds to the host's CLI, by name (lower-case letters, digits and `-`, starting with a
   * letter): `aio <name> …` runs it in its own process (no instance, no kernel: it reaches the daemon
   * through its socket). A registered module's whether or not it is on (a command that needs it
   * running says so when the daemon answers); the CLI's own commands and the harness kinds' keep
   * their names, two modules adding the same name fail the registration. The ACP server: `acp`.
   */
  readonly cli?: Readonly<Record<string, ModuleCliCommand>>;
  /**
   * Build the instance, before the host builds its ingress (the host assembles the handlers
   * first); `config` is what `config.resolve` returned (undefined without a section). The kernel
   * context is late-bound: only `id` and `log` work during `setup`, the rest from `start` on.
   * Acquire nothing here that `stop` would have to release: `start` runs it. Throwing fails the
   * start.
   */
  setup(kernel: KernelContext, config: C): ModuleInstance | Promise<ModuleInstance>;
}

/** The result of a kernel request (the local socket's `result` frame). */
export type KernelOutcome = { ok: true; value: unknown } | { ok: false; code: string; message: string };

/** How a send through the kernel's outbox ended. */
export interface KernelSendResult {
  /** `held`: the host's check took it (U20); never sent, final. */
  status: 'delivered' | 'rejected' | 'unknown' | 'held';
  /** The platform's message id, when delivered. */
  providerMessageId?: string;
  error?: string;
  /** `held` (and a send the host's exit check denied): why, as the host said (never content). */
  reason?: string;
}

/** The outbound check's answer that the host took the send (`KernelContext.outbound` with `content`, U20): settle it with `KernelContext.hold`. */
export interface KernelHold {
  hold: true;
  reason?: string;
}

/** A send through the kernel's outbox that has settled: how it ended, and the route it went to. */
export interface KernelSettledSend extends KernelSendResult {
  route: ReplyRoute;
}

/** What a lane answered an input a module gave it (`KernelContext.lanes.input`). */
export type KernelInputResult =
  | { ok: true; disposition?: 'new_turn' | 'steer' | 'queued' | 'observe_only' | 'duplicate' }
  | { ok: false; reason: string };

/**
 * What a module may run beside the open lane of a configured agent's session
 * (`KernelContext.lanes.harness`): an ephemeral turn on the harness a turn of the session ran on.
 * Never the adapter itself: what that turn may do (its session, profile, options, tools) is the
 * kernel's to set, so a module cannot open a session with a profile or options of its own.
 */
export interface KernelLaneHarness {
  /**
   * Whether `ephemeralTurn` runs for this turn of the session: the turn is in the session's log
   * and the harness instance it ran on (its `run.harness`, which a preset may have moved off the
   * agent's; else the agent's) declares `ephemeralOpen` (Codex). Throws for an instance that is
   * not configured.
   */
  ephemeral(turnId: string): boolean;
  /**
   * One ephemeral turn beside the session, on the instance that ran `turnId`, and the text of its
   * answer: undefined when that turn did not complete or no answer came within 30 s. The module
   * gives only text. The kernel sets the rest: a throwaway session (`options.ephemeral`, kept out
   * of the harness's history; no preface) in the session's working directory, with none of the
   * host's tools (no MCP); the run that turn ran with (what the policy planned for it; the agent's
   * when the log has none) at low effort in the default mode, under a profile named after the
   * module that is read-only and never asks (`approvalPolicy: "never"`, `sandbox: "read-only"`);
   * `instructions` in place of the agent's; one input of the kernel's (`origin.kind: "system"`,
   * `via` the module's id) holding `prompt`. The session is closed afterwards. Throws when
   * `ephemeral(turnId)` is false.
   */
  ephemeralTurn(a: { turnId: string; prompt: string; instructions: string }): Promise<string | undefined>;
}

/**
 * What a session's next turn runs (`KernelContext.runConfig.get`): the harness instance, what its
 * adapter declares, and the run over the agent's own with what is set for the session
 * (`KernelRunOverrides`) applied.
 */
export interface KernelSessionRun {
  /** The harness instance: the agent's, or the one of the preset set for the session. */
  harness: string;
  /** Its kind (`claude-code`). */
  kind: string;
  /** The command that compacts its context (`HarnessAdapter.compact`); absent: none. */
  compact?: string;
  /** It has Plan mode (`HarnessAdapter.modes`). */
  plan: boolean;
  /** It lets the owner switch the profile of their turns (`HarnessAdapter.ownerProfileSwitch`). */
  ownerProfileSwitch: boolean;
  /** The preset: the one set for the session, else the agent's. */
  preset?: string;
  /** A preset set for the session that is no longer given (not configured, or no module provides presets now): the agent's own runs. */
  stalePreset?: string;
  model?: string;
  effort?: string;
  mode?: 'default' | 'plan';
  /** The profile of the owner's turns set for the session (other turns keep the policy's). */
  profile?: 'bypass' | 'restricted';
  /** Something is set for the session (a preset, a model, an effort, a mode or a profile). */
  overridden: boolean;
}

/**
 * What `KernelContext.runConfig.set` changes of a session's next turns: a value sets it, `null`
 * clears it, a key not given stays as it is. A preset replaces the instance, model and effort of
 * the agent's run; `model` and `effort` go over that; `mode` too; `profile` applies only to turns
 * whose inputs are all the owner's.
 */
export interface KernelRunOverrides {
  /** A preset the module providing named run defaults gives (`ModuleManifest.runDefaults`; another throws). */
  preset?: string | null;
  model?: string | null;
  effort?: string | null;
  mode?: 'default' | 'plan';
  profile?: 'bypass' | 'restricted' | null;
}

/**
 * A preset (a name of the named run defaults, `ModuleManifest.runDefaults`: the bundled presets
 * module's `presets`), with the model and effort its instance gives when it sets none.
 */
export interface KernelPreset {
  name: string;
  /** Its harness instance and that instance's kind. */
  harness: string;
  kind: string;
  model?: string;
  effort?: string;
  description?: string;
}

/** What the host's `external` hook is asked (`ExternalCallout.args`). */
export type ExternalCalloutArgs = Static<typeof ExternalCallout>['args'];

/** A prepared SQL statement (node:sqlite's `StatementSync` is one). */
export interface KernelStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** A SQL database (node:sqlite's `DatabaseSync` is one). */
export interface KernelDatabase {
  exec(sql: string): void;
  prepare(sql: string): KernelStatement;
}

/** A module's subscription to a session's events (`KernelContext.subscribe`). */
export interface KernelSubscription extends AsyncIterable<SessionEvent> {
  /** Live ephemeral events lost because the module read too slowly (durable ones are re-read, never lost). */
  readonly dropped: number;
  /** End it: the iteration ends. */
  close(): void;
}

/**
 * What a module gets of the kernel: views of the host's core objects, each an existing capability
 * of the host (nothing a built-in feature could not already do). A module is in-process code the
 * composition root, the embedder or the deployment's config file (the daemon's `modules` entries)
 * registered, as trusted as the daemon's own (INVARIANTS ID-3 boundary 2), and gets this whatever
 * its origin: the views keep its untyped code to the kernel's rules (what it may stamp, say or
 * set: only a peer's origin, never an evidence grant or the policy), they are no sandbox. `db` is
 * the whole records database. Late-bound: only `id` and `log` work during `setup`; every other
 * member throws until `setup` returned.
 */
export interface KernelContext {
  /** The module's id. */
  readonly id: string;
  /** The host's log; messages get the prefix `module <id>: `. Messages never carry secrets. */
  log(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown): void;
  /** A session's log from `fromSeq` (default 0), in seq order (the hub). */
  events(sessionKey: string, fromSeq?: number): SessionEvent[];
  /** The seq of a session's last logged event (0: none yet). */
  head(sessionKey: string): number;
  /**
   * A session's events as they come (the hub, tier `full`, default visibility: never `internal`):
   * without `fromSeq`, a `session.snapshot` event first (`snapshot`: the folded `SessionSnapshot`,
   * its seq the last one folded in) and everything after it; with it, the durable events after `fromSeq` from the log, then live ones (a `fromSeq`
   * behind the log's floor or ahead of its head: a snapshot first, LN-10). Live ephemeral events
   * (text deltas, progress) come too, and a module that reads too slowly loses only those
   * (`dropped`); durable ones are re-read from the log, never lost. What it reads is everything
   * the log has: a module that shows it to someone outside the daemon applies what they may see
   * (U20's `withholding` for an external reader, DL-7). Close it when done.
   */
  subscribe(sessionKey: string, o?: { fromSeq?: number }): KernelSubscription;
  /**
   * The host's blob store, to put media a module's client sends (an image in a prompt) where
   * inputs point at it (`ContentBlock.ref`): content-addressed, at most the store's limit (a larger
   * one rejects, nothing written). Write only: a module reads no blob through here.
   */
  readonly blobs: {
    put(bytes: Uint8Array, meta: { mime: string; name?: string }): Promise<string>;
  };
  /**
   * Append a durable native event (`body: { t: "native", name }`, `native` its payload) to a log of
   * the module's own: what it did that no session's log records (the external MCP endpoint's
   * sends, in `external:<client>`). Only native events: every other kind is the kernel's to write.
   */
  appendNative(logKey: string, e: { name: string; native: unknown; level: Level; audience: Audience; visibility: SessionEvent['visibility'] }): void;
  /** The daemon's sessions. */
  readonly sessions: {
    /** As `GET /api/sessions` lists them. */
    list(): AdminSession[];
    /** One this daemon has run or registered: its log, a lane, a pinned agent or launch. */
    known(sessionKey: string): boolean;
    /** The agent a session runs: its lane's, else the one recorded for it. */
    agentOf(sessionKey: string): string | undefined;
  };
  /** The daemon's status, as `GET /api/status` shows it. */
  status(): AdminStatus;
  /** The daemon is stopping: start no new work (the module's `stop` comes next). */
  stopping(): boolean;
  /**
   * The deployment's policy as lanes see it (a connected host's hooks over the local ones), frozen:
   * a module asks it, it never sets it (assigning a hook throws, and changes nothing the lanes use).
   */
  readonly policy: Policy;
  /** Small values of the module's own, kept across restarts (the host's records, under `module:<id>:`). */
  readonly records: {
    get(name: string): string | undefined;
    /** Undefined removes it. */
    set(name: string, value: string | undefined): void;
  };
  /**
   * The session log's database (the daemon's SQLite file), shared with the host: name tables
   * `module_<id>_…` (dots and dashes as `_`). In memory, lost at stop, when the log is not a SQLite file.
   * Not a narrowed view: nothing checks the table names, and the host's own tables are there too
   * (the outbox, the routing records, launched sessions' env values, which are secret: never read,
   * log or change another's tables). The built-in `strangers` module keeps its older names
   * (`daemon_stranger_asks`, `daemon_guests`).
   */
  readonly db: KernelDatabase;
  /** Topics of flat conversations. */
  readonly topics: {
    /** The topic a session is, if it is one. */
    bySession(sessionKey: string): Topic | undefined;
    /** The topics of the conversation a session is a topic of (newest activity first); empty when it is not one. */
    siblings(sessionKey: string): Topic[];
    /**
     * Where a topic's title comes from: `auto` (made from its first message, or by a module's
     * `setAutoTitle`) or `explicit` (given: `/new <title>`, `topic.switch` with a title, the
     * model's `session_rotate`); undefined for no such topic.
     */
    titleSource(topicId: string): 'auto' | 'explicit' | undefined;
    /**
     * Give a topic a generated title, which stays `auto`: only while its title is still `auto` and
     * still `expected` (what the module read before it made one: a title given or made meanwhile
     * wins), so a result that comes back late never overwrites a name. Then the latest card of the
     * topic's session is edited on each channel to carry it (a card header: Lark). False when
     * nothing changed (also for the same title). U20: where an `outbound.scoped` host checks the
     * topic (its conversation is in scope, or its session had a checked turn), the title is asked of
     * that host first (`kind: title`, for `turnId`, the turn it was made after), and kept only when
     * it answers `allow`; the host away is a hold.
     */
    setAutoTitle(topicId: string, expected: string | undefined, title: string, turnId?: string): Promise<boolean>;
    /**
     * Hand the running turn `turnId` of a topic session to a new topic of its conversation
     * (`title`; current from now on), `summary` (what the new topic should know) saved on the topic
     * left and handed ahead of the turn's messages: the kernel's handover, which then moves the
     * conversation's messages still queued behind the turn. The kernel holds TP-1 whoever asks: a
     * turn is handed over once (by `rotate` or `switch`; the same `operationId` again, a retry,
     * answers what that one did, also while it is in flight; another is refused), only while its
     * topic is the conversation's current one, only with a message of its own (not only context
     * items), and never when all its messages were just handed here (no ping-pong). Throws an error
     * named `ToolError`, the reason for the model, when one of these refuses, the session is no
     * topic or the handover fails (the conversation then stays where it was, and the turn may try
     * again); and when `turnId` is not the turn running there.
     */
    rotate(sessionKey: string, turnId: string, a: { title: string; summary: string; operationId: string }): Promise<ModuleTopicHandover>;
    /**
     * Hand the running turn `turnId` of a topic session to another topic of the same conversation and
     * agent (`topicId`), current again; its harness session resumes. Throws as `rotate` (TP-1 the
     * same), also for a topic of another conversation or agent and for the topic the turn runs in.
     */
    switch(sessionKey: string, turnId: string, a: { topicId: string; operationId: string }): Promise<ModuleTopicHandover>;
  };
  /**
   * Watches as a session's agent (the watch tools): the agent of `sessionKey` acts (kind `agent`,
   * evidence `daemon`, declared `session:<sessionKey>`; never an owner), and `Policy.watch` decides
   * as for any agent (the default policy: only `policy.watchAllowlist` sources).
   */
  readonly watches: {
    /** Create or replace a watch delivering into the session (its `target` is set to the session, whatever the draft says). */
    add(sessionKey: string, draft: WatchDraft): Promise<KernelWatchResult>;
    /** Remove a watch as the session's agent (one it may remove: its own). */
    remove(sessionKey: string, id: string): Promise<KernelUnwatchResult>;
    /** The watches delivering into the session. */
    list(sessionKey: string): Watch[];
  };
  /**
   * Schedules (docs/design/schedules; SC-1..SC-3): the kernel keeps and fires them (a turn in a
   * session, a message through the outbox, an item for the host); a module sets them as a session's
   * agent (the schedule tools) or as a peer (an external MCP client), never as the owner or a host.
   */
  readonly schedules: {
    /**
     * Set or replace a schedule as the session's agent (kind `agent`, `session:<sessionKey>`): a turn
     * only into the session itself, never one for the host, at most `policy.scheduleLimit` of them,
     * none firing more often than `policy.scheduleMinMinutes`, only its own replaced (SC-3). One with a
     * `route` (a message's destination, or where the turn's answer goes) only while the session's
     * turn `turnId` runs and may send there (`Policy.outbound`, as for an output tool's message);
     * otherwise `forbidden`.
     */
    add(sessionKey: string, draft: ScheduleDraft, turnId?: string): Promise<KernelScheduleResult>;
    /** Remove a schedule as the session's agent: only one it set (`forbidden` otherwise). */
    remove(sessionKey: string, id: string): Promise<KernelUnscheduleResult>;
    /** The schedules of a session: turns into it, and the ones its agent set. */
    list(sessionKey: string): ScheduleView[];
    /**
     * Set or replace a schedule as a peer (`origin.kind: "peer"`, an agent outside this daemon: an
     * external MCP client): messages, and wakes handed to the host (`action: "host"` with
     * `meta.wake`), never a turn here; only its own replaced. Any other origin, a principal with the
     * `owner` label and one of the owners throw. The schedule is the module's peer's (`module` is the
     * module's id): it fires only through this module, as the peer, a message through
     * `ModuleHooks.scheduledMessage`, a wake through `ModuleHooks.scheduledWake`; while the module is
     * off, or does not act for the peer, its firings fail and nothing goes out, and the schedule is
     * kept (a one-shot at that time, fired at the next start as a missed one) (SC-3).
     */
    addAs(origin: Origin, draft: ScheduleDraft): Promise<KernelScheduleResult>;
    /** Remove a schedule as a peer: only one it set. Throws for the origins `addAs` refuses. */
    removeAs(origin: Origin, id: string): Promise<KernelUnscheduleResult>;
    /** The schedules `origin`'s principal set. */
    listAs(origin: Origin): ScheduleView[];
  };
  /**
   * The live (realtime voice) mechanism of a session's harness (decision 11): its protocol, events
   * and LN invariants are the kernel's; the module only asks. Errors the model should read are named
   * `ToolError`.
   */
  readonly live: {
    /**
     * Join a live for the running turn `turnId` of the session: on `channel` (a channel id or
     * `channel:account`; default the turn's reply channel), `target` in the channel's terms, the
     * voice told `instructions` (default the kernel's), speaking with `voice`. At most one per
     * session; the destination goes through the outbound check (DL-5). Throws when `turnId` is not
     * the turn running there.
     */
    join(sessionKey: string, turnId: string, a: { target: string; channel?: string; instructions?: string; voice?: string }): Promise<{ liveId: string; title: string; route: string }>;
    /** Say `text` in the session's live, once per `operationId` (also when retried; `explain` traces it to `turnId`, EX-2). */
    say(sessionKey: string, text: string, a: { operationId: string; turnId: string }): Promise<void>;
    /** Leave the session's live; false when none runs. */
    leave(sessionKey: string): Promise<boolean>;
    /**
     * The running channels that can open a live now (`ChannelAdapter.openLive`), as `id:account`,
     * in the order they started: a channel counts from its start until its `start` ends or it is
     * removed (also while it reconnects).
     */
    channels(): string[];
    /**
     * The sessions with a live running now, by key, in the order they joined. A live may outlive
     * the channel it opened on (the channel removed, its `start` ended): it runs, and is spoken in
     * and left, until one of its ends ends it (LN-4).
     */
    running(): string[];
  };
  /** The deployment's agents. */
  readonly agents: {
    /**
     * The agents a chat may talk to (`/agent`, `/new @agent`): the configured ones but task
     * agents, in config order; the default agent's name alone when there are none.
     */
    names(): string[];
    /**
     * The model tools an agent's sessions are offered now: its `agents.<name>.tools` list, or for
     * `tools: true` every tool the host's endpoint offers (the kernel's, then the active modules',
     * in that order), without those a module does not offer at the moment (`ModuleInstance.offeredTools`);
     * empty when it has none or no such agent runs. `undefined`: the default agent.
     */
    tools(agent: string | undefined): string[];
  };
  /** The binding tables' router. */
  readonly router: {
    /** Who a channel identity is (the identity maps: the config's, a host's, the modules' extra entries). */
    identify(a: IdentifyArgs): Promise<Identity>;
    /** This module's extra identity map entries (replacing its earlier ones, those of its `identities` hook too), below the configured and the host's. */
    setExtraIdentities(entries: IdentityEntry[]): void;
    /** A new topic of a flat conversation with an agent (current from now on); its id. */
    newTopic(agent: string, conversation: string, title?: string): string;
    /** The agent a flat conversation was switched to (`/agent`), if any. */
    conversationAgent(conversation: string): string | undefined;
    /** Switch a flat conversation to an agent (one of `agents.names()`; another throws): its inputs go to that agent's current topic from now on. */
    setConversationAgent(conversation: string, agent: string): void;
    /** Record how an input the module gives a lane itself (`lanes.input`) was placed: its routing record, what `explain <inputId>` shows. */
    record(e: RouteExplanation & { at: number }): void;
  };
  /** Sessions' lanes. */
  readonly lanes: {
    /** A lane is open for the session. */
    has(sessionKey: string): boolean;
    /** Open the session's lane (with this agent, for a new session). */
    open(sessionKey: string, agent?: string): Promise<void>;
    /**
     * A client command (input, interrupt, resolve, …) to a session, as from `origin`: a peer's, as
     * for `input` (any other origin rejects); the policy decides as for any client.
     */
    command(cmd: ClientCommand, origin: Origin): Promise<KernelOutcome>;
    /**
     * Give a session's lane an input the module stamped itself (opening the lane when it is not
     * open): a peer's (`origin.kind: "peer"`, an agent outside this daemon), with its own cause.
     * Any other kind, a principal carrying the `owner` label and one of the owners
     * (`policy.owners`) reject: a person's, a host's or the kernel's origin is the kernel's to give.
     * `channelContext.nativeCommand` and `loopGuard` are dropped (only the kernel sets them). The
     * lane decides as for any input (its loop guard may keep it as context: `observe_only`).
     * Throws an error with a `code` when the session cannot open (its agent is gone).
     */
    input(sessionKey: string, input: InputRecord, mode?: 'queue' | 'steer' | 'interrupt'): Promise<KernelInputResult>;
    /**
     * Take inputs a peer queued in a session back out of its queue before a turn takes them (a
     * prompt its client cancelled): recorded as `input.cancelled` with reason `withdrawn`, never
     * read by the agent. Only those of `inputIds` still queued whose origin is a peer's with
     * `origin`'s principal (CT-1: a caller cancels only what it queued itself); `origin` as for
     * `input` (any other kind, an owner-labelled principal and one of the owners reject). The ids
     * taken out: none when no lane is open, or a turn took them already.
     */
    withdraw(sessionKey: string, inputIds: string[], origin: Origin): Promise<string[]>;
    /**
     * What the module may run beside the open lane of a configured agent's session: an ephemeral
     * turn on the harness one of its turns ran on (topic titles). Undefined when no lane is open
     * for the session, for a task run's session, and when its agent is not a configured one (the
     * default agent of a deployment without `agents`).
     */
    harness(sessionKey: string): KernelLaneHarness | undefined;
  };
  /**
   * What a session's next turn runs, and what is set for the session over the agent's run (the
   * owner's run-config commands: `/preset`, `/model`, `/effort`, `/plan`, `/bypass`). The kernel
   * keeps what is set (its records, across restarts) and applies it over what the agent's policy
   * plans (`Policy.plan`), so it holds also while no module sets it. A preset is what the module
   * providing named run defaults gives for its name (`ModuleManifest.runDefaults`), asked when it applies.
   */
  readonly runConfig: {
    get(sessionKey: string): KernelSessionRun;
    /** From the session's next turn. */
    set(sessionKey: string, o: KernelRunOverrides): void;
    /** The presets the module providing named run defaults gives, in its order (none without one that is on). */
    presets(): KernelPreset[];
    /**
     * The configured harness instances that declare Plan mode (`plan`) or the owner's profile
     * switch, by display name (else instance name; each once); with none, the registered kinds
     * that declare it (`HarnessModule.declares`).
     */
    offering(cap: 'plan' | 'ownerProfileSwitch'): string[];
  };
  /** The running adapter that sends to a route (its channel and account), if any. */
  channelFor(route: { channel: string; account: string }): ChannelAdapter | undefined;
  /**
   * Where a send to `route` goes out: the route with the account of the running channel that sends
   * it (a channel id with a single entry takes a route naming another account, as a host's
   * `deliver` does), or why no running channel sends it (`message`: what is configured and what runs).
   */
  resolveRoute(route: ReplyRoute): { ok: true; route: ReplyRoute } | { ok: false; message: string };
  /**
   * Send a message on a route through the outbox: once per `operationId` (also across restarts),
   * settled in `sessionKey`'s log. Undefined when no running channel sends to the route.
   * `external`: the client outside the daemon it sends for; the outbound record and `explain`
   * name it, also when the send settles after a restart (EX-8). U20: the kernel says what the send is
   * (`delivery.settled.kind`): a client's message is `tool` (an `outbound.scoped` host checks it with
   * its content where its scope is: `held` or `rejected` then, never sent), any other the module's own
   * `notice` (the daemon's, not an agent's: no exit check).
   */
  send(route: ReplyRoute, msg: RenderedMessage, a: { operationId: string; sessionKey: string; turnId?: string; external?: ExternalSender }): Promise<KernelSendResult | undefined>;
  /** A send through the outbox by `operationId`, once it has settled (also before a restart). */
  settled(operationId: string): KernelSettledSend | undefined;
  /**
   * The outbound check of a send that is no turn's own reply (DL-6; `from`: who asks, as a
   * one-input turn of the module's own log): a host that declared `outbound` decides, and while it
   * is away nothing goes; else the embedder's `Policy.outbound`; else it is allowed (the module's
   * own bounds, checked before, are the local allowance). U20: with `content`, a host that also
   * declared `outbound.content` gets it (`kind: tool`) and may take it: `{ hold: true }`, which the
   * module settles with `hold` (never sent). Without `content` the answer is never a hold.
   */
  outbound(from: TurnContext, to: ReplyRoute, content?: RenderedMessage): Promise<'allow' | 'deny' | KernelHold>;
  /**
   * Settle a send the outbound check held (U20, `outbound`'s `{ hold: true }`) as `held` without
   * sending it: once per `operationId` (an earlier outcome is answered as it was), in `sessionKey`'s
   * log (`delivery.settled`, `result: "held"`, `kind: tool` when `external` names the client).
   */
  hold(route: ReplyRoute, a: { operationId: string; sessionKey: string; external?: ExternalSender; reason?: string }): KernelSendResult;
  /**
   * The deployment's owner: the principals that are it (`policy.owners`, and `AGENTS_IO_OWNERS`),
   * and the one session every owner DM goes to (`policy.ownerSessionKey`), when the deployment fixes one.
   */
  owner(): { principals: string[]; sessionKey?: string };
  /** The owner's own chat with the deployment (no reply target), while known. */
  ownerRoute(): ReplyRoute | null;
  /**
   * Deliver a held input to the session the binding table places it in (or `session` scope, or
   * `agent`), with its original origin, as the host's `inbound.redispatch` does; `by` is recorded.
   * Refused when it cannot be placed, or by the session's lane (`code: "refused"`, its reason).
   */
  redispatch(item: InboundItem, o: { by: string; session?: SessionScope; agent?: string }): Promise<{ ok: true; sessionKey: string; inputId: string } | { ok: false; code: string; message: string }>;
  /** `aio explain`: a routing record, a side effect by operationId, or (`chain`) an agent input's chain. */
  explain(inputId: string, chain?: boolean): KernelOutcome;
  /** The connected host (the local socket's host role). */
  readonly host: {
    connected(): boolean;
    /** It answers this policy callout (`route`, `resolve`, `review`, `outbound`, `contact`, `external`). */
    answers(hook: string): boolean;
    /** The host that last connected declaring `hook`, while it is not answering it: what that hook decides is denied until it is back. */
    heldBy(hook: 'outbound' | 'external'): string | undefined;
    /** Ask the host's `external` hook (while it `answers('external')`); throws when no valid answer comes in time. */
    external(args: ExternalCalloutArgs): Promise<ExternalCalloutAnswer>;
    /** Whether `token` is the host token (a module never gets the token itself). */
    isToken(token: string): boolean;
  };
}
