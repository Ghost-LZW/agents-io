import { PrefaceMemo, type BlobAccess, type Body, type BodyOf, type Decision, type HarnessEvent, type HarnessSession, type InputRecord, type ItemSummary, type RunSpec, type SteerResult } from '@agents-io/protocol';
import type {
  CreateElicitationResponse,
  PermissionOption,
  PromptResponse,
  RequestPermissionOutcome,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  ToolCallContent,
} from '@agentclientprotocol/sdk';
import type { AcpCommand, AcpElicitationForm, AcpFlavor, AcpToolCallView } from './flavors.js';
import {
  diffFiles,
  elicitationContent,
  inputSummary,
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
  /** How long `interrupt` waits for the prompt to stop before ending the turn anyway. */
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
  private readonly requests = new Map<string, OpenRequest>();
  private nextRequest = 0;
  private closed = false;
  private readonly memo = new PrefaceMemo();
  /** Session modes: the one the agent is in, the one it opened in (a profile without a mode goes back to it), and what it offers. */
  private mode: { current?: string; base?: string; available: string[] } = { available: [] };
  private configOptions: SessionConfigOption[] = [];
  private modelNoticed = false;

  constructor(
    private readonly link: AcpLink,
    /** The ACP session id: the native id. */
    readonly sessionId: string,
  ) {}

  nativeId(): string {
    return this.sessionId;
  }

  /** What `session/new` or `session/load` answered: the session's modes and config options. */
  setup(o: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null }): void {
    if (o.modes) this.mode = { current: o.modes.currentModeId, base: o.modes.currentModeId, available: o.modes.availableModes.map((m) => m.id) };
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
    if (this.closed) throw new Error('acp session is closed');
    if (this.link.gone) throw new Error('the ACP agent process is gone');
    if (this.turn && !this.turn.done) throw new Error('turn already active');
    if (run) await this.applyRun(run);
    const prompt = await renderPrompt(inputs, { ...(this.link.blobs ? { blobs: this.link.blobs } : {}), support: this.link.support, memo: this.memo });
    const t: Turn = { turnId, inputIds: inputs.map((i) => i.inputId), consumed: false, done: false, lastWords: '', items: new Map(), interrupted: false };
    this.turn = t;
    this.emit({ t: 'turn.started', turnId, inputIds: t.inputIds, replyRoute: inputs[0]?.replyRoute ?? null, ...(run ? { run } : {}) }, { turnId });
    this.link.prompt({ sessionId: this.sessionId, prompt }).then(
      (r) => {
        this.consume(t);
        // The prompt's own usage when the agent reports it, else its last usage update.
        const usage = (r as { usage?: unknown }).usage;
        if (usage !== undefined && usage !== null) t.usage = usage;
        const o = turnOutcome(r.stopReason);
        this.finish(t, o.status, o.error);
      },
      (err: Error) => {
        if (this.link.gone) return this.finish(t, 'ambiguous', { code: 'agent_exited', retryable: false, message: 'the ACP agent process exited during the turn' });
        // The agent answered the prompt with an error: it did not run it (its inputs were not consumed) unless it said something first.
        this.finish(t, t.interrupted ? 'interrupted' : 'failed', { code: 'prompt_failed', retryable: false, message: err.message });
      },
    );
  }

  /**
   * The session mode the turn's run selects, set when it differs from the agent's: Plan mode
   * (`run.mode: "plan"`) selects the plan mode when the agent offers it, else the profile's `mode`
   * (an instance profile `{ "mode": "<session mode id>" }`), else the mode the session opened in. A
   * profile's mode the agent does not offer fails the turn's start (its permissions are at stake);
   * an unavailable Plan mode is a notice. A model the agent offers as a config option (`category:
   * "model"`) is selected the same way.
   */
  private async applyRun(run: RunSpec): Promise<void> {
    const profileMode = this.link.profiles[run.profile]?.mode;
    let want = typeof profileMode === 'string' ? profileMode : this.mode.base;
    if (run.mode === 'plan') {
      const plan = this.link.planMode ?? this.link.flavor.planMode;
      if (this.mode.available.includes(plan)) want = plan;
      else this.notice('other', `Plan mode is not available on this agent (its modes: ${this.mode.available.join(', ') || 'none'})`);
    }
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
   * `cancelTimeoutMs` anyway, as interrupted.
   */
  async interrupt(turnId: string): Promise<void> {
    const t = this.turn;
    if (!t || t.done || t.turnId !== turnId) return;
    t.interrupted = true;
    this.cancelRequests(t.turnId);
    if (!t.cancelTimer) {
      t.cancelTimer = setTimeout(() => this.finish(t, 'interrupted', { code: 'cancel_timeout', retryable: false, message: `the agent did not stop within ${this.link.cancelTimeoutMs}ms of session/cancel` }), this.link.cancelTimeoutMs);
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

  /** A `session/update`: an event of the running turn, else (a load's replay, advertisements between turns) only what the session knows. */
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
      this.emit(
        {
          t: 'request.opened',
          requestId,
          kind: 'elicitation',
          title: form.message || form.requestedSchema.title || 'The agent asks',
          risk: {},
          questions: this.link.flavor.elicitationQuestions(form),
          allowedDecisions: ['answer', 'deny', 'native'],
          allowAlways: false,
          defaultDeny: true,
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
}
