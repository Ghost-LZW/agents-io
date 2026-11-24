import { randomUUID } from 'node:crypto';
import type {
  Body,
  BodyType,
  Decision,
  HarnessEvent,
  HarnessOpenArgs,
  HarnessSession,
  InputRecord,
  ItemSummary,
  RunSpec,
  SteerResult,
} from '@agents-io/protocol';
import { PrefaceMemo } from '@agents-io/protocol';
import type { CanUseTool, EffortLevel, PermissionMode, PermissionUpdate, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { toTurnMessage } from './content.js';
import { AsyncQueue } from './queue.js';
import {
  QUESTION_TOOLS,
  inputSummary,
  itemTitle,
  mcpTool,
  itemType,
  oneLine,
  planSteps,
  preview,
  resultText,
  riskOf,
} from './tools.js';
import type {
  ClaudeCodeOptions,
  ClaudeProfile,
  PermissionResult,
  QueryLike,
  SDKMessage,
  SDKUserMessage,
} from './types.js';
import { IDLE_CONTINUE, READ_ONLY_TOOLS, WATCHDOG_CONTINUE } from './watchdog.js';

type Status = 'completed' | 'interrupted' | 'failed' | 'ambiguous';
type TurnError = { code: string; retryable: boolean; message?: string };
/** One message written to the CLI: a turn's inputs go as one (`toTurnMessage`), so a uuid stands for one or more inputs. */
type Written = { inputIds: string[]; message: SDKUserMessage };

interface ActiveTurn {
  turnId: string;
  run: RunSpec;
  /** uuid → inputIds of messages written to the CLI and not yet seen in `user_message_uuids`. */
  pending: Map<string, string[]>;
  interrupting: boolean;
  /** Any CLI output since the turn started. */
  sawActivity: boolean;
  /** The message written for each uuid in `pending` (the watchdog sends one the CLI had not started again). */
  sent: Map<string, SDKUserMessage>;
  /**
   * First-byte watchdog (HC-3): `armed` until the turn's first output (model stream, tool call, a CLI
   * result), `paused` while the CLI compacts, then `done`. Only while nothing can have happened yet.
   */
  wd?: 'armed' | 'paused' | 'done';
  wdTimer?: ReturnType<typeof setTimeout>;
  /**
   * The watchdog gave up the CLI attempt that held these uuids (`old`): that attempt's result is not
   * this turn's. Of them, `withdrawn` never reached the CLI's history and are sent again; the rest are
   * in its history already, so the CLI gets a short "go on" message (`cont`, no input of its own) instead.
   * While `switching` (from its interrupt until the new model is set or the chain is used up) a steer is
   * not written either: the idle CLI would start it on the model that hangs. It joins `withdrawn`.
   */
  retry?: { old: Set<string>; withdrawn: Set<string>; swallowed: boolean; switching: boolean; cont?: string; prevCont?: string };
  /** Idle deadline (HC-3b): this turn's tool calls in flight (tool_use seen, no result yet), id → tool name. */
  tools?: Map<string, string>;
  /** Tools of this turn that ran and may have changed something (not read-only, not declined). */
  effects?: string[];
  /** The CLI is compacting (a model call of its own, not a hang). */
  compacting?: boolean;
  /** A harness command (`/compact`): no model stream to time. */
  command?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Models the idle deadline already left in this turn (each at most once). */
  stalledOn?: Set<string>;
  /** The idle deadline ended the turn: it ends `failed` with this error, whatever the CLI's result says. */
  stalled?: TurnError;
  /**
   * The stalled turn's interrupt is taking follow-ups the CLI has not started out of its queue: a
   * result that arrives meanwhile ends the turn once that is settled (`finishLater`), so only what was
   * really withdrawn is left unconsumed. What the CLI sends after that result is its next run's, not
   * this turn's (a follow-up it dequeued meanwhile): held for the turn that adopts it (HC-3b).
   */
  withdrawing?: boolean;
  finishLater?: { status: Status; error?: TurnError };
  /** The stalled turn's CLI result came (else the interrupt's 5 s ended it, and the result may come late). */
  resulted?: boolean;
  /** Follow-ups the stalled turn's interrupt receipt listed as queued, not started (`still_queued`). */
  queued?: Set<string>;
  /**
   * The CLI's output named one of `queued`: it runs it as a run of its own, so the stalled turn's
   * run is over (also when its result never came) and what follows is held like after `finishLater`.
   */
  nextRun?: boolean;
  /** uuids the CLI showed it took in this turn (`user_message_uuid(s)` on its output): in its history. */
  took?: Set<string>;
  /** The CLI names the uuids it takes (absent from older producers: what it holds cannot be told apart). */
  echo?: boolean;
  /** Set when a CLI result arrived but inputs of this turn are still pending (a follow-up CLI turn will run them). */
  between?: { status: Status; error?: TurnError };
  usage?: unknown;
  finalText?: string;
}

interface OpenRequest {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  allowAlways: boolean;
  turnId?: string;
  resolve(r: PermissionResult): void;
  promise: Promise<PermissionResult>;
}

/** The uuids of the user messages a CLI message says it answers (`user_message_uuid(s)`). */
function named(m: SDKMessage): string[] {
  const r = m as { user_message_uuid?: unknown; user_message_uuids?: unknown };
  const us = Array.isArray(r.user_message_uuids) ? r.user_message_uuids : typeof r.user_message_uuid === 'string' ? [r.user_message_uuid] : [];
  return us.filter((u): u is string => typeof u === 'string');
}

const EPHEMERAL = new Set<BodyType>(['text.delta', 'item.progress', 'headline']);
/** How long the stalled turn waits for the CLI to give back a follow-up it has not started (then: carried). */
const WITHDRAW_WAIT_MS = 2000;
/** How long carried follow-ups wait for a turn that is given their inputs (then: given up, as strays). */
const CARRY_MS = 15_000;
const EFFORTS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function isEffort(e: string | undefined): e is EffortLevel {
  return e !== undefined && EFFORTS.has(e as EffortLevel);
}

function levelOf(b: Body): HarnessEvent['level'] {
  switch (b.t) {
    case 'native':
      return 'debug';
    case 'session.ready':
    case 'model.fallback':
    case 'permission.mode':
    case 'item.started':
    case 'item.completed':
    case 'item.progress':
    case 'plan.updated':
    case 'usage':
      return 'detail';
    case 'text.delta':
      return b.stream === 'answer' ? 'primary' : 'detail';
    default:
      return 'primary';
  }
}

function audienceOf(b: Body): HarnessEvent['audience'] {
  switch (b.t) {
    case 'text.delta':
      return b.stream === 'answer' ? 'answer' : 'commentary';
    case 'text.snapshot':
      return 'answer';
    case 'item.started':
    case 'item.completed':
    case 'item.progress':
    case 'plan.updated':
      return 'commentary';
    case 'request.opened':
    case 'request.resolved':
      return 'approval';
    case 'native':
      return 'internal';
    default:
      return 'status';
  }
}

export interface SessionInit {
  args: HarnessOpenArgs;
  options: ClaudeCodeOptions;
  profile: ClaudeProfile;
  /** Native session id known up front (resume id, or the id we asked the CLI to use). */
  sessionId: string;
  prompt: AsyncQueue<SDKUserMessage>;
  stderrTail: () => string;
  /** First-byte watchdog (absent: off). `fallbackModels` is read when it fires. */
  watchdog?: { timeoutMs: number; fallbackModels: () => string[] };
  /** Idle deadline within a turn (HC-3b; absent: off). `notice` is the answer of a turn it ends. */
  stall?: { timeoutMs: number; notice: string; fallbackModels: () => string[] };
  /** The permission mode the CLI was launched in (default: the profile's for `run.model`). */
  permissionMode?: PermissionMode;
}

/**
 * One Claude Code session. The CLI is driven through the Agent SDK's streaming input;
 * this class only translates. It never queues: the session layer calls `startTurn`
 * only when idle and `steer` only while a turn runs.
 */
export class ClaudeCodeSession implements HarnessSession {
  private readonly out = new AsyncQueue<HarnessEvent>();
  readonly events: AsyncIterable<HarnessEvent> = this.out;

  private q!: QueryLike;
  private sessionId: string;
  private turn: ActiveTurn | undefined;
  private model: string;
  /** Set while the session runs on a model the first-byte watchdog switched to (cleared once a turn's own model is back). */
  private watchdogModel: string | undefined;
  /** A switch `applyRun` made before `turn.started`, reported right after it. */
  private fellBack: { from: string; to: string; trigger: string } | undefined;
  private effort: string | undefined;
  private profile: ClaudeProfile;
  /** The CLI's permission mode now (HC-5): set at launch, at a turn's start, tightened on a model change within a turn. */
  private mode: PermissionMode;
  /**
   * The model the CLI moved the session to on its own and keeps (a refusal fallback of scope
   * `session`), until the next `setModel`: what a turn then really starts on (HC-5).
   */
  private cliModel: string | undefined;
  /** A mode `applyRun` set (or found) before `turn.started`, reported right after it (HC-5). */
  private modeNote: { mode: PermissionMode; previous: PermissionMode; model: string } | undefined;
  /** Unconsumed inputs of turns that already ended (interrupted / failed). */
  private stray = new Map<string, string[]>();
  /**
   * Follow-ups a turn the idle deadline ended left with the CLI unconfirmed (HC-3b): not withdrawn,
   * not named by a result. They are not consumed (the host re-queues them), and never written again
   * while the CLI may hold them: the next turn given their inputs adopts the uuid, so the CLI's run of
   * it is that turn's; one the CLI gives back late is written again then. uuid → inputIds.
   */
  private carried = new Map<string, string[]>();
  private carriedMsg = new Map<string, SDKUserMessage>();
  /** CLI messages that came while no turn ran and follow-ups were carried: replayed under the turn that adopts them. */
  private held: SDKMessage[] = [];
  private carryTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * uuids of a stalled turn the interrupt's 5 s ended before its CLI result came: output that names
   * only them is that run's, late — never the next turn's (its result would end that turn). Until
   * the CLI names anything else.
   */
  private owed: Set<string> | undefined;
  /** What the model was already shown in input prefaces; reset when it may have lost it. */
  private memo = new PrefaceMemo();
  private items = new Map<string, { item: ItemSummary; parentItemId?: string; turnId?: string }>();
  private requests = new Map<string, OpenRequest>();
  private declined = new Set<string>();
  /** The main thread's text of its current message: what it said so far (HC-3b's answer). */
  private msgText: { id: string; text: string } | undefined;
  /**
   * What the main thread said after its last tool call: the turn's answer when the CLI's result has
   * none (a turn that ended on a tool call, e.g. `send_message`, has none). Text before a tool call
   * was said along the way, not the answer.
   */
  private lastWords: { id: string; text: string } | undefined;
  private unownedActivity = false;
  private closing = false;
  private exited = false;
  private pumpDone: Promise<void> = Promise.resolve();
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly init: SessionInit) {
    this.sessionId = init.sessionId;
    this.model = init.args.run.model;
    this.effort = init.args.run.effort;
    this.profile = init.profile;
    this.mode = init.permissionMode ?? permissionModeFor(init.profile, init.args.run.model);
  }

  /** Called once by the adapter after `query()` returned. */
  attach(q: QueryLike): void {
    this.q = q;
    this.emit({ t: 'session.bound', nativeId: this.sessionId });
    if (this.effort !== undefined && !isEffort(this.effort))
      this.emit({ t: 'notice', code: 'other', message: `effort "${this.effort}" is not supported by Claude Code; ignored` });
    this.pumpDone = this.pump();
  }

  readonly canUseTool: CanUseTool = (toolName, input, opts) => {
    const existing = this.requests.get(opts.requestId);
    if (existing) return existing.promise; // redelivered after reinitialize: never open a second prompt

    const isQuestion = QUESTION_TOOLS.has(toolName);
    const allowAlways = !isQuestion && !opts.suppressAlwaysAllowRule && (opts.suggestions?.length ?? 0) > 0;
    let resolve!: (r: PermissionResult) => void;
    const promise = new Promise<PermissionResult>((r) => (resolve = r));
    const req: OpenRequest = {
      requestId: opts.requestId,
      toolName,
      toolUseId: opts.toolUseID,
      input,
      suggestions: opts.suggestions,
      allowAlways,
      turnId: this.turn?.turnId,
      resolve,
      promise,
    };
    this.requests.set(req.requestId, req);
    if (this.turn) this.idleClear(this.turn); // waiting on a person or a reviewer is not a stall

    const kind = isQuestion ? 'question' : itemType(toolName) === 'file_change' ? 'file_change' : 'tool_approval';
    const title = isQuestion
      ? `Question: ${inputSummary(toolName, input, 200) ?? toolName}`
      : opts.title
        ? oneLine(opts.title.replace(ANSI, ''), 200)
        : itemTitle(toolName, input);
    const parentItemId = this.items.get(opts.toolUseID)?.parentItemId;
    const questions = isQuestion && Array.isArray(input.questions)
      ? (input.questions as Array<Record<string, unknown>>).map((q, index) => ({
          id: String(index),
          text: String(q.question ?? ''),
          ...(typeof q.header === 'string' ? { header: q.header } : {}),
          ...(Array.isArray(q.options) ? { options: q.options.map((o) => ({ label: String((o as Record<string, unknown>).label ?? ''), ...((o as Record<string, unknown>).description ? { description: String((o as Record<string, unknown>).description) } : {}) })) } : {}),
          ...(q.multiSelect === true ? { multiSelect: true } : {}),
        }))
      : undefined;
    this.emit(
      {
        t: 'request.opened',
        requestId: req.requestId,
        kind,
        title,
        risk: riskOf(toolName, input, opts.blockedPath),
        allowedDecisions: isQuestion ? ['answer', 'deny'] : ['allow_once', ...(allowAlways ? ['allow_session'] : []), 'deny'],
        ...(questions ? { questions } : {}),
        allowAlways,
        defaultDeny: opts.defaultToNo === true,
      },
      {
        itemId: opts.toolUseID,
        ...(parentItemId ? { parentItemId } : {}),
        native: {
          toolName,
          input,
          suggestions: opts.suggestions,
          decisionReason: opts.decisionReason?.replace(ANSI, ''),
          blockedPath: opts.blockedPath,
          mcpServer: opts.mcpServer,
          displayName: opts.displayName,
          description: opts.description,
          agentID: opts.agentID,
          suppressAlwaysAllowRule: opts.suppressAlwaysAllowRule,
          defaultToNo: opts.defaultToNo,
        },
      },
    );

    const onAbort = () => this.cancelRequest(req, 'runtime_cancelled');
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    return promise;
  };

  nativeId(): string | undefined {
    return this.sessionId;
  }

  async startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void> {
    if (this.exited || this.closing) throw new Error('claude-code session is closed');
    if (this.turn) throw new Error(`startTurn(${turnId}) while turn ${this.turn.turnId} is active: the session layer owns the queue`);
    if (!inputs.length) throw new Error('startTurn needs at least one input');
    const r = run ?? this.init.args.run;
    const t: ActiveTurn = { turnId, run: r, pending: new Map(), interrupting: false, sawActivity: false, sent: new Map() };
    this.turn = t; // claim before any await so a concurrent startTurn fails
    // Carried follow-ups among the inputs (HC-3b): the CLI may still run them, so they are adopted
    // (their run is this turn's), not written again.
    const adopted = this.adopt(t, inputs);
    try {
      await this.applyRun(r);
      const rest = adopted.size ? inputs.filter((i) => !adopted.has(i.inputId)) : inputs;
      const msgs = rest.length ? await this.convert(rest, 'later') : [];
      this.emit({
        t: 'turn.started',
        turnId,
        inputIds: inputs.map((i) => i.inputId),
        replyRoute: inputs[0]?.replyRoute ?? null,
        run: r,
      });
      if (this.fellBack) this.emitFallback(this.fellBack.from, this.fellBack.to, this.fellBack.trigger);
      this.fellBack = undefined;
      if (this.modeNote) this.emitMode(this.modeNote.mode, this.modeNote.previous, this.modeNote.model, 'turn_start');
      this.modeNote = undefined;
      this.unownedActivity = false;
      this.msgText = undefined;
      this.lastWords = undefined;
      this.write(t, msgs);
      // A harness command (`/compact`) runs in the CLI with no model stream to wait for.
      t.command = inputs.some((i) => i.channelContext.nativeCommand === true);
      if (!t.command) this.arm(t);
      this.idleArm(t);
      // What the CLI already sent of an adopted follow-up's run is this turn's.
      this.replayHeld();
    } catch (err) {
      if (this.turn === t) {
        this.turn = undefined;
        for (const [u, ids] of t.pending) {
          const m = t.sent.get(u);
          if (!m || !adopted.has(ids[0]!)) continue;
          this.carried.set(u, ids);
          this.carriedMsg.set(u, m);
        }
      }
      this.fellBack = undefined;
      this.modeNote = undefined;
      this.memo.reset();
      throw err;
    }
  }

  async steer(inputs: InputRecord[], expectedTurnId: string): Promise<SteerResult> {
    const t = this.turn;
    if (!t) return 'no_active_turn';
    if (t.turnId !== expectedTurnId) return 'stale';
    if (t.interrupting) return 'not_steerable';
    const msgs = await this.convert(inputs, 'next');
    // Rendered but not written: the model never saw these prefaces.
    if (this.turn !== t || t.interrupting) this.memo.reset();
    if (this.turn !== t) return this.turn ? 'stale' : 'no_active_turn';
    if (t.interrupting) return 'not_steerable';
    if (t.retry?.switching) this.hold(t, t.retry, msgs);
    else this.write(t, msgs);
    return 'steered';
  }

  async cancelQueued(inputIds: string[]): Promise<void> {
    const want = new Set(inputIds);
    const t = this.turn;
    if (t) {
      // A message stands for all its inputs: withdrawn only when every one of them is cancelled.
      const uuids = [...t.pending].filter(([, ids]) => ids.every((id) => want.has(id))).map(([u]) => u);
      await this.cancelPending(t.pending, uuids, 'cancelled', t);
      this.maybeFinishWithoutResult(t);
    }
    const strays = [...this.stray].filter(([, ids]) => ids.every((id) => want.has(id))).map(([u]) => u);
    await this.cancelPending(this.stray, strays, 'cancelled');
    const carried = [...this.carried].filter(([, ids]) => ids.every((id) => want.has(id))).map(([u]) => u);
    if (carried.length) {
      await this.cancelPending(this.carried, carried, 'cancelled');
      for (const u of carried) if (!this.carried.has(u)) this.carriedMsg.delete(u);
      if (!this.carried.size) this.giveUpCarried();
    }
  }

  async interrupt(turnId: string, o: { keepQueued?: boolean } = {}): Promise<void> {
    const t = this.turn;
    if (!t || t.turnId !== turnId) return;
    t.interrupting = true;
    this.disarm(t);
    this.idleClear(t);
    // `keepQueued` (the idle deadline ending a turn that changed something): what the CLI still holds
    // is withdrawn but not cancelled — it stays unconsumed and the session layer runs it as the next
    // turn. A result that comes before the receipt waits for that (`finishLater`).
    if (o.keepQueued) t.withdrawing = true;
    let receipt: Awaited<ReturnType<QueryLike['interrupt']>>;
    try {
      receipt = await this.q.interrupt();
    } catch (err) {
      if (o.keepQueued) this.settleWithdraw(t, false);
      throw err;
    }
    // Inputs the CLI still holds would run as a fresh turn after the interrupt: withdraw ours.
    const still = (receipt?.still_queued ?? []).filter((u) => t.pending.has(u));
    if (o.keepQueued) t.queued = new Set(still);
    if (o.keepQueued) await this.withdrawPending(t, still);
    else await this.cancelPending(t.pending, still, 'interrupted', t);
    // The watchdog's "go on" message, if the CLI has not started it either.
    const cont = t.retry?.cont;
    if (cont && receipt?.still_queued?.includes(cont) && (await this.withdraw(cont)) && t.retry?.cont === cont) t.retry.cont = undefined;
    this.maybeFinishWithoutResult(t);
  }

  async respond(requestId: string, decision: Decision): Promise<void> {
    const req = this.requests.get(requestId);
    if (!req) return; // already answered (first wins) or cancelled by the CLI
    this.requests.delete(requestId);
    const result = this.toPermissionResult(req, decision);
    if (result.behavior === 'deny') this.declined.add(req.toolUseId);
    req.resolve(result);
    this.emit(
      { t: 'request.resolved', requestId, decision, by: { kind: 'host' } },
      req.turnId && this.turn?.turnId === req.turnId ? { turnId: req.turnId } : { turnId: undefined },
    );
    if (this.turn) this.idleArm(this.turn);
  }

  async close(_reason: string): Promise<void> {
    if (this.closing) return this.pumpDone;
    this.closing = true;
    if (this.carried.size) this.giveUpCarried();
    const t = this.turn;
    if (t && !this.exited) {
      await Promise.race([this.interrupt(t.turnId).catch(() => undefined), delay(2000)]);
      await Promise.race([this.whenIdle(), delay(3000)]);
    }
    this.init.prompt.close();
    await Promise.race([this.pumpDone, delay(3000)]);
    try {
      this.q.close();
    } catch {
      // already gone
    }
    await this.pumpDone;
  }

  // ---- internals ----------------------------------------------------------

  private async applyRun(r: RunSpec): Promise<void> {
    if (r.model !== this.model) {
      try {
        await this.q.setModel(r.model);
        this.model = r.model;
        this.watchdogModel = undefined;
        this.cliModel = undefined;
      } catch (err) {
        // Back from a watchdog switch: Claude Code checks the model with a request first, and a
        // model that still hangs fails that check. Stay on the fallback for this turn (and say so)
        // rather than fail the turn; the next one tries its own model again.
        if (this.watchdogModel === undefined || this.watchdogModel !== this.model) throw err;
        this.emit({ t: 'notice', code: 'other', message: `${r.model} did not answer the model check; this turn stays on ${this.model}` });
        this.fellBack = { from: r.model, to: this.model, trigger: 'model_check_failed' };
      }
    }
    if (r.effort !== this.effort) {
      if (r.effort === undefined || isEffort(r.effort)) {
        await this.q.applyFlagSettings({ effortLevel: r.effort ?? null });
      } else {
        this.emit({ t: 'notice', code: 'other', message: `effort "${r.effort}" is not supported by Claude Code; ignored` });
      }
      this.effort = r.effort;
    }
    const want = this.init.options.profiles?.[r.profile] ?? defaultProfile(r.profile);
    if (want !== this.profile && !sameTools(want, this.profile)) {
      throw new Error(
        `profile "${r.profile}" changes tool permissions; Claude Code fixes them at launch, reopen the session instead`,
      );
    }
    this.profile = want;
    // HC-5: the mode of the model this turn really starts on (a fallback it stays on included).
    const model = this.cliModel ?? this.model;
    const mode = permissionModeFor(want, model);
    const previous = this.mode;
    if (mode !== previous) {
      await this.q.setPermissionMode(mode);
      this.mode = mode;
    }
    if (want.bypassModels?.length) this.modeNote = { mode, previous, model };
  }

  /**
   * HC-5: the CLI moved to `model` within a turn. Leaving bypass for a model that does not bypass
   * happens at once; a model that may bypass never loosens the mode before the next turn's start.
   * When the CLI does not take the tighter mode the turn is stopped rather than run on in bypass.
   */
  private tighten(model: string, trigger: string): void {
    if (this.mode !== 'bypassPermissions' || !this.profile.bypassModels?.length) return;
    const mode = permissionModeFor(this.profile, model);
    if (mode === 'bypassPermissions') return;
    const previous = this.mode;
    this.mode = mode;
    const t = this.turn;
    void this.q.setPermissionMode(mode).then(
      () => this.emitMode(mode, previous, model, trigger),
      (err: unknown) => {
        this.emit({
          t: 'notice',
          code: 'other',
          message: `could not leave bypassPermissions on ${model} (${oneLine((err as Error)?.message ?? String(err), 160)}); the turn is stopped`,
        });
        if (t && this.turn === t) void this.interrupt(t.turnId).catch(() => undefined);
      },
    );
  }

  /** Same family as `system/model_fallback`: hosts record the mode a turn runs in (HC-5). */
  private emitMode(mode: PermissionMode, previous: PermissionMode, model: string, trigger: string): void {
    this.emit({ t: 'permission.mode', mode, previous, model, trigger }); // HC-6: for hosts
    this.native('system/permission_mode', {
      type: 'system',
      subtype: 'permission_mode',
      permission_mode: mode,
      previous_mode: previous,
      model,
      trigger,
      source: 'agents-io',
      session_id: this.sessionId,
    });
  }

  /**
   * The inputs as one message (HC-4): Claude Code runs each queued user message as a model request
   * of its own, so a turn's context records and its addressed inputs go together, each behind its
   * own preface, in order. A harness command (`/compact`) stays a message of its own.
   */
  private async convert(inputs: InputRecord[], priority: 'next' | 'later'): Promise<Written[]> {
    const opts = {
      priority,
      resolveImage: this.init.options.resolveImage,
      resolveFile: this.init.options.resolveFile,
      clientComposed: this.init.options.clientComposed,
      memo: this.memo,
    };
    const groups = inputs.some((i) => i.channelContext.nativeCommand === true) ? inputs.map((i) => [i]) : [inputs];
    const out: Written[] = [];
    for (const g of groups) {
      const { message, notices } = await toTurnMessage(g, opts);
      for (const n of notices) this.emit({ t: 'notice', code: 'other', message: n });
      out.push({ inputIds: g.map((i) => i.inputId), message });
    }
    return out;
  }

  private write(t: ActiveTurn, msgs: Written[]): void {
    for (const { inputIds, message } of msgs) {
      t.pending.set(message.uuid!, inputIds);
      t.sent.set(message.uuid!, message);
      this.init.prompt.push(message);
    }
  }

  /** A steer that came while the watchdog switches models: written once the new model is set (as if withdrawn). */
  private hold(t: ActiveTurn, retry: NonNullable<ActiveTurn['retry']>, msgs: Written[]): void {
    for (const { inputIds, message } of msgs) {
      t.pending.set(message.uuid!, inputIds);
      t.sent.set(message.uuid!, message);
      retry.withdrawn.add(message.uuid!);
    }
  }

  private async cancelPending(from: Map<string, string[]>, uuids: string[], reason: string, t?: ActiveTurn) {
    const fn = this.q.cancelAsyncMessage;
    if (!fn || !uuids.length) return;
    const cancelled: string[] = [];
    for (const u of uuids) {
      try {
        if (await fn.call(this.q, u)) {
          const ids = from.get(u);
          from.delete(u);
          if (ids) cancelled.push(...ids);
        }
      } catch {
        // already dequeued: it will be consumed (or swept) by the CLI
      }
    }
    if (cancelled.length) {
      this.memo.reset();
      this.emit(
        { t: 'input.cancelled', inputIds: cancelled, reason },
        t && this.turn === t ? { turnId: t.turnId } : { turnId: undefined },
      );
    }
  }

  /**
   * Takes messages the CLI has not started out of its queue without cancelling their inputs: they
   * stay unconsumed, and the session layer runs them as the next turn (`STALL_REQUEUE_CODE`). One the
   * CLI does not give back (dequeued, or no answer in time) stays pending: the stalled turn's `finish`
   * carries it (or counts it consumed when the CLI showed it took it), so it is never run twice, and
   * one given back late is written again by the turn that adopted it (`gaveBack`).
   */
  private async withdrawPending(t: ActiveTurn, uuids: string[]): Promise<void> {
    let any = false;
    t.withdrawing = true;
    try {
      const waitMs = this.init.options.idleWithdrawWaitMs ?? WITHDRAW_WAIT_MS;
      for (const u of uuids) {
        if ((await this.withdrawWithin(u, waitMs)) !== 'gone') continue;
        // Given back after the turn ended (the interrupt's 5 s): carried or adopted by then.
        if (!t.pending.has(u)) {
          this.gaveBack(u);
          continue;
        }
        t.pending.delete(u);
        t.sent.delete(u);
        any = true;
      }
    } finally {
      this.settleWithdraw(t, any);
    }
  }

  /** The stalled turn's withdraws are settled: a result that came meanwhile ends it now. */
  private settleWithdraw(t: ActiveTurn, withdrew: boolean): void {
    t.withdrawing = false;
    if (withdrew) this.memo.reset(); // their prefaces never reached the model
    const later = t.finishLater;
    t.finishLater = undefined;
    if (later) this.finish(t, later.status, later.error);
    else if (t.nextRun) this.finish(t, 'failed', t.stalled);
  }

  /** `withdraw` that stops waiting after `waitMs` (`late`); a late answer that gives it back is handled then. */
  private async withdrawWithin(uuid: string, waitMs: number): Promise<'gone' | 'kept' | 'late'> {
    const p = this.withdraw(uuid);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((r) => {
      timer = setTimeout(() => r('late'), waitMs);
      timer.unref?.();
    });
    try {
      const r = await Promise.race([p.then((ok): 'gone' | 'kept' => (ok ? 'gone' : 'kept')), late]);
      if (r === 'late') void p.then((ok) => ok && this.gaveBack(uuid));
      return r;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The CLI gave back a follow-up after the stalled turn stopped waiting: it is not in the CLI. Still
   * carried: dropped, the turn given its inputs writes them. Adopted by the running turn: written
   * again there. Still pending on the stalled turn: left unconsumed (re-queued).
   */
  private gaveBack(uuid: string): void {
    if (this.carried.delete(uuid)) {
      this.carriedMsg.delete(uuid);
      this.memo.reset();
      if (!this.carried.size) this.giveUpCarried();
      return;
    }
    const t = this.turn;
    const ids = t?.pending.get(uuid);
    const m = t?.sent.get(uuid);
    if (!t || ids === undefined || !m) return;
    t.pending.delete(uuid);
    t.sent.delete(uuid);
    this.memo.reset();
    if (t.stalled) return;
    this.write(t, [{ inputIds: ids, message: { ...m, uuid: randomUUID() as SDKUserMessage['uuid'], timestamp: new Date().toISOString() } }]);
  }

  /** Carried follow-ups among a new turn's inputs become its pending messages (HC-3b); their inputIds. */
  private adopt(t: ActiveTurn, inputs: InputRecord[]): Set<string> {
    const given = new Set(inputs.map((i) => i.inputId));
    const adopted = new Set<string>();
    for (const [u, ids] of [...this.carried]) {
      const m = this.carriedMsg.get(u);
      if (!m || !ids.every((id) => given.has(id))) continue;
      this.carried.delete(u);
      this.carriedMsg.delete(u);
      t.pending.set(u, ids);
      t.sent.set(u, m);
      for (const id of ids) adopted.add(id);
    }
    if (!this.carried.size && this.carryTimer) {
      clearTimeout(this.carryTimer);
      this.carryTimer = undefined;
    }
    return adopted;
  }

  /** CLI messages held while follow-ups were carried and no turn ran, in the order they came. */
  private replayHeld(): void {
    for (const m of this.held.splice(0)) this.dispatch(m);
  }

  /**
   * No turn took the carried follow-ups (the host cancelled or rejected them): what the CLI holds of
   * them is a stray, cancelled where it can be, and what it sent meanwhile is replayed as unowned.
   */
  private giveUpCarried(): void {
    if (this.carryTimer) clearTimeout(this.carryTimer);
    this.carryTimer = undefined;
    const left = [...this.carried.keys()];
    for (const [u, ids] of this.carried) this.stray.set(u, ids);
    this.carried.clear();
    this.carriedMsg.clear();
    if (!this.turn) this.replayHeld();
    if (left.length && !this.exited) void this.cancelPending(this.stray, left, 'not_adopted');
  }

  /** A turn can end without a result when every input was withdrawn before the CLI started it. */
  private maybeFinishWithoutResult(t: ActiveTurn): void {
    if (this.turn !== t || t.pending.size || t.retry?.cont) return;
    if (t.between) this.finish(t, t.interrupting ? 'interrupted' : t.between.status, t.between.error);
    else if (!t.sawActivity) this.finish(t, 'interrupted');
  }

  private async pump(): Promise<void> {
    let failure: unknown;
    try {
      for await (const m of this.q) {
        try {
          this.onMessage(m);
        } catch (err) {
          this.emit({ t: 'notice', code: 'other', message: `claude-code adapter failed to map a message: ${(err as Error).message}` }, { native: m });
        }
      }
    } catch (err) {
      failure = err;
    }
    this.exited = true;
    if (this.carried.size) this.giveUpCarried();
    for (const req of [...this.requests.values()]) this.cancelRequest(req, 'runtime_cancelled');
    const t = this.turn;
    if (t) {
      const tail = this.init.stderrTail();
      const message = [failure ? String((failure as Error).message ?? failure) : 'claude process exited', tail].filter(Boolean).join('\n');
      this.finish(t, 'ambiguous', { code: 'harness_exited', retryable: false, message });
    }
    if (!this.closing) {
      this.emit({ t: 'notice', code: 'other', message: `claude process ended${failure ? `: ${(failure as Error).message}` : ''}` });
    }
    this.out.close();
  }

  private onMessage(m: SDKMessage): void {
    if (this.owed && this.lateStalled(m)) return this.emit({ t: 'native', name: m.type }, { native: m, turnId: undefined });
    // A carried follow-up may be what the CLI runs now: held for the turn that adopts it (HC-3b).
    // So is what comes after the stalled turn's own result while its withdraws settle: the CLI's
    // run of a follow-up it dequeued meanwhile, never the stalled turn's.
    const t = this.turn;
    const started = !!t?.stalled && !t.nextRun && !!t.queued?.size && named(m).some((u) => t.queued!.has(u));
    if (started) t!.nextRun = true;
    const after = !!t?.stalled && (t.finishLater !== undefined || !!t.nextRun);
    if ((after || (!t && this.carried.size)) && !this.closing) {
      this.held.push(m);
      // The stalled run is over: settled withdraws end the turn now (else `settleWithdraw` will).
      if (started && !t!.withdrawing) this.finish(t!, 'failed', t!.stalled);
      return;
    }
    this.dispatch(m);
  }

  private dispatch(m: SDKMessage): void {
    if (this.turn) this.noteTook(this.turn, m);
    if (this.turn) this.watch(this.turn, m);
    if (m.type !== 'result') this.markActivity(m);
    if (this.turn) this.stallWatch(this.turn, m);
    switch (m.type) {
      case 'stream_event':
        return this.onStreamEvent(m);
      case 'assistant':
        return this.onAssistant(m);
      case 'user':
        return this.onUser(m);
      case 'result':
        return this.onResult(m);
      case 'tool_progress':
        return this.progress(m.tool_use_id, { elapsedMs: Math.round(m.elapsed_time_seconds * 1000) }, m);
      case 'tool_use_summary':
        return this.emit({ t: 'headline', text: oneLine(m.summary, 200) });
      case 'rate_limit_event': {
        const i = m.rate_limit_info;
        if (i.status === 'allowed') return this.native('rate_limit_event', m);
        const when = i.resetsAt ? ` until ${new Date(i.resetsAt * 1000).toISOString()}` : '';
        return this.emit(
          { t: 'notice', code: 'rate_limited', message: `rate limit ${i.status}${i.rateLimitType ? ` (${i.rateLimitType})` : ''}${when}` },
          { native: m },
        );
      }
      case 'system':
        return this.onSystem(m);
      default:
        return this.native(m.type, m);
    }
  }

  /** Output of a stalled run ended without its result (`owed`), coming late. */
  private lateStalled(m: SDKMessage): boolean {
    const us = named(m);
    const r = m as { type: string; subtype?: string; terminal_reason?: string };
    const aborted = r.terminal_reason === 'aborted_streaming' || r.terminal_reason === 'aborted_tools';
    const late = us.length ? us.every((u) => this.owed!.has(u)) : r.type === 'result' && (aborted || r.subtype !== 'success');
    if (r.type === 'result' || (us.length && !late)) this.owed = undefined;
    return late;
  }

  /** HC-3b: what the CLI showed it took (in its history), from the uuids it stamps on its output. */
  private noteTook(t: ActiveTurn, m: SDKMessage): void {
    const us = named(m);
    if (!us.length) return;
    t.echo = true;
    for (const u of us) (t.took ??= new Set()).add(u);
  }

  private markActivity(m: SDKMessage): void {
    const t = this.turn;
    if (t) {
      t.sawActivity = true;
      // Only real turn output means the CLI picked up the rest of this turn's inputs.
      if (m.type === 'assistant' || m.type === 'stream_event' || m.type === 'user') t.between = undefined;
      return;
    }
    if (m.type === 'system' && (m.subtype === 'init' || m.subtype === 'session_state_changed')) return;
    if (!this.unownedActivity && (m.type === 'assistant' || m.type === 'stream_event')) {
      this.unownedActivity = true;
      this.emit({ t: 'notice', code: 'other', message: 'claude started a turn on its own (e.g. a background task finished)' });
    }
  }

  private onSystem(m: Extract<SDKMessage, { type: 'system' }>): void {
    switch (m.subtype) {
      case 'init':
        if (m.session_id && m.session_id !== this.sessionId) {
          this.sessionId = m.session_id;
          this.emit({ t: 'session.bound', nativeId: m.session_id });
        }
        this.native('system/init', m);
        // HC-6: the same, for hosts (a native event is internal: a `full` subscriber does not get it).
        return this.emit({
          t: 'session.ready',
          ...(m.session_id ? { nativeId: m.session_id } : {}),
          ...(typeof m.model === 'string' && m.model ? { model: m.model } : {}),
        });
      case 'api_retry':
        return this.emit(
          {
            t: 'notice',
            code: 'api_retry',
            message: `API ${m.error_status ?? m.error}; retry ${m.attempt}/${m.max_retries} in ${Math.round(m.retry_delay_ms / 1000)}s`,
          },
          { native: m },
        );
      case 'compact_boundary': {
        const c = m.compact_metadata;
        this.memo.reset();
        return this.emit(
          {
            t: 'notice',
            code: 'compacting',
            message: `context compacted (${c.trigger}) ${c.pre_tokens}${c.post_tokens !== undefined ? ` → ${c.post_tokens}` : ''} tokens`,
          },
          { native: m },
        );
      }
      case 'status':
        if (m.status === 'compacting') return this.emit({ t: 'notice', code: 'compacting', message: 'compacting context' }, { native: m });
        if (m.compact_result === 'failed')
          return this.emit({ t: 'notice', code: 'other', message: `compaction failed${m.compact_error ? `: ${m.compact_error}` : ''}` }, { native: m });
        return this.native('system/status', m);
      case 'task_started':
        if (m.tool_use_id && this.items.has(m.tool_use_id))
          return this.progress(m.tool_use_id, { text: oneLine(m.description, 200) }, m);
        return this.native('system/task_started', m);
      case 'task_progress':
        if (m.tool_use_id && this.items.has(m.tool_use_id))
          return this.progress(
            m.tool_use_id,
            { text: oneLine(m.summary ?? (m.last_tool_name ? `${m.description} · ${m.last_tool_name}` : m.description), 200), elapsedMs: m.usage.duration_ms },
            m,
          );
        return this.native('system/task_progress', m);
      case 'task_notification':
        if (m.tool_use_id && this.items.has(m.tool_use_id))
          return this.progress(m.tool_use_id, { text: oneLine(`${m.status}: ${m.summary}`, 200) }, m);
        return this.native('system/task_notification', m);
      default: {
        // HC-5: Claude Code switched models itself within the turn (an error, or a refusal).
        const sub = m.subtype as string;
        if (sub === 'model_fallback' || sub === 'model_refusal_fallback') {
          const f = m as { fallback_model?: unknown; scope?: unknown };
          if (typeof f.fallback_model === 'string' && f.fallback_model) {
            // A refusal fallback of the main thread keeps the session there (sdk.d.ts); a `local` one is a subagent's.
            if (sub === 'model_refusal_fallback' && f.scope !== 'local') this.cliModel = f.fallback_model;
            if (sub === 'model_fallback' || f.scope !== 'local') this.tighten(f.fallback_model, sub);
          }
          this.native(`system/${m.subtype}`, m);
          return this.publicFallback(m as Record<string, unknown>, sub === 'model_refusal_fallback' ? 'refusal' : 'error');
        }
        return this.native(`system/${m.subtype}`, m);
      }
    }
  }

  private onStreamEvent(m: Extract<SDKMessage, { type: 'stream_event' }>): void {
    const ev = m.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
    if (ev.type !== 'content_block_delta' || !ev.delta) return;
    const parent = m.parent_tool_use_id ? { parentItemId: m.parent_tool_use_id, level: 'detail' as const } : {};
    if (ev.delta.type === 'text_delta' && ev.delta.text) this.emit({ t: 'text.delta', delta: ev.delta.text, stream: 'answer' }, parent);
    else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking)
      this.emit({ t: 'text.delta', delta: ev.delta.thinking, stream: 'reasoning' }, parent);
  }

  private onAssistant(m: Extract<SDKMessage, { type: 'assistant' }>): void {
    const parentItemId = m.parent_tool_use_id ?? undefined;
    if (m.error) {
      this.emit(
        { t: 'notice', code: m.error === 'rate_limit' ? 'rate_limited' : 'other', message: `assistant error: ${m.error}` },
        { native: m },
      );
    }
    const content = (m.message?.content ?? []) as unknown as { type: string; [k: string]: unknown }[];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (parentItemId) continue; // subagent text arrives as deltas; it is not this turn's answer
        const id = String(m.message.id ?? m.uuid);
        if (this.msgText?.id !== id) this.msgText = { id, text: '' };
        this.msgText.text = this.msgText.text ? `${this.msgText.text}\n\n${block.text}` : block.text;
        if (this.lastWords?.id !== id) this.lastWords = { id, text: '' };
        this.lastWords.text = this.lastWords.text ? `${this.lastWords.text}\n\n${block.text}` : block.text;
        this.emit({ t: 'text.snapshot', text: this.msgText.text, final: false });
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        if (!parentItemId) this.lastWords = undefined; // what it said before this call is not its answer
        const id = String(block.id);
        const name = String(block.name);
        const tool = mcpTool(name);
        const item: ItemSummary = {
          itemId: id,
          type: itemType(name),
          title: itemTitle(name, block.input),
          status: 'running',
          ...(inputSummary(name, block.input) ? { inputSummary: inputSummary(name, block.input) } : {}),
          ...(tool ? { tool } : {}),
        };
        this.items.set(id, { item, ...(parentItemId ? { parentItemId } : {}), turnId: this.turn?.turnId });
        this.emit({ t: 'item.started', item }, { itemId: id, ...(parentItemId ? { parentItemId } : {}) });
        const steps = planSteps(name, block.input);
        if (steps && !parentItemId) this.emit({ t: 'plan.updated', steps });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        // streamed as reasoning deltas
      } else if (block.type.endsWith('_tool_result')) {
        this.completeItem(String(block.tool_use_id), block.content, false, m);
      } else {
        this.native(`assistant/${block.type}`, { ...m, message: { ...m.message, content: [block] } });
      }
    }
  }

  private onUser(m: Extract<SDKMessage, { type: 'user' }>): void {
    const content = m.message?.content;
    if (!Array.isArray(content)) return this.native('user', m);
    let mapped = false;
    for (const block of content as unknown as { type: string; [k: string]: unknown }[]) {
      if (block.type === 'tool_result') {
        mapped = true;
        this.completeItem(String(block.tool_use_id), block.content, block.is_error === true, m);
      }
    }
    if (!mapped) this.native('user', m);
  }

  private completeItem(id: string, content: unknown, isError: boolean, m: SDKMessage): void {
    const known = this.items.get(id);
    this.items.delete(id);
    const text = resultText(content);
    const max = this.init.options.previewChars ?? 400;
    const p = preview(text, max);
    const status: ItemSummary['status'] = isError ? (this.declined.has(id) ? 'declined' : 'failed') : 'completed';
    this.declined.delete(id);
    const item: ItemSummary = {
      ...(known?.item ?? { itemId: id, type: 'tool', title: 'tool' }),
      status,
      result: { preview: p.preview, truncated: p.truncated, isError },
    };
    const turnId = known?.turnId;
    const sameTurn = turnId !== undefined && this.turn?.turnId === turnId;
    this.emit(
      { t: 'item.completed', item },
      {
        itemId: id,
        ...(known?.parentItemId ? { parentItemId: known.parentItemId } : {}),
        ...(sameTurn || turnId === undefined ? {} : { turnId: undefined }),
        native: 'tool_use_result' in m ? (m as { tool_use_result?: unknown }).tool_use_result : undefined,
      },
    );
  }

  private progress(itemId: string, p: { text?: string; elapsedMs?: number }, m: SDKMessage): void {
    const known = this.items.get(itemId);
    if (!known) return this.native(m.type === 'system' ? `system/${m.subtype}` : m.type, m);
    this.emit(
      { t: 'item.progress', itemId, ...p },
      { itemId, ...(known.parentItemId ? { parentItemId: known.parentItemId } : {}) },
    );
  }

  private onResult(m: SDKResultMessage): void {
    const t = this.turn;
    if (t?.stalled) t.resulted = true;
    const usage = {
      usage: m.usage,
      modelUsage: m.modelUsage,
      totalCostUsd: m.total_cost_usd,
      durationMs: m.duration_ms,
      numTurns: m.num_turns,
    };
    if (t?.retry && !t.retry.swallowed && !t.interrupting) {
      // The attempt the watchdog interrupted ends here (its inputs were sent again): not this turn's end.
      const us = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
      const aborted = m.terminal_reason === 'aborted_streaming' || m.terminal_reason === 'aborted_tools';
      if (us.length ? us.every((u) => t.retry!.old.has(u)) : aborted || m.subtype !== 'success') {
        t.retry.swallowed = true;
        return this.native('result', m);
      }
    }
    if (!t) {
      this.unownedActivity = false;
      // An unsolicited CLI turn, or one that ran inputs of an already-ended turn.
      const uuids = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
      const late = uuids.filter((u) => this.stray.has(u)).flatMap((u) => this.stray.get(u)!);
      for (const u of uuids) this.stray.delete(u);
      if (late.length)
        this.emit({ t: 'notice', code: 'other', message: `inputs ${late.join(', ')} ran after their turn ended` }, { native: m });
      this.emit({ t: 'usage', usage });
      return this.native('result', m);
    }

    const uuids = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : undefined);
    // The watchdog's "go on" message ran (it stands for inputs consumed already).
    if (t.retry?.cont && (!uuids || uuids.includes(t.retry.cont))) t.retry.cont = undefined;
    const consumed: string[] = [];
    if (uuids) {
      for (const u of uuids) {
        const ids = t.pending.get(u);
        if (ids !== undefined) {
          consumed.push(...ids);
          t.pending.delete(u);
        }
      }
    } else if (m.subtype === 'success') {
      // Older producers: no echo at all. Everything written so far must have been read.
      consumed.push(...[...t.pending.values()].flat());
      t.pending.clear();
    }
    if (consumed.length) this.emit({ t: 'input.consumed', inputIds: consumed, turnId: t.turnId });
    this.emit({ t: 'usage', usage }, { native: m });
    t.usage = usage;

    let status: Status = 'completed';
    let error: TurnError | undefined;
    const aborted = m.terminal_reason === 'aborted_streaming' || m.terminal_reason === 'aborted_tools';
    if (t.interrupting || aborted) status = 'interrupted';
    else if (m.subtype !== 'success') {
      status = 'failed';
      error = { code: m.subtype, retryable: false, message: m.errors.join('\n') || undefined };
    } else if (m.is_error) {
      status = 'failed';
      error = {
        code: m.terminal_reason ?? 'api_error',
        retryable: m.api_error_status === 429 || (m.api_error_status ?? 0) >= 500,
        message: m.result || undefined,
      };
    } else if (m.result) {
      t.finalText = m.result;
    }

    if (status === 'completed' && (t.pending.size || t.retry?.cont)) {
      // The CLI ran part of this turn's inputs; the rest (a batch member or a steer that
      // missed the fold) run as its next turn, which still belongs to this one.
      t.between = { status };
      if (t.finalText) this.emit({ t: 'text.snapshot', text: t.finalText, final: false });
      // Not timed (HC-3): the turn has had output, and the CLI may be idle with them unacknowledged.
      return;
    }
    this.finish(t, status, error);
  }

  private finish(t: ActiveTurn, status: Status, error?: TurnError): void {
    if (this.turn !== t) return;
    if (t.withdrawing) {
      t.finishLater = { status, error };
      return;
    }
    this.disarm(t);
    this.idleClear(t);
    if (t.stalled) {
      // The idle deadline stopped it: said as it is, whatever the interrupted CLI reports.
      status = 'failed';
      error = t.stalled;
      // What the CLI showed it took is in its history: consumed. What it neither gave back nor named
      // may still run there as a CLI turn of its own: carried — not consumed (the host re-queues it),
      // never written again, and that run is the turn's that adopts it. A CLI that names no uuid at
      // all (older producers) cannot tell the two apart: consumed, so nothing runs twice.
      // A follow-up the CLI's next run names (its output held: it came after this turn's result) is
      // that run's: carried too, also when nothing before named a uuid.
      const runs = new Set(this.held.flatMap(named));
      const took: string[] = [];
      for (const [u, ids] of [...t.pending]) {
        const m = t.sent.get(u);
        if ((runs.has(u) || (t.echo && !t.took?.has(u))) && m) {
          this.carried.set(u, ids);
          this.carriedMsg.set(u, m);
        } else took.push(...ids);
        t.pending.delete(u);
      }
      if (took.length) this.emit({ t: 'input.consumed', inputIds: took, turnId: t.turnId });
      if (this.carried.size && !this.carryTimer) {
        this.carryTimer = setTimeout(() => this.giveUpCarried(), CARRY_MS);
        this.carryTimer.unref?.();
      }
    }
    for (const req of [...this.requests.values()]) if (req.turnId === t.turnId) this.cancelRequest(req, 'runtime_cancelled');
    if (status === 'completed') {
      for (const [id, rec] of this.items) {
        if (rec.turnId !== t.turnId) continue;
        this.items.delete(id);
        this.emit({ t: 'item.completed', item: { ...rec.item, status: 'skipped' } }, { itemId: id });
      }
      const text = t.finalText ?? this.lastWords?.text;
      if (text) this.emit({ t: 'text.snapshot', text, final: true });
    }
    this.emit({
      t: 'turn.completed',
      turnId: t.turnId,
      status,
      ...(t.usage !== undefined ? { usage: t.usage } : {}),
      ...(error ? { error } : {}),
    });
    for (const [u, id] of t.pending) this.stray.set(u, id);
    const leftovers = [...t.pending.keys()];
    t.pending.clear();
    this.turn = undefined;
    this.msgText = undefined;
    this.lastWords = undefined;
    // Held after the stalled turn's result, and no follow-up carried for a turn to adopt: unowned, as it came.
    if (!this.carried.size && this.held.length) this.replayHeld();
    for (const w of this.idleWaiters.splice(0)) w();
    if (leftovers.length && !this.exited) void this.cancelPending(this.stray, leftovers, `turn ${status}`);
  }

  // ---- first-byte watchdog ------------------------------------------------
  // Claude Code's own `fallbackModel` switches only on errors (overloaded, not found, refused…); a
  // request that hangs before its first byte is waited on (`API_TIMEOUT_MS`) and retried on the same
  // model. The watchdog covers that gap once per turn, only while nothing can have happened yet: no
  // model output means no tool call and nothing said, so the turn can start over on another model.
  // A turn's inputs are one message (HC-4), so this is every model request of the turn that runs
  // before any side effect. A request after a tool call or after an answer is not timed: switching
  // there was never run against a real CLI, and an idle CLI holding a late steer is not a hang. It
  // does not write the inputs again (the CLI keeps them in its history): a short "go on" message runs them.

  private arm(t: ActiveTurn): void {
    const w = this.init.watchdog;
    if (!w || t.wd === 'done' || t.interrupting) return;
    if (t.wdTimer) clearTimeout(t.wdTimer);
    t.wd = 'armed';
    t.wdTimer = setTimeout(() => void this.firstByteTimeout(t), w.timeoutMs);
    t.wdTimer.unref?.();
  }

  private pause(t: ActiveTurn): void {
    if (t.wd !== 'armed') return;
    if (t.wdTimer) clearTimeout(t.wdTimer);
    t.wdTimer = undefined;
    t.wd = 'paused';
  }

  private disarm(t: ActiveTurn): void {
    if (t.wdTimer) clearTimeout(t.wdTimer);
    t.wdTimer = undefined;
    if (t.wd) t.wd = 'done';
  }

  /** What a CLI message means for the watchdog of the running turn. */
  private watch(t: ActiveTurn, m: SDKMessage): void {
    if (t.wd !== 'armed' && t.wd !== 'paused') return;
    switch (m.type) {
      case 'stream_event':
      case 'assistant':
      case 'tool_progress':
      case 'tool_use_summary':
      case 'result':
        return this.disarm(t); // the model answered (or the CLI turn ended): too late to send again
      case 'user': {
        const c = m.message?.content;
        if (Array.isArray(c) && c.some((b) => (b as { type?: string }).type === 'tool_result')) this.disarm(t);
        return;
      }
      case 'system': {
        const sub = (m as { subtype?: string }).subtype;
        // Claude Code switched models on its own in this turn: one mechanism per turn, never both.
        if (sub === 'model_fallback') return this.disarm(t);
        // Compacting is a model call of its own (up to ~90 s on a long context): not a hang.
        if (sub === 'status' && (m as { status?: string | null }).status === 'compacting') return this.pause(t);
        if (t.wd === 'paused' && (sub === 'compact_boundary' || sub === 'status')) return this.arm(t);
        return;
      }
      default:
        return;
    }
  }

  private async firstByteTimeout(t: ActiveTurn): Promise<void> {
    t.wdTimer = undefined;
    if (this.turn !== t || t.wd !== 'armed' || t.interrupting || this.closing || this.exited) return;
    t.wd = 'done'; // once per turn, whatever happens next
    const from = this.model;
    const chain = this.fallbacksFor(t, from);
    if (!chain.length || !t.pending.size) return; // nothing to switch to: wait as before
    const retry: NonNullable<ActiveTurn['retry']> = { old: new Set(t.pending.keys()), withdrawn: new Set(), swallowed: false, switching: true };
    t.retry = retry;
    try {
      await this.switchModel(t, retry, from, chain, 'first_byte_timeout');
    } finally {
      retry.switching = false;
    }
    // The fallback hanging too is no longer waited on forever: the idle deadline times it.
    if (this.turn === t) this.idleArm(t);
  }

  private async switchModel(
    t: ActiveTurn,
    retry: NonNullable<ActiveTurn['retry']>,
    from: string,
    chain: string[],
    why: 'first_byte_timeout' | 'idle_timeout',
  ): Promise<void> {
    const timeoutMs = why === 'idle_timeout' ? this.init.stall!.timeoutMs : this.init.watchdog!.timeoutMs;
    let receipt: Awaited<ReturnType<QueryLike['interrupt']>>;
    try {
      receipt = await this.q.interrupt();
    } catch {
      return; // the CLI is gone: the pump settles the turn
    }
    // Inputs the CLI had not started yet: withdraw them so they are not run twice. One it took
    // meanwhile stays as written (its own result consumes it).
    for (const u of (receipt?.still_queued ?? []).filter((x) => retry.old.has(x))) {
      if (await this.withdraw(u)) retry.withdrawn.add(u);
      else retry.old.delete(u);
    }
    if (this.turn !== t) return;
    // The interrupted attempt's inputs are in Claude Code's history now ("[Request interrupted by
    // user]" follows them): consumed here, never written again (they would show up twice).
    const held = [...retry.old].filter((u) => !retry.withdrawn.has(u) && t.pending.has(u));
    if (held.length) {
      this.emit({ t: 'input.consumed', inputIds: held.flatMap((u) => t.pending.get(u)!), turnId: t.turnId });
      for (const u of held) {
        t.pending.delete(u);
        t.sent.delete(u);
      }
    }
    if (t.interrupting || this.closing) return this.dropRetried(t);
    // A tool that may have changed something ran (or was cut off running) while the interrupt was on
    // its way: the turn does not go on on another model; it ends as one with a side effect does.
    if (why === 'idle_timeout' && this.sideEffects(t).length) return this.endStalled(t, retry, from);
    // Down the chain: Claude Code checks a model with a small request before it switches, and that
    // check fails on a fallback that is overloaded or hangs too; then the next one is tried.
    let to: string | undefined;
    const refused: string[] = [];
    for (const m of chain) {
      try {
        await this.q.setModel(m);
        to = m;
        // The CLI runs on it from now on, whatever happens to this turn: the next turn's applyRun
        // puts its own run.model back (or stays here when that model fails its check).
        this.model = to;
        this.watchdogModel = to;
        this.cliModel = undefined;
      } catch (err) {
        refused.push(`${m}: ${oneLine((err as Error).message ?? String(err), 160)}`);
      }
      if (this.turn !== t) return;
      if (t.interrupting || this.closing) return this.dropRetried(t);
      if (to) break;
    }
    if (why === 'idle_timeout' && this.sideEffects(t).length) return this.endStalled(t, retry, from);
    if (!to) {
      // The chain is used up: say so now rather than leave the turn on a model that does not answer.
      // What was withdrawn (or steered meanwhile) and not sent stays unconsumed (the host's lane re-queues it).
      for (const u of retry.withdrawn) {
        t.pending.delete(u);
        t.sent.delete(u);
      }
      if (retry.withdrawn.size) this.memo.reset(); // their prefaces never reached the model
      const message =`${from} sent nothing ${why === 'idle_timeout' ? 'mid-turn for' : 'in'} ${Math.round(timeoutMs / 1000)} s and no fallback model took over (${refused.join('; ')})`;
      if (why === 'idle_timeout') this.sayStalled(t);
      return this.finish(t, 'failed', { code: why, retryable: why === 'first_byte_timeout', message });
    }
    this.emitFallback(from, to, why, timeoutMs);
    this.tighten(to, why);
    t.sawActivity = false; // the turn starts over: nothing of the second attempt seen yet
    if (held.length || retry.prevCont) {
      // One short message makes the CLI answer what it already holds, on the new model.
      const cont: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: why === 'idle_timeout' ? IDLE_CONTINUE : WATCHDOG_CONTINUE }] },
        parent_tool_use_id: null,
        priority: 'next',
        uuid: randomUUID() as SDKUserMessage['uuid'],
        timestamp: new Date().toISOString(),
      };
      retry.cont = cont.uuid!;
      this.init.prompt.push(cont);
    }
    // Withdrawn inputs and steers held during the switch, in the order they came.
    const again: Written[] = [];
    for (const u of retry.withdrawn) {
      const inputIds = t.pending.get(u);
      const m = t.sent.get(u);
      t.pending.delete(u);
      t.sent.delete(u);
      if (inputIds !== undefined && m) again.push({ inputIds, message: { ...m, uuid: randomUUID() as SDKUserMessage['uuid'], timestamp: new Date().toISOString() } });
    }
    this.write(t, again);
  }

  // ---- idle deadline (HC-3b) ------------------------------------------------
  // The first-byte watchdog covers a turn until its first output. After that a model request can
  // hang too (most often the one after a tool result): Claude Code waits for it (`API_TIMEOUT_MS`).
  // This deadline times the CLI's silence while it waits on the model: every CLI message starts it
  // again; it does not run while a tool runs (the tool's own timeout bounds it), while a permission
  // request waits for someone, while the CLI compacts, for a harness command, or between a result
  // and a late steer. A turn that changed nothing yet goes on on the next fallback model, its
  // history kept (nothing runs again); one with a side effect ends and says so in the conversation.

  /** What a CLI message means for the idle deadline of the running turn. */
  private stallWatch(t: ActiveTurn, m: SDKMessage): void {
    if (!this.init.stall) return;
    switch (m.type) {
      case 'result':
        return this.idleClear(t); // the CLI turn ended: the turn ends, or waits between (not timed)
      case 'assistant':
        for (const b of (m.message?.content ?? []) as unknown as { type: string; id?: unknown; name?: unknown }[])
          if (b.type === 'tool_use') (t.tools ??= new Map()).set(String(b.id), String(b.name));
        break;
      case 'user': {
        const c = m.message?.content;
        if (!Array.isArray(c)) break;
        for (const b of c as unknown as { type?: string; tool_use_id?: unknown }[]) {
          if (b.type !== 'tool_result') continue;
          const id = String(b.tool_use_id);
          const name = t.tools?.get(id);
          t.tools?.delete(id);
          // A declined call never ran; anything not known to only read may have changed something.
          if (name !== undefined && !READ_ONLY_TOOLS.has(name) && !this.declined.has(id)) (t.effects ??= []).push(name);
        }
        break;
      }
      case 'system': {
        const sub = (m as { subtype?: string }).subtype;
        if (sub === 'status') t.compacting = (m as { status?: string | null }).status === 'compacting';
        else if (sub === 'compact_boundary') t.compacting = false;
        break;
      }
      default:
    }
    this.idleArm(t);
  }

  private idleClear(t: ActiveTurn): void {
    if (t.idleTimer) clearTimeout(t.idleTimer);
    t.idleTimer = undefined;
  }

  /** (Re)starts the idle deadline when the turn is waiting on the model, else stops it. */
  private idleArm(t: ActiveTurn): void {
    const s = this.init.stall;
    if (!s) return;
    this.idleClear(t);
    if (this.turn !== t || this.closing || this.exited) return;
    if (t.stalled || t.interrupting || t.between || t.compacting || t.command || t.retry?.switching) return;
    if (t.wd === 'armed' || t.wd === 'paused') return; // the first-byte watchdog has the turn's start
    if (t.tools?.size) return;
    for (const r of this.requests.values()) if (r.turnId === t.turnId) return;
    t.idleTimer = setTimeout(() => void this.idleTimeout(t), s.timeoutMs);
    t.idleTimer.unref?.();
  }

  private async idleTimeout(t: ActiveTurn): Promise<void> {
    t.idleTimer = undefined;
    if (this.turn !== t || this.closing || this.exited) return;
    if (t.stalled || t.interrupting || t.between || t.compacting || t.tools?.size || t.retry?.switching) return;
    const from = this.model;
    const tried = (t.stalledOn ??= new Set());
    tried.add(from);
    const held = [...t.pending.keys()];
    const prevCont = t.retry?.cont;
    const chain = this.sideEffects(t).length ? [] : this.fallbacksFor(t, from).filter((x) => !tried.has(x));
    if (chain.length && (held.length || prevCont)) {
      // Nothing changed yet: the same turn goes on on another model (its history stays in the CLI).
      const retry: NonNullable<ActiveTurn['retry']> = {
        old: new Set([...held, ...(prevCont ? [prevCont] : [])]),
        withdrawn: new Set(),
        swallowed: false,
        switching: true,
        ...(prevCont ? { prevCont } : {}),
      };
      t.retry = retry;
      try {
        await this.switchModel(t, retry, from, chain, 'idle_timeout');
      } finally {
        retry.switching = false;
      }
      if (this.turn === t && this.model !== from) tried.add(this.model);
      if (this.turn === t) this.idleArm(t); // the new model is timed too
      return;
    }
    // A side effect already happened (or no model to go on with): end the turn as it is, say so,
    // and run nothing again.
    t.stalled = this.stallError(t, from);
    this.sayStalled(t);
    // A CLI that does not answer the interrupt (no receipt, or no result) within 5 s: the turn still
    // ends (what it holds: consumed or carried there). Armed before the interrupt: a receipt that
    // never comes must not keep a turn whose result already came open; re-armed once it comes.
    const endTurn = () => {
      if (this.turn !== t) return;
      if (t.retry) t.retry.cont = undefined;
      t.withdrawing = false;
      t.finishLater = undefined;
      this.finish(t, 'failed', t.stalled);
      if (t.resulted) return;
      // Its result may still come: what names only this turn's uuids then is not the next turn's.
      const own = [...t.sent.keys()].filter((u) => !this.carried.has(u));
      if (own.length) this.owed = new Set(own);
    };
    let end = setTimeout(endTurn, 5000);
    end.unref?.();
    // Follow-ups the CLI has not started go on as the next turn (not cancelled with this one).
    await this.interrupt(t.turnId, { keepQueued: true }).catch(() => undefined);
    clearTimeout(end);
    end = setTimeout(endTurn, 5000);
    end.unref?.();
  }

  /**
   * Tools of this turn that may have changed something: ran (`effects`), or not read-only and still
   * running when the turn was stopped (an interrupt cuts it off part way). Read again after every
   * await: a tool can start and finish while the idle deadline's interrupt is on its way.
   */
  private sideEffects(t: ActiveTurn): string[] {
    const running = [...(t.tools?.values() ?? [])].filter((n) => !READ_ONLY_TOOLS.has(n));
    return [...new Set([...(t.effects ?? []), ...running])];
  }

  private stallError(t: ActiveTurn, from: string): TurnError {
    const secs = Math.round(this.init.stall!.timeoutMs / 1000);
    const ran = this.sideEffects(t);
    return {
      code: 'idle_timeout',
      retryable: false,
      message: `${from} sent nothing mid-turn for ${secs} s${ran.length ? ` after ${ran.join(', ')} ran` : ''}; the turn was stopped and nothing was run again`,
    };
  }

  /**
   * The idle deadline's switch found a side effect after its interrupt: no model switch, no "go on".
   * The turn ends failed and says so; what was withdrawn stays unconsumed (the host re-queues it),
   * as when the chain is used up.
   */
  private endStalled(t: ActiveTurn, retry: NonNullable<ActiveTurn['retry']>, from: string): void {
    for (const u of retry.withdrawn) {
      t.pending.delete(u);
      t.sent.delete(u);
    }
    if (retry.withdrawn.size) this.memo.reset(); // their prefaces never reached the model
    t.stalled = this.stallError(t, from);
    this.sayStalled(t);
    this.finish(t, 'failed', t.stalled);
  }

  /** The stalled turn's answer: what it said so far, then the notice. */
  private sayStalled(t: ActiveTurn): void {
    const s = this.init.stall;
    if (!s || this.turn !== t) return;
    const ran = this.sideEffects(t);
    const notice = s.notice
      .replaceAll('{seconds}', String(Math.round(s.timeoutMs / 1000)))
      .replaceAll('{tools}', ran.length ? ran.join(', ') : '-');
    const prior = this.msgText?.text;
    t.finalText = undefined;
    this.emit({ t: 'text.snapshot', text: prior ? `${prior}\n\n${notice}` : notice, final: true });
  }

  /** The models the watchdog tries, in order: the fallback chain without the model that hung (nor this turn's own model when it failed its check). */
  private fallbacksFor(t: ActiveTurn, from: string): string[] {
    let chain: string[];
    try {
      chain = (this.init.watchdog ?? this.init.stall)?.fallbackModels() ?? [];
    } catch {
      return [];
    }
    const skip = new Set([from, t.run.model]);
    return [...new Set(chain)].filter((m) => !skip.has(m));
  }

  /** Takes a message the CLI has not started out of its queue; `true` when it is gone. */
  private async withdraw(uuid: string): Promise<boolean> {
    try {
      return (await this.q.cancelAsyncMessage?.(uuid)) === true;
    } catch {
      return false;
    }
  }

  /** Same shape as Claude Code's own `system/model_fallback`, so hosts record both alike. */
  private emitFallback(from: string, to: string, trigger: 'first_byte_timeout' | 'idle_timeout' | string, timeoutMs?: number): void {
    const raw = {
      type: 'system',
      subtype: 'model_fallback',
      trigger,
      original_model: from,
      fallback_model: to,
      ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
      source: 'agents-io',
      session_id: this.sessionId,
    };
    this.native('system/model_fallback', raw);
    this.publicFallback(raw, trigger);
  }

  /** HC-6: a model switch within the turn as a public `model.fallback` (the native event is internal). */
  private publicFallback(raw: Record<string, unknown>, defaultTrigger: string): void {
    const from = typeof raw.original_model === 'string' ? raw.original_model : '';
    const to = typeof raw.fallback_model === 'string' ? raw.fallback_model : '';
    if (!to) return;
    this.emit(
      {
        t: 'model.fallback',
        from,
        to,
        trigger: typeof raw.trigger === 'string' && raw.trigger ? raw.trigger : defaultTrigger,
        ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
        ...(typeof raw.timeout_ms === 'number' ? { timeoutMs: raw.timeout_ms } : {}),
      },
      { native: raw },
    );
  }

  /**
   * Stopped while the watchdog was switching: nothing is sent again. What the CLI had not started
   * was withdrawn, and steers were held back: both are cancelled, as the host's interrupt would have
   * done; the turn ends once nothing else is pending.
   */
  private dropRetried(t: ActiveTurn): void {
    const cancelled: string[] = [];
    for (const u of t.retry?.withdrawn ?? []) {
      const ids = t.pending.get(u);
      t.pending.delete(u);
      t.sent.delete(u);
      if (ids !== undefined) cancelled.push(...ids);
    }
    if (cancelled.length) {
      this.memo.reset();
      this.emit({ t: 'input.cancelled', inputIds: cancelled, reason: 'interrupted' }, { turnId: t.turnId });
    }
    if (!t.pending.size) this.finish(t, 'interrupted');
  }

  private cancelRequest(req: OpenRequest, by: 'runtime_cancelled' | 'timeout'): void {
    if (!this.requests.delete(req.requestId)) return;
    req.resolve({ behavior: 'deny', message: 'Permission request was cancelled.' });
    this.emit(
      { t: 'request.resolved', requestId: req.requestId, decision: null, by },
      req.turnId && this.turn?.turnId === req.turnId ? { turnId: req.turnId } : { turnId: undefined },
    );
    if (this.turn && !this.exited) this.idleArm(this.turn);
  }

  private toPermissionResult(req: OpenRequest, d: Decision): PermissionResult {
    switch (d.kind) {
      case 'allow_once':
        return { behavior: 'allow', updatedInput: req.input };
      case 'allow_session': {
        if (!req.allowAlways) return { behavior: 'allow', updatedInput: req.input };
        const updatedPermissions = (d.updatedPermissions as PermissionUpdate[] | undefined) ?? req.suggestions;
        return { behavior: 'allow', updatedInput: req.input, ...(updatedPermissions ? { updatedPermissions } : {}) };
      }
      case 'deny':
        return {
          behavior: 'deny',
          message: d.message ?? 'The user denied this request.',
          ...(d.interruptTurn ? { interrupt: true } : {}),
        };
      case 'answer':
        return { behavior: 'allow', updatedInput: { ...req.input, answers: mapAnswers(req.input, d.answers) } };
      case 'native':
        return d.payload as PermissionResult;
    }
  }

  private native(name: string, raw: unknown): void {
    this.emit({ t: 'native', name }, { native: raw });
  }

  private emit(body: Body, extra: Partial<Omit<HarnessEvent, 'body'>> = {}): void {
    const turnId = 'turnId' in extra ? extra.turnId : this.turn?.turnId;
    const e: HarnessEvent = {
      ts: Date.now(),
      level: extra.level ?? levelOf(body),
      audience: extra.audience ?? audienceOf(body),
      durability: EPHEMERAL.has(body.t) ? 'ephemeral' : 'durable',
      body,
    };
    if (turnId !== undefined) e.turnId = turnId;
    if (extra.itemId !== undefined) e.itemId = extra.itemId;
    if (extra.parentItemId !== undefined) e.parentItemId = extra.parentItemId;
    if (extra.native !== undefined) e.native = extra.native;
    this.out.push(e);
  }

  private whenIdle(): Promise<void> {
    if (!this.turn) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
}

export function defaultProfile(name: string): ClaudeProfile {
  return name === 'bypass' ? { permissionMode: 'bypassPermissions' } : { permissionMode: 'default' };
}

/** Whether `model` is one of the profile's `bypassModels` (HC-5): exact, or a prefix before a trailing `*`. */
export function isBypassModel(profile: ClaudeProfile, model: string | undefined): boolean {
  if (!model) return false;
  return (profile.bypassModels ?? []).some((p) => (p.endsWith('*') ? p.length > 1 && model.startsWith(p.slice(0, -1)) : p === model));
}

/**
 * The permission mode a profile runs in on `model` (HC-5): `bypassPermissions` on one of its
 * `bypassModels`, else its `permissionMode` — which with `bypassModels` set is never bypass (a
 * profile that names the models it may bypass on does not bypass on the others).
 */
export function permissionModeFor(profile: ClaudeProfile, model: string | undefined): PermissionMode {
  if (!profile.bypassModels?.length) return profile.permissionMode ?? 'default';
  if (isBypassModel(profile, model)) return 'bypassPermissions';
  const m = profile.permissionMode ?? 'default';
  return m === 'bypassPermissions' ? 'default' : m;
}

function sameTools(a: ClaudeProfile, b: ClaudeProfile): boolean {
  const eq = (x?: string[], y?: string[]) => JSON.stringify(x ?? []) === JSON.stringify(y ?? []);
  return (
    eq(a.allowedTools, b.allowedTools) &&
    eq(a.disallowedTools, b.disallowedTools) &&
    eq(a.additionalDirectories, b.additionalDirectories) &&
    (a.permissionPrompts ?? 'host') === (b.permissionPrompts ?? 'host') &&
    (a.permissionMode === 'bypassPermissions') === (b.permissionMode === 'bypassPermissions')
  );
}

/** Decision answers keyed by question text, header or index → AskUserQuestion `answers` (question text → string). */
export function mapAnswers(
  input: Record<string, unknown>,
  answers: Record<string, string | string[]>,
): Record<string, string> {
  const qs = (Array.isArray(input.questions) ? input.questions : []) as { question?: string; header?: string }[];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) {
    const q = qs.find((x) => x.question === k) ?? qs.find((x) => x.header === k) ?? (/^\d+$/.test(k) ? qs[Number(k)] : undefined);
    out[q?.question ?? k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}
