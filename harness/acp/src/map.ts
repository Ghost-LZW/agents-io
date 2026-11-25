import { prefaceContext, type BlobAccess, type BodyOf, type ContentBlock as AioBlock, type Decision, type InputRecord, type ItemSummary, type PrefaceMemo } from '@agents-io/protocol';
import type { ContentBlock, PermissionOption, StopReason, ToolCallContent } from '@agentclientprotocol/sdk';
import type { AcpToolCallView } from './flavors.js';

/*
 * The mapping between ACP and agents-io's harness contract, as pure functions: inputs to a prompt,
 * permission options to and from a `Decision`, an elicitation's answers, stop reasons to turn
 * statuses, tool calls to items. (A northbound ACP projection, core-slimming G9, reads the same
 * table the other way.)
 */

// ---- inputs -------------------------------------------------------------------

/** One-line sender context so the model knows who is talking and from where (INVARIANTS ID-2), as the Codex adapter writes it. */
export function senderPreface(input: InputRecord, memo?: PrefaceMemo): string {
  const o = input.origin;
  const parts = [`from=${o.principal?.id ?? 'unknown'}`, `kind=${o.kind}`, `evidence=${o.evidence}`, `via=${o.via}`];
  if (o.declared) parts.push(`declared=${o.declared}`);
  if (o.self) parts.push('self=true');
  if (input.cause?.hop !== undefined) parts.push(`hop=${input.cause.hop}`);
  if (input.channelRef) parts.push(`ref=${/^[^\s"]+$/.test(input.channelRef) ? input.channelRef : JSON.stringify(input.channelRef)}`);
  for (const [k, v] of prefaceContext(input, memo)) parts.push(`${k}=${v}`);
  return `[sender ${parts.join(' ')}]`;
}

/** Label of context-only inputs (`channelContext.context`): seen in the conversation, not said to the agent. */
export const CONTEXT_LABEL = '[context, not addressed to you: recorded in the conversation; read it, do not reply to it unless the addressed input asks]';

/** An input that is a harness command (`/compact`), handed to the agent as it is. */
export const isNativeCommand = (i: InputRecord) => i.channelContext.nativeCommand === true;

function blockText(b: Exclude<AioBlock, { ref: string; mime: string }>): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'quote':
      return b.text
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'transcript': {
      const who = b.speaker ? `${b.speaker}: ` : '';
      return `[transcript ${Math.round(b.startMs / 1000)}s-${Math.round(b.endMs / 1000)}s${b.stable ? '' : ' unstable'}] ${who}${b.text}`;
    }
    case 'ref':
      return b.title ? `[ref ${b.title}](${b.uri})` : `[ref](${b.uri})`;
    case 'event':
      return `[event ${b.name}] ${JSON.stringify(b.data)}`;
  }
}

/** Media larger than this go as a link to their file, not inline (a message is at most 32 MiB). */
export const INLINE_MAX_BYTES = 10 * 1024 * 1024;

/** What the agent takes in a prompt beyond text (`promptCapabilities`). */
export interface PromptSupport {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

/**
 * A turn's inputs as one prompt: each input's preface and text-like blocks as text; images and audio
 * as content blocks when the agent takes them (`promptCapabilities`) and they are at most
 * `INLINE_MAX_BYTES`, read from the host's blob store;
 * files as a link to their local path (`resource_link`, which every agent takes). A harness command
 * (`/compact`) goes alone and as it is.
 */
export async function renderPrompt(inputs: InputRecord[], o: { blobs?: BlobAccess; support?: PromptSupport; memo?: PrefaceMemo } = {}): Promise<ContentBlock[]> {
  if (inputs.length === 1 && isNativeCommand(inputs[0]!)) {
    const cmd = inputs[0]!.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    return [{ type: 'text', text: cmd }];
  }
  const out: ContentBlock[] = [];
  for (const input of inputs) {
    const lines: string[] = [];
    if (input.channelContext.context === true) lines.push(CONTEXT_LABEL);
    lines.push(senderPreface(input, o.memo));
    const flush = () => {
      if (lines.length) out.push({ type: 'text', text: lines.splice(0).join('\n') });
    };
    for (const b of input.content) {
      if (!('ref' in b)) {
        lines.push(blockText(b));
        continue;
      }
      const st = o.blobs ? await o.blobs.stat(b.ref).catch(() => undefined) : undefined;
      const inline = ((b.type === 'image' && o.support?.image) || (b.type === 'audio' && o.support?.audio)) && st !== undefined && st.size <= INLINE_MAX_BYTES;
      if (st && inline && o.blobs) {
        const got = await o.blobs.get(b.ref).catch(() => undefined);
        if (got) {
          flush();
          const data = Buffer.from(got.bytes).toString('base64');
          out.push(b.type === 'image' ? { type: 'image', data, mimeType: got.mime } : { type: 'audio', data, mimeType: got.mime });
          continue;
        }
      }
      if (st) {
        flush();
        out.push({ type: 'resource_link', uri: `file://${st.path}`, name: b.name ?? st.name ?? b.ref, mimeType: b.mime, size: st.size });
        continue;
      }
      lines.push(`[${b.type} ${b.name ?? b.ref} (${b.mime}) not available]`);
    }
    flush();
  }
  return out;
}

// ---- permissions --------------------------------------------------------------

/** The decisions a permission request's options can be answered with (`request.opened.allowedDecisions`). */
export function permissionDecisions(options: readonly PermissionOption[]): Decision['kind'][] {
  const kinds = new Set(options.map((o) => o.kind));
  const out: Decision['kind'][] = [];
  if (kinds.has('allow_once')) out.push('allow_once');
  if (kinds.has('allow_always') || kinds.has('allow_once')) out.push('allow_session');
  out.push('deny', 'native');
  return out;
}

/**
 * The answer to `session/request_permission` for `d`: the option it picks, or `cancelled` (a deny
 * when the agent offers no reject option). Never wider than asked: `allow_once` only picks a
 * one-time allow; `allow_session` picks an "always" option, else the one-time allow. A `native`
 * decision names an option (`{ optionId }`) or the outcome itself (`{ outcome: "cancelled" }`).
 * Throws for a decision that picks nothing the agent offered.
 */
export function permissionOutcome(options: readonly PermissionOption[], d: Decision): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  const pick = (...kinds: PermissionOption['kind'][]) => {
    for (const k of kinds) {
      const o = options.find((x) => x.kind === k);
      if (o) return { outcome: 'selected' as const, optionId: o.optionId };
    }
    return undefined;
  };
  switch (d.kind) {
    case 'allow_once': {
      const o = pick('allow_once');
      if (!o) throw new Error('the agent offers no one-time allow for this request');
      return o;
    }
    case 'allow_session': {
      const o = pick('allow_always', 'allow_once');
      if (!o) throw new Error('the agent offers no allow for this request');
      return o;
    }
    case 'deny':
      return pick('reject_once', 'reject_always') ?? { outcome: 'cancelled' };
    case 'native': {
      const p = d.payload as { optionId?: unknown; outcome?: unknown } | null;
      if (p && typeof p === 'object' && p.outcome === 'cancelled') return { outcome: 'cancelled' };
      if (p && typeof p === 'object' && typeof p.optionId === 'string' && options.some((o) => o.optionId === p.optionId)) return { outcome: 'selected', optionId: p.optionId };
      throw new Error(`native decision ${JSON.stringify(d.payload)} names no option of this request (${options.map((o) => o.optionId).join(', ')})`);
    }
    case 'answer':
      throw new Error('an answer is no decision for a permission request');
  }
}

/** The kind of request a tool call's permission is (`request.opened.kind`). */
export const permissionKind = (toolKind: string | undefined): 'file_change' | 'tool_approval' =>
  toolKind === 'edit' || toolKind === 'delete' || toolKind === 'move' ? 'file_change' : 'tool_approval';

/** What a tool call of this kind may do (`request.opened.risk`). */
export function riskOf(toolKind: string | undefined): BodyOf<'request.opened'>['risk'] {
  if (toolKind === 'edit' || toolKind === 'delete' || toolKind === 'move' || toolKind === 'execute') return { writes: true };
  if (toolKind === 'fetch') return { network: true };
  return {};
}

// ---- elicitation --------------------------------------------------------------

/**
 * An `answer` decision as the content of an accepted form elicitation: each property's answer in
 * its schema's type (numbers, integers, booleans from their text; a choice's label back to its
 * `const`), an array property as a list.
 */
export function elicitationContent(properties: Record<string, Record<string, unknown>>, answers: Record<string, string | string[]>): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [id, raw] of Object.entries(answers)) {
    const p = properties[id];
    if (!p) continue;
    const one = Array.isArray(raw) ? (raw[0] ?? '') : raw;
    const constOf = (label: string, src: Record<string, unknown>) => {
      const list = Array.isArray(src.oneOf) ? src.oneOf : Array.isArray(src.anyOf) ? src.anyOf : [];
      const hit = (list as { const?: unknown; title?: unknown }[]).find((o) => o.title === label || o.const === label);
      return typeof hit?.const === 'string' ? hit.const : label;
    };
    switch (p.type) {
      case 'number':
      case 'integer': {
        const n = Number(one);
        if (one.trim() !== '' && Number.isFinite(n)) out[id] = p.type === 'integer' ? Math.trunc(n) : n;
        break;
      }
      case 'boolean':
        out[id] = /^(true|yes|y|1|on)$/i.test(one.trim());
        break;
      case 'array': {
        const items = (typeof p.items === 'object' && p.items !== null ? p.items : {}) as Record<string, unknown>;
        out[id] = (Array.isArray(raw) ? raw : [raw]).map((v) => constOf(v, items));
        break;
      }
      default:
        out[id] = constOf(one, p);
    }
  }
  return out;
}

// ---- turns --------------------------------------------------------------------

/** How a prompt turn ended (`stopReason`) as a turn's status; an unknown or missing reason is `ambiguous`. */
export function turnOutcome(stop: StopReason | string | null | undefined): { status: BodyOf<'turn.completed'>['status']; error?: BodyOf<'turn.completed'>['error'] } {
  if (typeof stop !== 'string') return { status: 'ambiguous', error: { code: 'unknown_stop_reason', retryable: false, message: 'the agent answered the prompt with no stop reason' } };
  switch (stop) {
    case 'end_turn':
      return { status: 'completed' };
    case 'cancelled':
      return { status: 'interrupted' };
    case 'refusal':
      return { status: 'failed', error: { code: 'refusal', retryable: false, message: 'the agent refused to continue' } };
    case 'max_tokens':
      return { status: 'failed', error: { code: 'max_tokens', retryable: false, message: 'the agent reached its token limit' } };
    case 'max_turn_requests':
      return { status: 'failed', error: { code: 'max_turn_requests', retryable: false, message: 'the agent reached its limit of model requests for one turn' } };
    default:
      return { status: 'ambiguous', error: { code: 'unknown_stop_reason', retryable: false, message: `the agent stopped for a reason this adapter does not know: ${stop}` } };
  }
}

// ---- items --------------------------------------------------------------------

const PREVIEW = 2000;
const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The item type of a tool call (`ItemSummary.type`), by its kind; an MCP tool or a subagent as the flavor says. */
export function itemTypeOf(call: AcpToolCallView, tool: { server: string; name: string } | undefined, subagent: boolean): ItemSummary['type'] {
  if (tool) return 'mcp_tool';
  if (subagent) return 'subagent';
  switch (call.kind) {
    case 'execute':
      return 'command';
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_change';
    case 'fetch':
      return 'web_search';
    default:
      return 'tool';
  }
}

/** What a tool call's input was, in a line (the command, the path, else its JSON). */
export function inputSummary(raw: unknown, locations?: readonly { path: string }[] | null): string | undefined {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const k of ['command', 'cmd', 'path', 'file_path', 'url', 'query', 'pattern']) {
      const v = r[k];
      if (typeof v === 'string' && v) return clip(v);
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return clip(v.join(' '));
    }
    const s = JSON.stringify(raw);
    if (s && s !== '{}') return clip(s);
  }
  if (typeof raw === 'string' && raw) return clip(raw);
  if (locations?.[0]?.path) return clip(locations[0].path);
  return undefined;
}

/** A tool call's output as an item result: the text of its content, else its raw output. */
export function resultOf(content: readonly ToolCallContent[] | null | undefined, rawOutput: unknown, isError: boolean): ItemSummary['result'] {
  const texts = (content ?? []).flatMap((c) => {
    if (c.type === 'content' && c.content.type === 'text') return [c.content.text];
    if (c.type === 'diff') return [`${c.path}`];
    return [];
  });
  let s = texts.length ? texts.join('\n') : undefined;
  if (s === undefined && rawOutput !== undefined && rawOutput !== null) s = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
  if (s === undefined) return undefined;
  const truncated = s.length > PREVIEW;
  return { preview: truncated ? '…' + s.slice(-PREVIEW) : s, truncated, isError };
}

/** The files a tool call's diffs change, with added and removed line counts (`diff.updated`). */
export function diffFiles(content: readonly ToolCallContent[] | null | undefined): BodyOf<'diff.updated'>['files'] {
  return (content ?? []).flatMap((c) => {
    if (c.type !== 'diff') return [];
    const before = c.oldText ? c.oldText.split('\n') : [];
    const after = c.newText.split('\n');
    // Lines that are not in the other side, counted as a multiset: an estimate, not a diff.
    const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
    const b = count(before);
    const a = count(after);
    let added = 0;
    let removed = 0;
    for (const [l, n] of a) added += Math.max(0, n - (b.get(l) ?? 0));
    for (const [l, n] of b) removed += Math.max(0, n - (a.get(l) ?? 0));
    return [{ path: c.path, added, removed }];
  });
}

/** A tool call's status as an item's (`pending` and `in_progress` are running). */
export const itemStatus = (s: string | null | undefined): ItemSummary['status'] => (s === 'completed' ? 'completed' : s === 'failed' ? 'failed' : 'running');
