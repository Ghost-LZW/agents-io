import type { Static, TSchema } from '@sinclair/typebox';
import type { AdminSession, AdminStatus } from './admin.js';
import type { AdminContribution } from './admin-module.js';
import type { ChannelAdapter, RenderedMessage } from './channel.js';
import type { ClientCommand, WatchDraft } from './client.js';
import type { ReplyRoute } from './common.js';
import type { Audience, Level, SessionEvent } from './events.js';
import type { HarnessAdapter } from './harness.js';
import type { ExternalCallout, ExternalCalloutAnswer, ExternalSender, IdentityEntry, InboundItem, RouteExplanation, SessionScope } from './host.js';
import type { InboundEnvelope, InputRecord, Origin } from './inbound.js';
import type { IdentifyArgs, Identity, Policy, TurnContext, TurnDraft } from './policy.js';
import type { Resolver } from './requests.js';
import type { RunSpec } from './run.js';
import type { Topic } from './topic.js';
import type { Watch } from './watch.js';

/*
 * A feature of the host as a module (core-slimming G6): what it adds to the deployment (a config
 * section, `host.hello` features, model tools, chat commands) and what it runs, registered by the
 * host's composition root (the daemon's `bundle.ts`). The host assembles its chat command table,
 * its model tool catalog and its `host.hello` features from its own entries and the active
 * modules' entries; a module that is off is not there at all (no tools, no commands, no
 * features). Built-in modules and a third party's are the same shape; `ModuleOrigin` tells them
 * apart in the host's status. Channel types and harness kinds keep their own contracts
 * (`ChannelModule`, `HarnessModule`).
 *
 * In progress: the daemon reads the manifest (`id`, `kind`, `needs`, `config`, `features`,
 * `mcpTools`, `commands`, `setup`) and, of the instance, `tools`, `commands`, `features`,
 * `status`, `start`, `stop` and the hooks `onTurnCompleted` and `inputHint`. `admin`, the other
 * `hooks` and `localFrames` are the contract the features that move into modules next need (G6
 * steps 4-6); until the daemon serves one, a module that sets it fails to register (`admin`) or to
 * set up (`hooks.<name>`, `localFrames`), naming it, rather than being silently ignored. The
 * built-in modules are the topic titles (step 2), the watch, live and topic tools (step 3) and the
 * external MCP endpoint (step 1).
 */

/** Where a registered module comes from: shipped with the host (`builtin`), or someone else's (`module`). */
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
  /** Fail the config with this message. Messages name keys and variables, never values. */
  fail(msg: string): never;
}

/**
 * A module's section of the host's config file: a top-level key (`section`) holding an object of
 * the module's own keys (`schema`) and `enabled`, which the host adds and owns; the host closes the
 * object (an unknown key is a config error). Present, the module is on unless `enabled` is
 * `false`; absent, the first alias path that is set decides instead (on or off: see `aliases`);
 * with neither, the module is on when `defaultEnabled`. A config change to a section or an alias
 * takes effect at the next start (the console answers `applied: "restart"`).
 */
export interface ModuleConfig<C = unknown> {
  /** The top-level key: ASCII letters, digits and `_`, starting with a letter; never one of the host's own keys. */
  readonly section: string;
  /** The section's own keys, in the order the schema lists them (not `enabled`: the host's). */
  readonly schema: Readonly<Record<string, TSchema>>;
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
   * The section's value (valid against `schema`, without `enabled`; `{}` when absent) or an alias's
   * value as it is there (an object keeps its `enabled`), as the module's settings; called only
   * when the module is on. Throwing (`ctx.fail`) fails the config.
   */
  resolve(raw: unknown, ctx: ModuleResolveContext): C;
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
  /** The running turn; always set for a tool that needs one (`ModuleToolDef.needsTurn`). */
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
  /** Its line in `/help` (`/name [args] — what it does`), after the host's own lines. */
  readonly help: string;
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

/** How a turn ended (`turn.completed.status`). */
export type ModuleTurnStatus = Extract<SessionEvent['body'], { t: 'turn.completed' }>['status'];

/**
 * What a module hooks into. The daemon serves `onTurnCompleted` and `inputHint`; a module that sets
 * any other fails to set up, naming it (see the file comment). Each says which feature it is for.
 */
export interface ModuleHooks {
  /** An input no rule dispatched and no host took (a stranger's message to be asked about). */
  onUndispatched?(a: { env: InboundEnvelope; origin: Origin; input: InputRecord }): void | Promise<void>;
  /** Clicks on buttons whose action id starts with `prefix` (the stranger cards' `aio:stranger:`). */
  onAction?: { prefix: string; handle(a: { actionId: string; env: InboundEnvelope; origin: Origin }): ModuleActionResult | undefined | Promise<ModuleActionResult | undefined> };
  /**
   * A turn of a session ended, whatever its status (not a task run's turn): called right after its
   * `turn.completed` is in the session's log, from when the daemon runs until it stops its modules,
   * for every module in registration order. Return at once (start the work, don't await it): a
   * throw or a rejected promise is logged, nothing else. Topic titles.
   */
  onTurnCompleted?(a: { sessionKey: string; turnId: string; status: ModuleTurnStatus }): void;
  /** A conversation's current topic changed. */
  onTopicChanged?(c: ModuleTopicChange): void;
  /** Who answers a turn's requests, before the local policy's resolver (asking the owner about a guest's turn). */
  resolver?(ctx: TurnContext): Resolver | undefined;
  /** The run of a session's next turn, over what the agent's policy planned (presets, the owner's overrides). */
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
  /** Lines `/status` adds for a session. */
  statusLines?(sessionKey: string): string[];
  /** Identity map entries next to the configured ones (guests). */
  identities?(): IdentityEntry[];
}

/** A local socket frame a module answers (`tui.attach`); not served yet. */
export type ModuleFrameHandler = (frame: Record<string, unknown>, from: { origin: Origin; host: boolean }) => Promise<KernelOutcome>;

/** What a module's `setup` returns: the handlers of what its manifest declares, and what it runs. */
export interface ModuleInstance {
  /** A handler for each of the manifest's `mcpTools`, by name (exactly those). */
  tools?: Readonly<Record<string, ModuleToolHandler>>;
  /** A handler for each of the manifest's `commands`, by name (exactly those). */
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
  /** `host.hello` features it adds while it runs (after the host's own); never one of the host's own. */
  readonly features?: readonly string[];
  readonly mcpTools?: readonly ModuleToolDef[];
  readonly commands?: readonly ModuleCommandDef[];
  /** Admin routes and console settings (G5's `AdminContribution`); not served for feature modules yet. */
  readonly admin?: AdminContribution;
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
  status: 'delivered' | 'rejected' | 'unknown';
  /** The platform's message id, when delivered. */
  providerMessageId?: string;
  error?: string;
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

/**
 * What a module gets of the kernel: narrow views of the host's core objects, each an existing
 * capability of the host (nothing a built-in feature could not already do). Late-bound: only `id`
 * and `log` work during `setup`; every other member throws until `setup` returned.
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
  /** The deployment's policy as lanes see it (a connected host's hooks over the local ones). */
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
     * nothing changed (also for the same title).
     */
    setAutoTitle(topicId: string, expected: string | undefined, title: string): boolean;
    /**
     * Hand the running turn `turnId` of a topic session to a new topic of its conversation
     * (`title`; current from now on), `summary` (what the new topic should know) saved on the topic
     * left and handed ahead of the turn's messages: the kernel's handover (TP-1), which then moves
     * the conversation's messages still queued behind the turn. Throws an error named `ToolError`,
     * the reason for the model, when the session is no topic or the handover fails (the
     * conversation then stays where it was); and when `turnId` is not the turn running there.
     */
    rotate(sessionKey: string, turnId: string, a: { title: string; summary: string }): Promise<ModuleTopicHandover>;
    /**
     * Hand the running turn `turnId` of a topic session to another topic of the same conversation and
     * agent (`topicId`), current again; its harness session resumes. Throws as `rotate`, also for a
     * topic of another conversation or agent.
     */
    switch(sessionKey: string, turnId: string, topicId: string): Promise<ModuleTopicHandover>;
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
  };
  /** The deployment's agents. */
  readonly agents: {
    /**
     * The model tools an agent's sessions are offered: its `agents.<name>.tools` list, or for
     * `tools: true` every tool the host's endpoint offers (the kernel's, then the active modules',
     * in that order); empty when it has none or no such agent runs. `undefined`: the default agent.
     */
    tools(agent: string | undefined): string[];
  };
  /** The binding tables' router. */
  readonly router: {
    /** Who a channel identity is (the identity maps: the config's, a host's, the modules' extra entries). */
    identify(a: IdentifyArgs): Promise<Identity>;
    /** This module's extra identity map entries (replacing its earlier ones), below the configured and the host's. */
    setExtraIdentities(entries: IdentityEntry[]): void;
    /** A new topic of a flat conversation with an agent (current from now on); its id. */
    newTopic(agent: string, conversation: string, title?: string): string;
    /** The agent a flat conversation was switched to (`/agent`), if any. */
    conversationAgent(conversation: string): string | undefined;
    /** Record how an input the module gives a lane itself (`lanes.input`) was placed: its routing record, what `explain <inputId>` shows. */
    record(e: RouteExplanation & { at: number }): void;
  };
  /** Sessions' lanes. */
  readonly lanes: {
    /** A lane is open for the session. */
    has(sessionKey: string): boolean;
    /** Open the session's lane (with this agent, for a new session). */
    open(sessionKey: string, agent?: string): Promise<void>;
    /** A client command (input, interrupt, resolve, …) to a session, as from `origin` (the policy decides as for any client). */
    command(cmd: ClientCommand, origin: Origin): Promise<KernelOutcome>;
    /**
     * Give a session's lane an input the module stamped itself (opening the lane when it is not
     * open): a peer's (`origin.kind: "peer"`; any other kind throws), with its own cause. The lane
     * decides as for any input (its loop guard may keep it as context: `observe_only`). Throws an
     * error with a `code` when the session cannot open (its agent is gone).
     */
    input(sessionKey: string, input: InputRecord, mode?: 'queue' | 'steer' | 'interrupt'): Promise<KernelInputResult>;
    /**
     * What the module may run beside the open lane of a configured agent's session: an ephemeral
     * turn on the harness one of its turns ran on (topic titles). Undefined when no lane is open
     * for the session, for a task run's session, and when its agent is not a configured one (the
     * default agent of a deployment without `agents`).
     */
    harness(sessionKey: string): KernelLaneHarness | undefined;
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
   * name it, also when the send settles after a restart (EX-8).
   */
  send(route: ReplyRoute, msg: RenderedMessage, a: { operationId: string; sessionKey: string; turnId?: string; external?: ExternalSender }): Promise<KernelSendResult | undefined>;
  /** A send through the outbox by `operationId`, once it has settled (also before a restart). */
  settled(operationId: string): KernelSettledSend | undefined;
  /**
   * The outbound check of a send that is no turn's own reply (DL-6; `from`: who asks, as a
   * one-input turn of the module's own log): a host that declared `outbound` decides, and while it
   * is away nothing goes; else the embedder's `Policy.outbound`; else it is allowed (the module's
   * own bounds, checked before, are the local allowance).
   */
  outbound(from: TurnContext, to: ReplyRoute): Promise<'allow' | 'deny'>;
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
