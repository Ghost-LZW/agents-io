import type { InputRecord } from './inbound.js';
import type { RunSpec, HarnessCaps } from './run.js';
import type { Decision } from './requests.js';
import type { HarnessEvent } from './events.js';
import type { LiveFramesFormat, LiveMedia } from './channel.js';

export interface HarnessOpenArgs {
  sessionKey: string;
  generation: number;
  cwd: string;
  /** Native session/thread id to resume. */
  resume?: string;
  run: RunSpec;
  /** Host MCP endpoint the harness should mount (outbound tools etc.). */
  mcp?: { url: string; token: string; transport?: 'http' | 'sse' };
  /** Harness-specific options from deployment config. */
  options?: Record<string, unknown>;
  /**
   * Extra child-process environment for this session, over the adapter's own. Never logged or
   * put on argv. A launched session's env (decision 7) comes here only when the adapter declares
   * `sessionEnv: 'open'` (the default); otherwise it goes to `ownProcess` or the launch is refused
   * (`HarnessAdapter.sessionEnv`). A built-in adapter gets nothing else here: its instance's env
   * and a task run's are part of how the host builds it. A module harness (`HarnessFactory`) runs
   * in the host's process, so its opens also carry its instance's env here, with a task run's env
   * (at least `AGENTS_IO_RUN_ID`) over it, whatever `sessionEnv` says, also the opens of an
   * adapter its `ownProcess` returned: such an `open` takes them.
   */
  env?: Record<string, string>;
  /**
   * The agent's instructions for this session, in the harness's own way: Claude Code appends
   * them to its preset system prompt, Codex gives them as developer instructions. They replace
   * whatever native instruction option the deployment config sets.
   */
  instructions?: string;
}

/**
 * Read access to the host's blob store (the media channels put: `ContentBlock.ref`), for a
 * harness that hands images and files to its agent.
 */
export interface BlobAccess {
  /** Local path, mime and size of a stored blob; `undefined` for a ref the store does not hold (a platform ref such as `lark-file:…`). */
  stat(ref: string): Promise<{ path: string; mime: string; name?: string; size: number } | undefined>;
  /** The stored bytes; throws for a ref the store does not hold. */
  get(ref: string): Promise<{ bytes: Uint8Array; mime: string; name?: string }>;
}

/**
 * How an adapter honours a launched session's own env (decision 7):
 * - `'open'`: it comes in `HarnessOpenArgs.env`, and `open` applies it to that session's own
 *   child (Claude Code).
 * - `'own-process'`: one process serves every session, so a launched session's env never comes
 *   through `open` (Codex's refuses a non-empty one); such a session runs on `ownProcess({ env })`
 *   instead (Codex over stdio).
 * - `{ refused }`: neither, e.g. a shared server that outlives the host (Codex over a Unix
 *   socket). A launch with env is refused (`launch_unsupported`: "harness instance <name> is
 *   <refused>; …"); a cwd alone is fine.
 * Only a launched session's env follows it: a module harness's opens carry its instance's env and
 * a task run's in `HarnessOpenArgs.env` whatever it declares.
 */
export type SessionEnvSupport = 'open' | 'own-process' | { readonly refused: string };

/** Start a realtime voice session on the harness session's native thread (decision 11). */
export interface LiveStartArgs {
  liveId: string;
  /**
   * WebRTC: the far side's offer; the answer comes back from `start`. Frames: the
   * far side's frames arrive on `media.frames`, the harness sends its audio (at
   * `audio.rate`) with `media.send`.
   */
  transport: { type: 'webrtc'; sdp: string } | ({ type: 'frames'; media: LiveMedia } & LiveFramesFormat);
  /** Instructions for the voice side (spoken style, what to delegate). */
  instructions?: string;
  voice?: string;
  /**
   * The run turns the harness starts by itself for delegations begin under (decision 11
   * amendment): the session layer's floor, `Policy.plan` over no inputs (the default policy:
   * `restricted`). A harness that can set its native thread's defaults applies it while the
   * live runs, also again after each turn the host started (whose own run may differ and may
   * persist on the thread), and reports in `turn.started.run` of each delegated turn the run it
   * actually began under, so the session layer can stop one that began wider than planned.
   */
  delegationRun?: RunSpec;
}

export type LiveTransport = 'webrtc' | 'frames';

/**
 * Realtime voice on the session's thread. The harness emits `live.transcript`,
 * `live.handoff` (each delegation, before the turn it starts) and `live.ended`.
 */
export interface HarnessLive {
  /** Transports `start` takes (default `['webrtc']`); the gateway refuses an endpoint of any other. */
  readonly transports?: LiveTransport[];
  /** Takes video frames (frames transport); without it the gateway drops them. */
  readonly video?: boolean;
  /** The answer is required for webrtc only. */
  start(args: LiveStartArgs): Promise<{ answerSdp?: string }>;
  /** Have the voice side say this. */
  say(text: string): Promise<void>;
  /** End the voice session; `live.ended` follows. Idempotent. */
  stop(): Promise<void>;
}

export type SteerResult = 'steered' | 'stale' | 'not_steerable' | 'no_active_turn' | 'unsupported';

/**
 * Wraps a harness (Claude Code, Codex, …) itself. Adapters translate, they never
 * run their own agent loop.
 */
export interface HarnessAdapter {
  readonly id: string;
  /** Version assertion; refuse to start on unknown versions. */
  probe(): Promise<{ version: string; caps: HarnessCaps }>;
  open(args: HarnessOpenArgs): Promise<HarnessSession>;
  /**
   * How to start the harness's own terminal UI as another client of an open session
   * (decision 15), when the harness has several clients per session (Codex: `--remote` on
   * the app-server). Undefined when it cannot, or no server is running yet.
   */
  nativeClient?(nativeId: string): NativeClient | undefined;
  /**
   * The host is stopping and this harness outlives it (e.g. Codex: its app-server keeps a
   * turn running for the next host, or dies with the host but must not be told to stop it).
   * End every session of this adapter without interrupting or unsubscribing anything and
   * without emitting more events, keep what a later `open({ resume })` needs, and close the
   * connections. With it the host detaches the sessions' lanes instead of closing them: a
   * running turn stays open in the session log, for the next host to adopt (`adopts`) or to
   * settle as ambiguous (`host_restarted`). Called once per adapter, bounded by the host's
   * stop timeout. Without it the host closes each session (`HarnessSession.close`).
   */
  detach?(): Promise<void>;
  /**
   * Shut this adapter's own processes down now, failing whatever session still runs on
   * them. The host calls it on an adapter it built for one launched session or task run
   * alone when that ends, and at stop on an adapter without `detach`, after its sessions
   * closed. Never on an adapter that `detach` was called on.
   */
  dispose?(): Promise<void>;
  /**
   * Static, answered without starting anything: after a host restart `open({ resume })` may
   * adopt (`turn.adopted`) a turn the previous host left running, because the harness
   * outlived it (Codex over a Unix socket). A restarted host reopens such sessions at start;
   * others' leftover turns are settled ambiguous (`host_restarted`) without opening the
   * harness. Only meaningful with `detach`.
   */
  readonly adopts?: boolean;
  /**
   * Static, like `adopts`: the harness's name in user-facing texts (chat command replies),
   * e.g. "Codex". Without it the host names it by its instance.
   */
  readonly displayName?: string;
  /**
   * Static: the session compacts its context when a turn's one input is this command, handed
   * to the harness as it is (`channelContext.nativeCommand`), e.g. Claude Code `/compact`.
   * The host's `session.compact` and the owner's `/compact` start such a turn; without it both
   * answer `unsupported`.
   */
  readonly compact?: { readonly command: string };
  /**
   * Static: the collaboration modes `RunSpec.mode` selects on this harness besides `default`
   * (Codex: `['plan']`). The owner's `/plan` and the Plan line of `/status` need `plan` here;
   * without it `/plan` answers that it is unavailable.
   */
  readonly modes?: readonly 'plan'[];
  /**
   * Static: the owner may switch the permission profile of their own turns in a session
   * between `bypass` and `restricted` (`/bypass`). Without it `/bypass` answers that it is
   * unavailable, whatever profiles the harness maps (Codex declares it; Claude Code does not).
   */
  readonly ownerProfileSwitch?: boolean;
  /**
   * Static: `open` takes `options.ephemeral` (a throwaway session kept out of the harness's
   * history), `options.preface: false`, instructions of the caller's (`instructions`) and a
   * read-only `options.profiles` entry (`approvalPolicy`, `sandbox`), so the host runs a module's
   * ephemeral turns on it (`KernelLaneHarness.ephemeralTurn`; the daemon's topic titles module
   * `topic-title`, which a host may turn off, is one). The options are Codex's shape. Codex
   * declares it.
   */
  readonly ephemeralOpen?: boolean;
  /**
   * Static: how a launched session's env reaches its harness (`SessionEnvSupport`). Default
   * `'open'`. `'own-process'` needs `ownProcess`.
   */
  readonly sessionEnv?: SessionEnvSupport;
  /**
   * An adapter like this one on a process of its own, for one launched session
   * (`sessionEnv: 'own-process'`: `env` is the session's, the top layer of that process's
   * environment, so it may name another config dir) or one task run. A task run always runs on
   * one when the adapter has this method, whatever `sessionEnv` says: the host builds the
   * instance's adapter for the run, the run's env (at least `AGENTS_IO_RUN_ID`) joined to the
   * instance's own and so under its configured config dir, and calls `ownProcess({ env: {} })`
   * on it. Starts nothing until its first `open`. The host keeps the result for that session or
   * run (the session layer compares adapters by identity) and calls its `dispose` when the
   * session's lane closes or the run ends. `cwd` is where that session or run works (its opens
   * say so too).
   */
  ownProcess?(o: { env: Record<string, string>; cwd?: string }): HarnessAdapter;
}

/** A command that starts a harness's terminal UI attached to a running session. */
export interface NativeClient {
  command: string;
  args: string[];
  /** Over the caller's environment (e.g. CODEX_HOME), never secrets. */
  env?: Record<string, string>;
}

export interface HarnessSession {
  /** Native session/thread id once known; the host persists it for resume. */
  nativeId(): string | undefined;
  /** Start a turn. Must only be called when idle; the session layer owns the queue. */
  startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void>;
  steer(inputs: InputRecord[], expectedTurnId: string): Promise<SteerResult>;
  cancelQueued?(inputIds: string[]): Promise<void>;
  /** Add context without starting a turn (caps.injectWithoutTurn). */
  inject?(inputs: InputRecord[]): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  /**
   * Answer a request. Every opened request must be closed by a `request.resolved`
   * in the adapter's own stream, so the stream is checkable on its own: after
   * respond() emit `by: { kind: 'host' }`. The session layer records the real
   * resolver (auto, model, human) and drops the adapter's echo.
   */
  respond(requestId: string, decision: Decision): Promise<void>;
  /** Realtime voice on this session's thread, when the harness has it. */
  readonly live?: HarnessLive;
  /** Events in emission order. Ends when the session closes. */
  readonly events: AsyncIterable<HarnessEvent>;
  close(reason: string): Promise<void>;
}

/** Passed to a harness plugin's factory. */
export interface HarnessFactoryInit {
  /** The instance name (`harnesses.<name>`). */
  name: string;
  /** The entry's `config`, `env:NAME` values substituted; `undefined` when absent. */
  config: unknown;
  /** Daemon log, prefixed with the instance. */
  log(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown): void;
  /** Another configured instance's adapter (e.g. a text harness a voice harness hands its delegated turns to). */
  harness(name: string): HarnessAdapter;
  /**
   * The host's blob store, read-only (`stat` and `get`, nothing else; each works detached): what
   * the media blocks of inputs (`ref`) point at. The built-in adapters resolve images and files
   * with the same view; absent when the host has none.
   */
  blobs?: BlobAccess;
}

/**
 * What a harness plugin module exports (as `createHarness`, or as default), for a
 * `{ "use": "module" }` harness entry. Runs in the daemon's process; a rejection or
 * a throw fails the daemon's start. The adapter it returns serves every session of the
 * instance, task runs included, so the daemon never disposes it when one ends; it gets the
 * same lifecycle calls as a built-in adapter: at stop `detach` when it has one, else its
 * sessions are closed and then `dispose` is called; `adopts` is read at start. Every loaded
 * instance gets them, whether or not a session used it; an adapter returned for several
 * instances gets each call once. Its other static declarations (`displayName`, `compact`,
 * `modes`, `ownerProfileSwitch`, `ephemeralOpen`, `sessionEnv`) and `ownProcess` are read as a
 * built-in adapter's; they and the lifecycle members are checked when the factory returns, and
 * one of the wrong type fails the start. Its opens, the opens of an adapter its `ownProcess`
 * returned included, carry the instance's env in `args.env`, a task run's over it, and a launched
 * session's only with `sessionEnv: 'open'`; and the agent's instructions in `args.instructions`,
 * during a transition also as `options.developerInstructions`, as before `instructions` existed.
 * `init.blobs` reads the media inputs point at (`stat` and `get`, nothing else). The module may
 * export a `HarnessModule` descriptor instead (`harness-module.ts`): its `create` gets this init too.
 */
export type HarnessFactory = (init: HarnessFactoryInit) => HarnessAdapter | Promise<HarnessAdapter>;
