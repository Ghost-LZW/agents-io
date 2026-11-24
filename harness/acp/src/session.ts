import { PrefaceMemo, type BlobAccess, type Body, type BodyOf, type Decision, type HarnessEvent, type HarnessSession, type InputRecord, type ItemSummary, type RunSpec, type SteerResult } from '@agents-io/protocol';
import type {
  CreateElicitationResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PermissionOption,
  PromptResponse,
  RequestPermissionOutcome,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  ToolCallContent,
} from '@agentclientprotocol/sdk';
import type { AcpCommand, AcpElicitationForm, AcpFlavor, AcpMode, AcpToolCallView } from './flavors.js';
import {
  diffFiles,
  elicitationContent,
  inputSummary,
  isNativeCommand,
  itemStatus,
  itemTypeOf,
  permissionDecisions,
  permissionKind,
  permissionOutcome,
  renderPrompt,
  resultOf,
  riskOf,
  turnOutcome,
  type PromptSupport,
} from './map.js';
import { AsyncQueue } from './queue.js';

/*
 * One ACP session (`session/new` or `session/load`) as a `HarnessSession`. A turn is one
 * `session/prompt`: its `session/update` notifications map to events until the prompt answers with
 * a stop reason. Updates outside a turn (the replay of `session/load`, commands and modes the agent
 * advertises between turns) change what the session knows and are never events: replayed history
 * does not reach the session log. ACP has no mid-turn steer (`steer` answers `unsupported`, so the
 * lane queues), interrupts with `session/cancel`, and asks permission (`session/request_permission`)
 * and questions (`elicitation/create`) as requests that live only while the agent process does.
 * Updates carry no turn id, so a prompt the agent goes on with after its turn ended (the cancel timed
 * out) keeps the session: what it streams is `native`, and the next turn's prompt waits for it to
 * answer, or for the session to be closed and opened again.
 */

/** What a session uses of its adapter's connection. */
export interface AcpLink {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  /** `session/prompt`: no timeout (a turn takes as long as it takes). */
  prompt(params: unknown): Promise<PromptResponse>;
  notify(method: string, params: unknown): Promise<void>;
  /** The connection to the agent is gone (its process exited). */
  readonly gone: boolean;
  readonly flavor: Required<Omit<AcpFlavor, 'matches' | 'displayName'>>;
  readonly blobs?: BlobAccess;
  readonly support: PromptSupport;
  /** The agent takes `session/close`. */
  readonly closes: boolean;
  /** The agent takes `session/load`. */
  readonly loads: boolean;
  /**
   * Open `s` again as its adapter opened it (cwd, MCP servers, instructions): `load` loads the ACP
   * session of its id, `new` starts a new one and rebinds `s` to it. Registered either way: the
   * agent's updates of that id reach `s`.
   */
  open(s: AcpSession, how: 'load' | 'new'): Promise<LoadSessionResponse | NewSessionResponse>;
  /**
   * How long `interrupt` waits for the prompt to stop before ending the turn anyway; and how long
   * the next turn then waits for that prompt to answer before the session is closed and opened again.
   */
  readonly cancelTimeoutMs: number;
  /** Instance profiles: profile → its settings (`mode`: the session mode it selects). */
  readonly profiles: Readonly<Record<string, Record<string, unknown>>>;
  /** The session mode Plan mode selects, as configured (over the flavor's). */
  readonly planMode: string | undefined;
  /** What a session learned that the adapter declares (`modes`, `compact`). */
  learned(o: { modes?: readonly string[]; commands?: readonly AcpCommand[] }): void;
  forget(s: AcpSession): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void;
}

interface OpenRequest {
  requestId: string;
  turnId: string;
  kind: 'permission' | 'elicitation';
  options?: PermissionOption[];
  properties?: Record<string, Record<string, unknown>>;
  /** Answers the agent's JSON-RPC request. */
  answer(v: { outcome: RequestPermissionOutcome } | CreateElicitationResponse): void;
}

interface ItemState {
  view: AcpToolCallView;
  item: ItemSummary;
}

interface Turn {
  turnId: string;
  inputIds: string[];
  consumed: boolean;
  done: boolean;
  /** The message being written: its text, and the agent's message id when it gives one. */
  msg?: { text: string; messageId?: string };
  /** What it wrote since its last tool call: the answer when the turn completes. */
  lastWords: string;
  items: Map<string, ItemState>;
  usage?: unknown;
  cancelTimer?: NodeJS.Timeout;
  interrupted: boolean;
  /** Settles when the agent answers the turn's `session/prompt` (or the connection ends). */
  answered: Promise<void>;
  /** It has. */
  isAnswered: boolean;
}

const EPHEMERAL = new Set<Body['t']>(['text.delta', 'item.progress', 'headline']);

function levelOf(b: Body): HarnessEvent['level'] {
  switch (b.t) {
    case 'native':
      return 'debug';
    case 'item.started':
    case 'item.completed':
    case 'item.progress':
    case 'plan.updated':
    case 'diff.updated':
    case 'input.consumed':
    case 'session.bound':
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
    case 'diff.updated':
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

export class AcpSession implements HarnessSession {
  private readonly queue = new AsyncQueue<HarnessEvent>();
  readonly events: AsyncIterable<HarnessEvent> = this.queue;
  private turn: Turn | undefined;
  /** A turn that ended at its cancel timeout while the agent goes on with its prompt: until the prompt answers, no other is sent. */
  private stale: Turn | undefined;
  /** Ends the next turn's wait for the stale prompt (the session closed, or the agent is gone). */
  private wake: (() => void) | undefined;
  private readonly requests = new Map<string, OpenRequest>();
  private nextRequest = 0;
  private closed = false;
  private readonly memo = new PrefaceMemo();
  /** Session modes: the one the agent is in, the one it opened in (`bypass` without a mode goes back to it), and what it offers (ids, and as offered). */
  private mode: { current?: string; base?: string; available: string[]; offered: AcpMode[] } = { available: [], offered: [] };
  private configOptions: SessionConfigOption[] = [];
  private modelNoticed = false;

  constructor(
    private readonly link: AcpLink,
    /** The ACP session id: the native id. */
    private id: string,
  ) {}

  /** The ACP session id: the native id (another once the session was opened again as a new one). */
  get sessionId(): string {
    return this.id;
  }

  /** The adapter opened this session again as a new ACP session: its id from now on. */
  rebind(sessionId: string): void {
    this.id = sessionId;
  }

  nativeId(): string {
    return this.sessionId;
  }

  /** What `session/new` or `session/load` answered: the session's modes and config options. */
  setup(o: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null }): void {
    if (o.modes)
      this.mode = {
        current: o.modes.currentModeId,
        base: o.modes.currentModeId,
        available: o.modes.availableModes.map((m) => m.id),
        offered: o.modes.availableModes.map((m) => ({ id: m.id, name: m.name, ...(m.description !== undefined ? { description: m.description } : {}) })),
      };
    if (o.configOptions) this.configOptions = o.configOptions;
    if (this.mode.available.length) this.link.learned({ modes: this.mode.available });
  }

  /** Emit `session.bound` (the host persists the native id for `resume`). */
  bound(): void {
    this.emit({ t: 'session.bound', nativeId: this.sessionId });
  }

  /** A notice outside any turn (e.g. why a resume started a new session). */
  notice(code: BodyOf<'notice'>['code'], message: string): void {
    this.emit({ t: 'notice', code, message }, { level: 'detail' });
  }

  private emit(body: Body, extra: Partial<Omit<HarnessEvent, 'body' | 'ts'>> = {}): void {
    this.queue.push({
      ts: Date.now(),
      level: levelOf(body),
      audience: audienceOf(body),
      // Native passthrough is for operators of the moment: not kept in the log.
      durability: EPHEMERAL.has(body.t) || body.t === 'native' ? 'ephemeral' : 'durable',
      ...extra,
      body,
    });
  }

  // ---- turns ------------------------------------------------------------------

  async startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void> {
    this.usable();
    // The agent still runs the prompt of a turn whose cancel timed out: a second prompt beside it would get what it streams.
    if (this.stale) await this.outlast(this.stale);
    this.usable();
    if (run) await this.applyRun(run);
    // A harness command (the compaction command, the only one the host sends) may drop what the
    // model was shown: the next input's preface gives its context in full again (ID-2).
    if (inputs.length === 1 && isNativeCommand(inputs[0]!)) this.memo.reset();
    const prompt = await renderPrompt(inputs, { ...(this.link.blobs ? { blobs: this.link.blobs } : {}), support: this.link.support, memo: this.memo });
    const t: Turn = { turnId, inputIds: inputs.map((i) => i.inputId), consumed: false, done: false, lastWords: '', items: new Map(), interrupted: false, answered: Promise.resolve(), isAnswered: false };
    this.turn = t;
    this.emit({ t: 'turn.started', turnId, inputIds: t.inputIds, replyRoute: inputs[0]?.replyRoute ?? null, ...(run ? { run } : {}) }, { turnId });
    const answer = this.link.prompt({ sessionId: this.sessionId, prompt });
    t.answered = answer.then(
      () => this.promptAnswered(t),
      () => this.promptAnswered(t),
    );
    answer
      .then(
        (r) => {
          this.consume(t);
          // Not checked by the SDK: an agent may answer anything, `null` among it (no stop reason: ambiguous).
          const res = (r && typeof r === 'object' ? r : {}) as Partial<PromptResponse> & { usage?: unknown };
          // The prompt's own usage when the agent reports it, else its last usage update.
          if (res.usage !== undefined && res.usage !== null) t.usage = res.usage;
          const o = turnOutcome(res.stopReason);
          this.finish(t, o.status, o.error);
        },
        (err: unknown) => {
          if (this.link.gone) return this.finish(t, 'ambiguous', { code: 'agent_exited', retryable: false, message: 'the ACP agent process exited during the turn' });
          // The agent answered the prompt with an error: it did not run it (its inputs were not consumed) unless it said something first.
          this.finish(t, t.interrupted ? 'interrupted' : 'failed', { code: 'prompt_failed', retryable: false, message: err instanceof Error ? err.message : String(err) });
        },
      )
      // Nothing that goes wrong mapping the answer may be left unhandled (it would end the daemon): the turn ends ambiguous.
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        try {
          this.finish(t, 'ambiguous', { code: 'adapter_error', retryable: false, message: `mapping the agent's answer to the prompt failed: ${message}` });
          this.link.log('error', `acp session ${this.sessionId}: mapping the answer to session/prompt failed: ${message}`);
        } catch {
          // Nothing more to do here; still never an unhandled rejection.
        }
      });
  }

  private usable(): void {
    if (this.closed) throw new Error('acp session is closed');
    if (this.link.gone) throw new Error('the ACP agent process is gone');
    if (this.turn && !this.turn.done) throw new Error('turn already active');
  }

  /** The agent answered a turn's prompt: a stale one no longer holds the session. */
  private promptAnswered(t: Turn): void {
    t.isAnswered = true;
    if (this.stale !== t) return;
    this.stale = undefined;
    this.link.log('info', `acp session ${this.sessionId}: the agent answered the prompt of turn ${t.turnId} after its cancel timeout`);
  }

  /**
   * Wait for the agent to answer the prompt of turn `t`, which ended at its cancel timeout, at most
   * `cancelTimeoutMs`. Still no answer: the ACP session is closed and opened again (`reopen`). A
   * session that cannot be opened again ends (the lane opens another).
   */
  private async outlast(t: Turn): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const woken = new Promise<'woken'>((resolve) => (this.wake = () => resolve('woken')));
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.link.cancelTimeoutMs);
      timer.unref?.();
    });
    const why = await Promise.race([t.answered.then(() => 'answered' as const), woken, late]);
    clearTimeout(timer);
    this.wake = undefined;
    if (why !== 'late' || this.stale !== t || this.closed || this.link.gone) return;
    try {
      await this.reopen(t);
    } catch (e) {
      const message = `could not open ACP session ${this.sessionId} again after turn ${t.turnId}'s prompt would not stop: ${e instanceof Error ? e.message : String(e)}`;
      this.link.log('warn', `acp session ${this.sessionId}: ${message}`);
      await this.close(message);
      throw new Error(message);
    }
  }

  /**
   * Close the ACP session, whose agent goes on with turn `t`'s prompt, and open it again: with
   * `session/close` (the protocol has it cancel the session's work) answered, the same session is
   * loaded again (`session/load`), keeping the conversation; else a new session is started, since
   * the prompt may still stream into the old one. A `continuity` notice says which.
   */
  private async reopen(t: Turn): Promise<void> {
    const old = this.sessionId;
    const ms = this.link.cancelTimeoutMs;
    const why = `the agent did not stop turn ${t.turnId}: no answer to its session/prompt within ${ms}ms of session/cancel, nor in the ${ms}ms after`;
    let detail = 'the agent does not take session/close';
    let closed = false;
    if (this.link.closes) {
      try {
        await this.link.request('session/close', { sessionId: old }, 5_000);
        closed = true;
      } catch (e) {
        detail = `session/close failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    // Whatever the old session still says is no session's now.
    this.stale = undefined;
    this.link.forget(this);
    if (this.closed || this.link.gone) return; // startTurn says why
    if (closed && this.link.loads) {
      try {
        const r = await this.link.open(this, 'load');
        if (this.closed) return this.link.forget(this);
        this.setup(r);
        this.notice('continuity', `${why}: closed ACP session ${old} and loaded it again`);
        return;
      } catch (e) {
        this.link.forget(this);
        if (this.closed || this.link.gone) throw e;
        detail = `session/load failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else if (closed) detail = 'the agent cannot load sessions';
    const r = await this.link.open(this, 'new');
    if (this.closed) return this.link.forget(this);
    this.setup(r);
    // None of the conversation is in the new session: the next input's preface gives its context in full again (ID-2).
    this.memo.reset();
    this.notice('continuity', `${why}: started a new ACP session ${this.sessionId} (${detail}); the conversation so far is not in it`);
    this.bound();
  }

  /**
   * The session mode the turn's run selects, set when it differs from the agent's: Plan mode
   * (`run.mode: "plan"`) selects the plan mode when the agent offers it, else the profile's `mode`
   * (an instance profile `{ "mode": "<session mode id>" }`). A profile with no `mode` runs, when it
   * is `bypass`, in the mode the session opened in; any other (the built-in `restricted` among
   * them) in the agent's asking mode (the flavor's `restrictedMode`, generic: `default`), never in
   * one the agent may have opened in that decides by itself (Claude Code's ACP agent opens in
   * `auto`). An agent offering modes none of which the flavor knows to ask, or not offering the
   * profile's mode, fails the turn's start (its permissions are at stake); an agent with no session
   * modes runs as it is. An unavailable Plan mode is a notice. A model the agent offers as a config
   * option (`category: "model"`) is selected the same way.
   */
  private async applyRun(run: RunSpec): Promise<void> {
    const profileMode = this.link.profiles[run.profile]?.mode;
    let want: string | undefined;
    /** No mode to run this profile's turn in: the agent's modes, none known to ask. */
    let unasked = false;
    if (typeof profileMode === 'string') want = profileMode;
    else if (run.profile === 'bypass' || !this.mode.available.length) want = this.mode.base;
    else {
      want = this.link.flavor.restrictedMode(this.mode.offered);
      unasked = want === undefined;
    }
    if (run.mode === 'plan') {
      const plan = this.link.planMode ?? this.link.flavor.planMode;
      if (this.mode.available.includes(plan)) {
        want = plan;
        unasked = false;
      } else this.notice('other', `Plan mode is not available on this agent (its modes: ${this.mode.available.join(', ') || 'none'})`);
    }
    if (unasked)
      throw new Error(
        `profile ${run.profile}: no session mode is configured for it (profiles.${run.profile}.mode) and the agent offers none known to ask before it acts (it has ${this.mode.available.map((m) => JSON.stringify(m)).join(', ')}); configure the mode its turns run in`,
      );
    if (want !== undefined && want !== this.mode.current) {
      if (!this.mode.available.includes(want))
        throw new Error(`profile ${run.profile}: the agent has no session mode ${JSON.stringify(want)} (it has ${this.mode.available.map((m) => JSON.stringify(m)).join(', ') || 'none'})`);
      await this.link.request('session/set_mode', { sessionId: this.sessionId, modeId: want });
      this.mode.current = want;
    }
    if (run.model) await this.applyModel(run.model);
  }

  private async applyModel(model: string): Promise<void> {
    const opt = this.configOptions.find((o) => o.category === 'model' && o.type === 'select') as (SessionConfigOption & { type: 'select'; currentValue: string; options: unknown[] }) | undefined;
    const values = opt ? (opt.options as { value?: string; options?: { value: string }[] }[]).flatMap((o) => (o.options ? o.options.map((x) => x.value) : o.value !== undefined ? [o.value] : [])) : [];
    if (!opt || !values.includes(model)) {
      if (!this.modelNoticed) this.notice('other', `model ${model}: the agent offers no such model choice; it runs its own`);
      this.modelNoticed = true;
      return;
    }
    if (opt.currentValue === model) return;
    const r = await this.link.request<{ configOptions?: SessionConfigOption[] }>('session/set_config_option', { sessionId: this.sessionId, configId: opt.id, value: model });
    if (r?.configOptions) this.configOptions = r.configOptions;
    else opt.currentValue = model;
  }

  async steer(_inputs: InputRecord[], _expectedTurnId: string): Promise<SteerResult> {
    return 'unsupported';
  }

  /**
   * `session/cancel`; every request the agent is waiting on is answered cancelled first (the
   * protocol asks that). The turn ends when the agent answers the prompt (`cancelled`), or after
   * `cancelTimeoutMs` anyway, as interrupted; a prompt still not answered then is stale: it keeps
   * the session until it answers (`outlast`).
   */
  async interrupt(turnId: string): Promise<void> {
    const t = this.turn;
    if (!t || t.done || t.turnId !== turnId) return;
    t.interrupted = true;
    this.cancelRequests(t.turnId);
    if (!t.cancelTimer) {
      t.cancelTimer = setTimeout(() => {
        if (t.done) return;
        this.finish(t, 'interrupted', { code: 'cancel_timeout', retryable: false, message: `the agent did not stop within ${this.link.cancelTimeoutMs}ms of session/cancel` });
        if (!t.isAnswered) this.stale = t;
      }, this.link.cancelTimeoutMs);
      t.cancelTimer.unref?.();
    }
    if (!this.link.gone) await this.link.notify('session/cancel', { sessionId: this.sessionId }).catch(() => undefined);
  }

  async respond(requestId: string, decision: Decision): Promise<void> {
    const r = this.requests.get(requestId);
    if (!r) throw new Error(`no open request ${requestId}`);
    this.requests.delete(requestId);
    const resolved = (d: Decision | null) => this.emit({ t: 'request.resolved', requestId, decision: d, by: { kind: 'host' } }, { turnId: r.turnId });
    if (r.kind === 'permission') {
      let outcome: RequestPermissionOutcome;
      try {
        outcome = permissionOutcome(r.options ?? [], decision);
      } catch (e) {
        // A decision that picks nothing offered is answered as a deny, and said so.
        const deny = permissionOutcome(r.options ?? [], { kind: 'deny' });
        r.answer({ outcome: deny });
        resolved({ kind: 'deny', message: (e as Error).message });
        throw new Error(`request ${requestId}: ${(e as Error).message}; answered as a deny`);
      }
      r.answer({ outcome });
      resolved(decision);
    } else {
      let answer: CreateElicitationResponse;
      if (decision.kind === 'answer') answer = { action: 'accept', content: elicitationContent(r.properties ?? {}, decision.answers) };
      else if (decision.kind === 'native' && decision.payload && typeof decision.payload === 'object' && typeof (decision.payload as { action?: unknown }).action === 'string') answer = decision.payload as CreateElicitationResponse;
      else if (decision.kind === 'deny') answer = { action: 'decline' };
      else {
        r.answer({ action: 'decline' });
        resolved({ kind: 'deny', message: `a ${decision.kind} decision is no answer to a question` });
        throw new Error(`request ${requestId}: a ${decision.kind} decision is no answer to a question; answered as a decline`);
      }
      r.answer(answer);
      resolved(decision);
    }
    if (decision.kind === 'deny' && decision.interruptTurn) await this.interrupt(r.turnId);
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    const t = this.turn;
    if (t && !t.done) {
      this.cancelRequests(t.turnId);
      if (!this.link.gone) void this.link.notify('session/cancel', { sessionId: this.sessionId }).catch(() => undefined);
      this.finish(t, 'interrupted', { code: 'session_closed', retryable: false, message: reason });
    }
    this.link.forget(this);
    if (this.link.closes && !this.link.gone) await this.link.request('session/close', { sessionId: this.sessionId }, 5_000).catch(() => undefined);
    this.queue.close();
  }

  /** The agent process is gone: a running turn's outcome is unknown, and the session ends. */
  lost(reason: string): void {
    const t = this.turn;
    if (t && !t.done) {
      for (const [id, r] of this.requests) if (r.turnId === t.turnId) this.dropRequest(id);
      this.finish(t, 'ambiguous', { code: 'agent_exited', retryable: false, message: reason });
    }
    this.closed = true;
    this.wake?.();
    this.queue.close();
  }

  private finish(t: Turn, status: BodyOf<'turn.completed'>['status'], error?: BodyOf<'turn.completed'>['error']): void {
    if (t.done) return;
    t.done = true;
    if (t.cancelTimer) clearTimeout(t.cancelTimer);
    this.endMessage(t);
    this.cancelRequests(t.turnId);
    // Items the agent never finished: closed, so the turn's stream is whole (HC-1).
    for (const [itemId, s] of t.items) this.emit({ t: 'item.completed', item: { ...s.item, status: 'skipped' } }, { turnId: t.turnId, itemId });
    t.items.clear();
    // An input the model may not have read took its preface with it.
    if (!t.consumed) this.memo.reset();
    const words = t.lastWords.trim();
    if (status === 'completed' && words) this.emit({ t: 'text.snapshot', text: words, final: true }, { turnId: t.turnId });
    const body: BodyOf<'turn.completed'> = { t: 'turn.completed', turnId: t.turnId, status };
    if (t.usage !== undefined) body.usage = t.usage;
    if (error && status !== 'completed') body.error = error;
    this.emit(body, { turnId: t.turnId });
    if (this.turn === t) this.turn = undefined;
  }

  /** The agent took the turn's inputs: it answered or said something about the prompt. */
  private consume(t: Turn): void {
    if (t.consumed || t.done) return;
    t.consumed = true;
    if (t.inputIds.length) this.emit({ t: 'input.consumed', inputIds: t.inputIds, turnId: t.turnId }, { turnId: t.turnId });
  }

  // ---- what the agent sends -----------------------------------------------------

  /**
   * A `session/update`: an event of the running turn, else (a load's replay, advertisements between
   * turns) only what the session knows; while a stale prompt holds the session, `native` (no turn's).
   */
  update(n: SessionNotification): void {
    const u = n?.update as (SessionNotification['update'] & Record<string, unknown>) | undefined;
    if (!u || typeof u !== 'object') return;
    switch (u.sessionUpdate) {
      case 'available_commands_update':
        this.link.learned({ commands: (u.availableCommands as AcpCommand[]) ?? [] });
        return;
      case 'current_mode_update':
        this.mode.current = u.currentModeId as string;
        return;
      case 'config_option_update':
        this.configOptions = (u.configOptions as SessionConfigOption[]) ?? this.configOptions;
        return;
      case 'session_info_update':
        return;
    }
    if (this.stale) return this.native(u);
    const t = this.turn;
    if (!t || t.done) return;
    this.consume(t);
    const at = { turnId: t.turnId };
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const c = u.content as { type: string; text?: string };
        if (c.type !== 'text' || typeof c.text !== 'string') return this.native(u, t.turnId);
        const messageId = typeof u.messageId === 'string' ? u.messageId : undefined;
        if (t.msg && messageId !== undefined && t.msg.messageId !== undefined && messageId !== t.msg.messageId) {
          this.endMessage(t);
          if (t.lastWords) t.lastWords += '\n\n';
        }
        t.msg ??= { text: '', ...(messageId !== undefined ? { messageId } : {}) };
        t.msg.text += c.text;
        t.lastWords += c.text;
        this.emit({ t: 'text.delta', delta: c.text, stream: 'answer' }, at);
        return;
      }
      case 'agent_thought_chunk': {
        const c = u.content as { type: string; text?: string };
        if (c.type !== 'text' || typeof c.text !== 'string') return this.native(u, t.turnId);
        this.emit({ t: 'text.delta', delta: c.text, stream: 'reasoning' }, at);
        return;
      }
      case 'user_message_chunk':
        return;
      case 'tool_call':
      case 'tool_call_update':
        if (typeof u.toolCallId !== 'string' || !u.toolCallId) return this.native(u, t.turnId);
        return this.toolCall(t, u as unknown as ToolUpdate);
      case 'plan': {
        const entries = (Array.isArray(u.entries) ? (u.entries as { content?: unknown; status?: unknown }[]) : []).filter((e): e is { content: string; status: unknown } => typeof e?.content === 'string');
        this.emit({ t: 'plan.updated', steps: entries.map((e) => ({ text: e.content, status: e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending' })) }, at);
        return;
      }
      case 'usage_update':
        t.usage = { used: u.used, size: u.size, ...(u.cost ? { cost: u.cost } : {}) };
        return;
      default:
        return this.native(u, t.turnId);
    }
  }

  private native(u: { sessionUpdate?: unknown }, turnId?: string): void {
    this.emit({ t: 'native', name: `acp/session_update/${String(u.sessionUpdate)}` }, { ...(turnId ? { turnId } : {}), native: u });
  }

  /** The message being written ends (a tool call, another message, the turn's end): its text as a snapshot. */
  private endMessage(t: Turn): void {
    const m = t.msg;
    t.msg = undefined;
    if (m?.text) this.emit({ t: 'text.snapshot', text: m.text, final: false }, { turnId: t.turnId });
  }

  private toolCall(t: Turn, u: ToolUpdate): void {
    const id = u.toolCallId;
    const at = { turnId: t.turnId, itemId: id };
    let s = t.items.get(id);
    const first = !s;
    if (!s) {
      this.endMessage(t);
      t.lastWords = '';
      const view: AcpToolCallView = { toolCallId: id };
      s = { view, item: { itemId: id, type: 'tool', title: id, status: 'running' } };
      t.items.set(id, s);
    }
    const v = s.view;
    if (typeof u.title === 'string') v.title = u.title;
    if (typeof u.name === 'string') v.name = u.name;
    if (typeof u.kind === 'string') v.kind = u.kind;
    if (u.rawInput !== undefined) v.rawInput = u.rawInput;
    if (u._meta && typeof u._meta === 'object') v.meta = u._meta as Record<string, unknown>;
    // The agent compacting its context (on its own too) may drop what the model was shown (ID-2).
    if (this.link.flavor.compaction(v)) this.memo.reset();
    const tool = this.link.flavor.mcpTool(v);
    const sub = !tool && this.link.flavor.subagent(v);
    const label = tool ? `${tool.server}.${tool.name}` : undefined;
    const title = label ? (v.title && v.title !== v.name && !v.title.startsWith('mcp__') ? `${label}: ${v.title}` : label) : (v.title ?? id);
    const summary = inputSummary(v.rawInput, u.locations ?? null);
    s.item = {
      ...s.item,
      type: itemTypeOf(v, tool, sub),
      title,
      ...(summary ? { inputSummary: summary } : {}),
      ...(tool ? { tool } : {}),
    };
    if (first) this.emit({ t: 'item.started', item: { ...s.item, status: 'running' } }, at);
    const files = diffFiles(u.content);
    if (files.length) this.emit({ t: 'diff.updated', files }, at);
    const status = itemStatus(u.status ?? undefined);
    if (status === 'running') {
      const r = resultOf(u.content, undefined, false);
      if (!first && r) this.emit({ t: 'item.progress', itemId: id, text: r.preview.split('\n').at(-1) ?? '' }, at);
      return;
    }
    const result = resultOf(u.content, u.rawOutput, status === 'failed');
    t.items.delete(id);
    this.emit({ t: 'item.completed', item: { ...s.item, status, ...(result ? { result } : {}) } }, at);
  }

  /** `session/request_permission`: a request of the running turn; outside one it is answered cancelled. */
  permission(p: { toolCall: ToolUpdate; options: PermissionOption[] }, signal: AbortSignal): Promise<{ outcome: RequestPermissionOutcome }> {
    const t = this.turn;
    if (!t || t.done || this.closed) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    this.consume(t);
    // The tool call it is about, if the agent did not announce it before asking.
    if (p.toolCall?.toolCallId && !t.items.has(p.toolCall.toolCallId)) this.toolCall(t, { ...p.toolCall, status: p.toolCall.status ?? 'pending' });
    const requestId = `acp-permission-${++this.nextRequest}`;
    const kind = p.toolCall?.kind ?? t.items.get(p.toolCall?.toolCallId)?.view.kind;
    const options = Array.isArray(p.options) ? p.options : [];
    const always = options.filter((o) => o.kind === 'allow_always' || o.kind === 'reject_always');
    const preview = inputSummary(p.toolCall?.rawInput, p.toolCall?.locations ?? null);
    return new Promise((resolve) => {
      this.requests.set(requestId, { requestId, turnId: t.turnId, kind: 'permission', options, answer: (v) => resolve(v as { outcome: RequestPermissionOutcome }) });
      this.emit(
        {
          t: 'request.opened',
          requestId,
          kind: permissionKind(kind),
          title: p.toolCall?.title ?? t.items.get(p.toolCall?.toolCallId)?.view.title ?? 'Permission requested',
          risk: riskOf(kind),
          ...(preview ? { inputPreview: preview } : {}),
          ...(always.length ? { suggestions: always.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })) } : {}),
          allowedDecisions: permissionDecisions(options),
          allowAlways: options.some((o) => o.kind === 'allow_always'),
          defaultDeny: true,
        },
        { turnId: t.turnId, ...(p.toolCall?.toolCallId ? { itemId: p.toolCall.toolCallId } : {}) },
      );
      // The agent withdrew it (`$/cancel_request`).
      signal.addEventListener('abort', () => this.dropRequest(requestId), { once: true });
    });
  }

  /** `elicitation/create` in form mode: a question of the running turn; anything else is declined. */
  elicitation(p: { mode?: string; message?: string; requestedSchema?: AcpElicitationForm['requestedSchema'] }, signal: AbortSignal): Promise<CreateElicitationResponse> {
    const t = this.turn;
    if (!t || t.done || this.closed) return Promise.resolve({ action: 'cancel' });
    if (p.mode !== 'form' || !p.requestedSchema) {
      this.notice('other', `declined an elicitation of mode ${JSON.stringify(p.mode)}: only forms are supported`);
      return Promise.resolve({ action: 'decline' });
    }
    this.consume(t);
    const form: AcpElicitationForm = { message: p.message ?? '', requestedSchema: p.requestedSchema };
    const requestId = `acp-question-${++this.nextRequest}`;
    return new Promise((resolve) => {
      this.requests.set(requestId, { requestId, turnId: t.turnId, kind: 'elicitation', properties: form.requestedSchema.properties ?? {}, answer: (v) => resolve(v as CreateElicitationResponse) });
      // The agent asks its user: a `question` (as Codex's `requestUserInput`), which the host asks
      // the turn's person and never approves for them; `elicitation` is an MCP server's ask.
      this.emit(
        {
          t: 'request.opened',
          requestId,
          kind: 'question',
          title: form.message || form.requestedSchema.title || 'The agent asks',
          risk: {},
          questions: this.link.flavor.elicitationQuestions(form),
          allowedDecisions: ['answer', 'deny', 'native'],
          allowAlways: false,
          defaultDeny: false,
        },
        { turnId: t.turnId },
      );
      signal.addEventListener('abort', () => this.dropRequest(requestId), { once: true });
    });
  }

  /** Answer every open request of the turn cancelled (`request.resolved` by `runtime_cancelled`). */
  private cancelRequests(turnId: string): void {
    for (const [id, r] of [...this.requests]) {
      if (r.turnId !== turnId) continue;
      this.requests.delete(id);
      r.answer(r.kind === 'permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' });
      this.emit({ t: 'request.resolved', requestId: id, decision: null, by: 'runtime_cancelled' }, { turnId });
    }
  }

  /** The agent no longer waits for a request (it withdrew it, or is gone): resolved by `runtime_cancelled`, nothing to answer. */
  private dropRequest(requestId: string): void {
    const r = this.requests.get(requestId);
    if (!r) return;
    this.requests.delete(requestId);
    r.answer(r.kind === 'permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' });
    this.emit({ t: 'request.resolved', requestId, decision: null, by: 'runtime_cancelled' }, { turnId: r.turnId });
  }
}

/** `tool_call` and `tool_call_update` as one shape (all but the id optional). */
interface ToolUpdate {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: ToolCallContent[] | null;
  locations?: { path: string }[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: unknown;
}
