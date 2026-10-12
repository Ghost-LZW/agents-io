import { randomUUID } from 'node:crypto';
import type {
  Decision,
  HarnessAdapter,
  HarnessCaps,
  HarnessEvent,
  HarnessOpenArgs,
  HarnessSession,
  InputRecord,
  RunSpec,
  SteerResult,
} from '@agents-io/protocol';
import { preface } from './content.js';
import { AsyncQueue } from './queue.js';
import { inputSummary, itemTitle, itemType, planSteps, preview, resultText, riskOf } from './tools.js';

/**
 * Claude Code's own interactive TUI as the harness of a session (decision 15). The host provides
 * a link to one running TUI: messages go into its inbox socket (through a bridge the TUI runs
 * itself, so they carry its peer token), and what the TUI does comes back as hook calls. There is
 * no acknowledgement on the inbox: a message counts as consumed once written. The session ends
 * when the link's hooks end (the TUI exited); the host then opens the headless adapter on the same
 * Claude session id.
 */

/** One hook call from the TUI. */
export interface TuiHook {
  /** `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PermissionRequest`, … */
  event: string;
  body: Record<string, unknown>;
  /** `PermissionRequest`: answer it (once); the TUI's own dialog may answer first. */
  answer?: (output: unknown) => void;
  /** `PermissionRequest`: called if the TUI stops waiting for the answer (answered in the terminal). */
  onAbandoned?: (fn: () => void) => void;
}

export interface TuiLink {
  /** Put one user message into the TUI. */
  send(text: string): Promise<void>;
  /** Hook calls, in order; ends when the TUI is gone. */
  readonly hooks: AsyncIterable<TuiHook>;
  close(): void;
}

/** A file a message refers to, as the TUI can read it. */
export type TuiFileOf = (ref: string) => Promise<{ path: string; mime: string; name?: string } | undefined>;

export const claudeTuiCaps: HarnessCaps = {
  // Messages written while a turn runs are read after the current tool call.
  steer: 'tool_boundary',
  // No way in from outside: Esc in the terminal.
  interrupt: false,
  approvals: true,
  questions: false,
  tokenDeltas: false,
  cancelQueued: false,
  injectWithoutTurn: false,
  resume: true,
  switchModelMidSession: false,
  switchProfileMidSession: false,
};

export class ClaudeTuiHarness implements HarnessAdapter {
  constructor(
    /** The Claude instance this TUI stands in for: events and the resume id stay that instance's. */
    readonly id: string,
    private readonly o: { nativeId: string; link: (args: HarnessOpenArgs) => TuiLink; fileOf?: TuiFileOf },
  ) {}

  async probe(): Promise<{ version: string; caps: HarnessCaps }> {
    return { version: 'tui', caps: claudeTuiCaps };
  }

  async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    return new ClaudeTuiSession(this.o.nativeId, this.o.link(args), this.o.fileOf);
  }
}

interface Turn {
  turnId: string;
  /** Started by the session layer (startTurn), else by someone typing in the terminal. */
  host: boolean;
  marker?: string;
  promptId?: string;
}

const STEER_TAG = '[agents-io steer';

export class ClaudeTuiSession implements HarnessSession {
  private readonly queue = new AsyncQueue<HarnessEvent>();
  readonly events: AsyncIterable<HarnessEvent> = this.queue;
  private turn: Turn | undefined;
  private readonly permissions = new Map<string, { answer: (out: unknown) => void; done: boolean }>();
  private closed = false;

  constructor(
    private readonly sid: string,
    private readonly link: TuiLink,
    private readonly fileOf?: TuiFileOf,
  ) {
    this.push({ t: 'session.bound', nativeId: sid });
    void this.pump();
  }

  nativeId(): string {
    return this.sid;
  }

  async startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void> {
    if (this.turn) throw new Error('a turn is running in the terminal');
    const marker = `[agents-io turn ${turnId}]`;
    this.turn = { turnId, host: true, marker };
    const inputIds = inputs.map((i) => i.inputId);
    this.push({ t: 'turn.started', turnId, inputIds, replyRoute: inputs[0]?.replyRoute ?? null, initiator: 'host', ...(run ? { run } : {}) }, { turnId });
    try {
      await this.link.send(`${marker}\n${await this.render(inputs)}`);
    } catch (e) {
      this.turn = undefined;
      this.push({ t: 'turn.completed', turnId, status: 'failed', error: { code: 'tui_unreachable', retryable: true, message: (e as Error).message } }, { turnId });
      return;
    }
    this.push({ t: 'input.consumed', inputIds, turnId }, { turnId });
  }

  async steer(inputs: InputRecord[], expectedTurnId: string): Promise<SteerResult> {
    const t = this.turn;
    if (!t) return 'no_active_turn';
    if (t.turnId !== expectedTurnId) return 'stale';
    await this.link.send(`${STEER_TAG} ${t.turnId}]\n${await this.render(inputs)}`);
    this.push({ t: 'input.consumed', inputIds: inputs.map((i) => i.inputId), turnId: t.turnId }, { turnId: t.turnId });
    return 'steered';
  }

  async interrupt(_turnId: string): Promise<void> {
    throw new Error('a terminal UI session cannot be interrupted from outside: press Esc in the terminal');
  }

  async respond(requestId: string, decision: Decision): Promise<void> {
    const p = this.permissions.get(requestId);
    if (!p || p.done) return;
    p.done = true;
    const allow = decision.kind === 'allow_once' || decision.kind === 'allow_session';
    p.answer({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: allow ? { behavior: 'allow' } : { behavior: 'deny', ...(decision.kind === 'deny' && decision.message ? { message: decision.message } : {}) },
      },
    });
    this.push({ t: 'request.resolved', requestId, decision, by: { kind: 'host' } });
  }

  async close(_reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Requests still waiting go back to the terminal's own dialog.
    for (const p of this.permissions.values()) if (!p.done) p.answer({});
    this.link.close();
    this.queue.close();
  }

  private async pump(): Promise<void> {
    try {
      for await (const h of this.link.hooks) {
        if (this.closed) break;
        this.onHook(h);
      }
    } finally {
      for (const p of this.permissions.values()) p.done = true;
      this.closed = true;
      this.queue.close();
    }
  }

  private onHook(h: TuiHook): void {
    const b = h.body;
    switch (h.event) {
      case 'UserPromptSubmit': {
        const prompt = typeof b.prompt === 'string' ? b.prompt : '';
        const promptId = typeof b.prompt_id === 'string' ? b.prompt_id : undefined;
        const t = this.turn;
        if (t?.marker && prompt.includes(t.marker)) {
          if (promptId) t.promptId = promptId;
          return;
        }
        if (prompt.startsWith(STEER_TAG)) return;
        // Typed in the terminal: a turn of its own when none runs (it has no reply route).
        if (!t) this.foreignTurn(promptId);
        const turnId = this.turn!.turnId;
        this.push({ t: 'item.completed', item: { itemId: `prompt_${promptId ?? randomUUID()}`, type: 'user_message', title: oneLine(prompt, 120), status: 'completed' } }, { turnId });
        return;
      }
      case 'PreToolUse': {
        const turnId = this.turn?.turnId ?? this.foreignTurn(undefined);
        const tool = String(b.tool_name ?? 'tool');
        const summary = inputSummary(tool, b.tool_input);
        this.push({ t: 'item.started', item: { itemId: toolId(b), type: itemType(tool), title: itemTitle(tool, b.tool_input), status: 'running', ...(summary ? { inputSummary: summary } : {}) } }, { turnId });
        const steps = planSteps(tool, b.tool_input);
        if (steps) this.push({ t: 'plan.updated', steps }, { turnId });
        return;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const turnId = this.turn?.turnId ?? this.foreignTurn(undefined);
        const tool = String(b.tool_name ?? 'tool');
        const failed = h.event === 'PostToolUseFailure';
        const text = failed ? String(b.error ?? 'failed') : resultText((b.tool_response as { content?: unknown } | undefined)?.content ?? b.tool_response);
        const p = preview(text, 400);
        this.push(
          { t: 'item.completed', item: { itemId: toolId(b), type: itemType(tool), title: itemTitle(tool, b.tool_input), status: failed ? 'failed' : 'completed', result: { preview: p.preview, truncated: p.truncated, isError: failed } } },
          { turnId },
        );
        return;
      }
      case 'PermissionRequest': {
        if (!h.answer) return;
        const turnId = this.turn?.turnId ?? this.foreignTurn(undefined);
        const tool = String(b.tool_name ?? 'tool');
        const requestId = `tui_perm_${randomUUID()}`;
        const entry = { answer: h.answer, done: false };
        this.permissions.set(requestId, entry);
        const summary = inputSummary(tool, b.tool_input);
        this.push(
          {
            t: 'request.opened',
            requestId,
            kind: 'tool_approval',
            title: itemTitle(tool, b.tool_input),
            risk: riskOf(tool, b.tool_input),
            ...(summary ? { inputPreview: summary } : {}),
            allowedDecisions: ['allow_once', 'deny'],
            allowAlways: false,
            defaultDeny: true,
          },
          { turnId, audience: 'approval' },
        );
        // Answered in the terminal first: the request is over, whatever the answer was.
        h.onAbandoned?.(() => {
          if (entry.done) return;
          entry.done = true;
          this.push({ t: 'request.resolved', requestId, decision: null, by: { kind: 'harness' } }, { turnId });
        });
        return;
      }
      case 'Stop': {
        const t = this.turn;
        if (!t) return;
        this.turn = undefined;
        const text = typeof b.last_assistant_message === 'string' ? b.last_assistant_message : '';
        if (text) this.push({ t: 'text.snapshot', text, final: true }, { turnId: t.turnId, audience: 'answer' });
        for (const [id, p] of this.permissions) if (!p.done) this.permissions.delete(id);
        this.push({ t: 'turn.completed', turnId: t.turnId, status: 'completed' }, { turnId: t.turnId });
        return;
      }
    }
  }

  /** A turn someone started by typing in the terminal. */
  private foreignTurn(promptId: string | undefined): string {
    const turnId = `tui_${promptId ?? randomUUID()}`;
    this.turn = { turnId, host: false, ...(promptId ? { promptId } : {}) };
    this.push({ t: 'turn.started', turnId, inputIds: [], replyRoute: null, initiator: 'foreign', ...(promptId ? { nativeTurnId: promptId } : {}) }, { turnId });
    return turnId;
  }

  /** The inputs as one text message: each with its source line; files as paths the TUI can read. */
  private async render(inputs: InputRecord[]): Promise<string> {
    const parts: string[] = [];
    for (const i of inputs) {
      const body: string[] = [];
      for (const c of i.content) {
        if (c.type === 'text') body.push(c.text);
        else if (c.type === 'quote') body.push(`> ${c.text.split('\n').join('\n> ')}`);
        else if (c.type === 'image' || c.type === 'file' || c.type === 'audio') {
          const f = this.fileOf ? await this.fileOf(c.ref).catch(() => undefined) : undefined;
          const name = ('name' in c && c.name) || f?.name;
          body.push(f ? `[${c.type}${name ? ` ${name}` : ''} (${f.mime}) at ${f.path}]` : `[${c.type}${name ? ` ${name}` : ''}: ${c.ref}, not available locally]`);
        } else if (c.type === 'transcript') body.push(`${c.speaker ? `${c.speaker}: ` : ''}${c.text}`);
        else if (c.type === 'event') body.push(`[event ${c.name}] ${JSON.stringify(c.data).slice(0, 2000)}`);
      }
      parts.push(`${preface(i)}\n${body.join('\n')}`);
    }
    return parts.join('\n\n');
  }

  private push(body: HarnessEvent['body'], extra: Partial<Omit<HarnessEvent, 'body'>> = {}): void {
    if (this.queue.isClosed) return;
    const audience = body.t === 'text.snapshot' ? 'answer' : 'status';
    this.queue.push({ ts: Date.now(), level: 'primary', audience, durability: 'durable', ...extra, body } as HarnessEvent);
  }
}

function toolId(b: Record<string, unknown>): string {
  return typeof b.tool_use_id === 'string' ? b.tool_use_id : `tool_${String(b.tool_name ?? '')}_${JSON.stringify(b.tool_input ?? '').length}`;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
