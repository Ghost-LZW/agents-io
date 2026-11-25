import type { BodyOf, ContentBlock as AioBlock, Decision, ItemSummary, SessionEvent } from '@agents-io/protocol';
import type { PermissionOption, SessionUpdate, StopReason, ToolCallStatus, ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk';

/*
 * The ACP projection (core-slimming G9, north): a session's log as an ACP agent's `session/update`
 * notifications, the requests a client may answer as `session/request_permission` (an approval) or a
 * form `elicitation/create` (a question), and how each turn ends as a prompt's stop reason. Pure: the
 * same events give the same output (`packages/testkit/conformance/projections/acp/` pins the table,
 * INVARIANTS PR-4). The south's table, read the other way, is `harness/acp/src/map.ts` (the ACP
 * harness); `packages/daemon/test/acp-tables.local.test.ts` checks the two agree.
 *
 * | agents-io event | ACP |
 * |---|---|
 * | `text.delta` (answer) | `agent_message_chunk` (`messageId` `<turnId>:<n>`) |
 * | `text.delta` (reasoning) | `agent_thought_chunk` |
 * | `text.snapshot` | the rest of the message not streamed yet; a turn's final answer that repeats what was said is not said again |
 * | `turn.started` (its inputs) | `user_message_chunk` per input (someone else's prefixed `[<principal>] `) |
 * | `item.started` / `item.completed` (tool-like items) | `tool_call` / `tool_call_update` (`toolCallId` the item id) |
 * | `plan.updated` | `plan` |
 * | `request.opened` | `tool_call` (`request:<id>`, pending); for the client to answer (its principal among a `human` resolver's): `session/request_permission`, or a form elicitation for a question |
 * | `request.resolved` | `tool_call_update` (completed when allowed or answered, else failed) |
 * | `turn.completed` | the prompt's stop reason: `end_turn`, `cancelled` (interrupted), `refusal` / `max_tokens` / `max_turn_requests`; else an error |
 */

/** What the projection gives for one event. */
export type AcpOut =
  /** A `session/update` (the caller adds `sessionId`); `inputId` for a user message: the input it shows. */
  | { update: SessionUpdate; inputId?: string }
  /** A request the client may answer: `session/request_permission`. */
  | { permission: { requestId: string; toolCall: ToolCallUpdate; options: PermissionOption[] } }
  /** A question the client may answer: a form `elicitation/create` (when the client takes forms). */
  | { question: { requestId: string; message: string; requestedSchema: AcpFormSchema } }
  /** A turn ended: the stop reason of the prompts whose inputs it took, or the error they answer. */
  | { turnEnd: { turnId: string; stopReason: StopReason } | { turnId: string; error: { code: string; message: string } } };

/** A form elicitation's schema (ACP `ElicitationSchema`, the subset the projection writes). */
export interface AcpFormSchema {
  type: 'object';
  properties: Record<string, { type: 'string'; title: string; oneOf?: { const: string; title: string }[] } | { type: 'array'; title: string; items: { anyOf: { const: string; title: string }[] } }>;
  required: string[];
}

/** Item types that are a tool call to an ACP client (the rest are text, shown as messages). */
const NOT_TOOLS = new Set<ItemSummary['type']>(['agent_message', 'user_message', 'reasoning']);

/** An item's type as an ACP tool kind (the ACP harness reads it back: `itemTypeOf`). */
export function toolKindOf(type: ItemSummary['type']): ToolKind {
  switch (type) {
    case 'command':
      return 'execute';
    case 'file_change':
      return 'edit';
    case 'web_search':
      return 'fetch';
    default:
      return 'other';
  }
}

/** An item's status as an ACP tool call status (the ACP harness reads it back: `itemStatus`). */
export function toolStatusOf(s: ItemSummary['status']): ToolCallStatus {
  return s === 'running' ? 'in_progress' : s === 'completed' ? 'completed' : 'failed';
}

/** A request's kind as the tool kind of its pending tool call. */
const requestKind = (k: BodyOf<'request.opened'>['kind']): ToolKind => (k === 'file_change' ? 'edit' : k === 'tool_approval' ? 'execute' : 'other');

/** How a turn ended as a prompt's stop reason (the ACP harness reads it back: `turnOutcome`), or the error a prompt answers. */
export function stopReasonOf(b: BodyOf<'turn.completed'>): { stopReason: StopReason } | { error: { code: string; message: string } } {
  if (b.status === 'completed') return { stopReason: 'end_turn' };
  if (b.status === 'interrupted') return { stopReason: 'cancelled' };
  const code = b.error?.code;
  if (b.status === 'failed' && (code === 'refusal' || code === 'max_tokens' || code === 'max_turn_requests')) return { stopReason: code };
  return { error: { code: code ?? b.status, message: b.error?.message ?? `the turn ended ${b.status}` } };
}

/**
 * The options of a permission request (`request.opened.allowedDecisions`, `allowAlways`): allow
 * once, allow for the session ("always", only where the request allows it), deny. The option id is
 * the decision's kind (`permissionDecision` reads it back). An empty `allowedDecisions` allows any.
 */
export function permissionOptions(b: Pick<BodyOf<'request.opened'>, 'allowedDecisions' | 'allowAlways'>): PermissionOption[] {
  const any = b.allowedDecisions.length === 0;
  const has = (k: string) => any || b.allowedDecisions.includes(k);
  const out: PermissionOption[] = [];
  if (has('allow_once')) out.push({ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' });
  if (b.allowAlways && has('allow_session')) out.push({ optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' });
  if (has('deny')) out.push({ optionId: 'deny', name: 'Deny', kind: 'reject_once' });
  return out;
}

/** The decision an option picked (`permissionOptions`); undefined for an id it did not give. */
export function permissionDecision(optionId: string): Decision | undefined {
  if (optionId === 'allow_once') return { kind: 'allow_once' };
  if (optionId === 'allow_session') return { kind: 'allow_session' };
  if (optionId === 'deny') return { kind: 'deny' };
  return undefined;
}

/** A question request's form: one property per question (a choice as `oneOf`, several as an array), each required. */
export function questionForm(b: BodyOf<'request.opened'>): AcpFormSchema | undefined {
  const qs = b.questions ?? [];
  if (!qs.length) return undefined;
  const properties: AcpFormSchema['properties'] = {};
  for (const q of qs) {
    const opts = (q.options ?? []).map((o) => ({ const: o.label, title: o.label }));
    properties[q.id] = q.multiSelect && opts.length ? { type: 'array', title: q.text, items: { anyOf: opts } } : { type: 'string', title: q.text, ...(opts.length ? { oneOf: opts } : {}) };
  }
  return { type: 'object', properties, required: qs.map((q) => q.id) };
}

/** An accepted form's content as an answer (`Decision` `answer`): each question's string, or strings. */
export function questionDecision(b: BodyOf<'request.opened'>, content: Record<string, unknown> | null | undefined): Decision {
  const answers: Record<string, string | string[]> = {};
  for (const q of b.questions ?? []) {
    const v = content?.[q.id];
    if (Array.isArray(v)) answers[q.id] = v.map(String);
    else if (v !== undefined && v !== null) answers[q.id] = String(v);
  }
  return { kind: 'answer', answers };
}

/** The text of an input's content, as a user message shows it. */
function inputText(content: readonly AioBlock[]): string {
  return content
    .map((b) => {
      switch (b.type) {
        case 'text':
          return b.text;
        case 'quote':
          return b.text
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n');
        case 'transcript':
          return b.text;
        case 'ref':
          return b.title ? `[${b.title}](${b.uri})` : b.uri;
        case 'event':
          return `[${b.name}]`;
        default:
          return `[${b.type}${'name' in b && b.name ? ` ${b.name}` : ''}]`;
      }
    })
    .filter((s) => s !== '')
    .join('\n');
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

interface TurnText {
  /** The message being streamed: its id and the text sent of it. */
  open?: { id: string; text: string };
  /** The messages said in this turn, in order. */
  said: string[];
  /** Messages numbered so far. */
  n: number;
}

/**
 * One session's projection for one client (`principal`: what a `human` resolver must name for the
 * client to be asked). `push` each event of the session's log, in order (live ephemeral ones too).
 */
export class AcpProjection {
  /** Inputs admitted and not yet taken by a turn: their origin's principal and text. */
  private readonly inputs = new Map<string, { principal?: string; text: string }>();
  /** Text state of each running turn. */
  private readonly turns = new Map<string, TurnText>();
  /** The turn the events without a turn id belong to. */
  private current: string | undefined;
  /** Tool calls already announced (`tool_call` sent), by id. */
  private readonly calls = new Set<string>();
  /** Requests open, by id: their body (for the resolution). */
  private readonly requests = new Map<string, BodyOf<'request.opened'>>();

  constructor(private readonly o: { principal: string }) {}

  push(e: SessionEvent): AcpOut[] {
    const b = e.body;
    const turnId = e.turnId ?? this.current;
    switch (b.t) {
      case 'input.admitted': {
        const i = b.input;
        if (i && i.channelContext?.context !== true) this.inputs.set(b.inputId, { ...(i.origin.principal ? { principal: i.origin.principal.id } : {}), text: inputText(i.content) });
        return [];
      }
      case 'input.rejected':
      case 'input.cancelled':
        for (const id of b.inputIds) this.inputs.delete(id);
        return [];
      case 'turn.started':
      case 'turn.adopted': {
        this.current = b.turnId;
        this.turns.set(b.turnId, { said: [], n: 0 });
        const out: AcpOut[] = [];
        for (const id of b.inputIds) {
          const i = this.inputs.get(id);
          this.inputs.delete(id);
          if (!i || !i.text) continue;
          const who = i.principal !== undefined && i.principal !== this.o.principal ? `[${i.principal}] ` : '';
          out.push({ update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `${who}${i.text}` } }, inputId: id });
        }
        return out;
      }
      case 'text.delta': {
        if (!b.delta || turnId === undefined) return [];
        if (b.stream === 'reasoning') return [{ update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: b.delta } } }];
        if (b.stream !== 'answer') return [];
        const t = this.turn(turnId);
        t.open ??= { id: `${turnId}:${++t.n}`, text: '' };
        t.open.text += b.delta;
        return [this.chunk(b.delta, t.open.id)];
      }
      case 'text.snapshot': {
        if (turnId === undefined) return [];
        const t = this.turn(turnId);
        const text = b.text;
        const open = t.open;
        t.open = undefined;
        if (open && text.startsWith(open.text)) {
          t.said.push(text);
          const rest = text.slice(open.text.length);
          return rest ? [this.chunk(rest, open.id)] : [];
        }
        if (open) t.said.push(open.text);
        // A turn's final answer repeating what it said (the last message, or all of them) is not said again.
        if (!open && norm(text) === '') return [];
        if (!open && t.said.length && (norm(text) === norm(t.said.at(-1)!) || norm(text) === norm(t.said.join(' ')))) return [];
        t.said.push(text);
        return [this.chunk(text, `${turnId}:${++t.n}`)];
      }
      case 'item.started':
      case 'item.completed': {
        const item = b.item;
        if (NOT_TOOLS.has(item.type)) return [];
        const status = toolStatusOf(b.t === 'item.started' ? 'running' : item.status);
        const content = b.t === 'item.completed' && item.result?.preview ? { content: [{ type: 'content' as const, content: { type: 'text' as const, text: item.result.preview } }] } : {};
        if (!this.calls.has(item.itemId)) {
          this.calls.add(item.itemId);
          return [{ update: { sessionUpdate: 'tool_call', toolCallId: item.itemId, title: item.title, kind: toolKindOf(item.type), status, ...(item.inputSummary ? { rawInput: item.inputSummary } : {}), ...content } }];
        }
        if (b.t === 'item.started') return [];
        this.calls.delete(item.itemId);
        return [{ update: { sessionUpdate: 'tool_call_update', toolCallId: item.itemId, status, ...content } }];
      }
      case 'plan.updated':
        return [{ update: { sessionUpdate: 'plan', entries: b.steps.map((s) => ({ content: s.text, priority: 'medium', status: s.status })) } }];
      case 'request.opened': {
        this.requests.set(b.requestId, b);
        const toolCallId = `request:${b.requestId}`;
        const kind = requestKind(b.kind);
        const out: AcpOut[] = [{ update: { sessionUpdate: 'tool_call', toolCallId, title: b.title, kind, status: 'pending', ...(b.inputPreview ? { rawInput: b.inputPreview } : {}) } }];
        const r = b.resolver;
        if (r?.kind !== 'human' || !r.principals.includes(this.o.principal)) return out;
        if (b.kind === 'question' || b.kind === 'elicitation') {
          const form = questionForm(b);
          if (form) out.push({ question: { requestId: b.requestId, message: b.title, requestedSchema: form } });
          return out;
        }
        const options = permissionOptions(b);
        if (options.length) out.push({ permission: { requestId: b.requestId, toolCall: { toolCallId, title: b.title, kind, status: 'pending', ...(b.inputPreview ? { rawInput: b.inputPreview } : {}) }, options } });
        return out;
      }
      case 'request.resolved': {
        if (!this.requests.delete(b.requestId)) return [];
        const d = b.decision;
        const ok = d !== null && (d.kind === 'allow_once' || d.kind === 'allow_session' || d.kind === 'answer' || d.kind === 'native');
        return [{ update: { sessionUpdate: 'tool_call_update', toolCallId: `request:${b.requestId}`, status: ok ? 'completed' : 'failed' } }];
      }
      case 'turn.completed': {
        this.turns.delete(b.turnId);
        if (this.current === b.turnId) this.current = undefined;
        return [{ turnEnd: { turnId: b.turnId, ...stopReasonOf(b) } }];
      }
      default:
        return [];
    }
  }

  private turn(turnId: string): TurnText {
    let t = this.turns.get(turnId);
    if (!t) this.turns.set(turnId, (t = { said: [], n: 0 }));
    return t;
  }

  private chunk(text: string, messageId: string): AcpOut {
    return { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId } };
  }
}
