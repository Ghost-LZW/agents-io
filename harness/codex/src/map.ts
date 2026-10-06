import type { Audience, BodyOf, ContentBlock, InputRecord, ItemSummary, Level } from '@agents-io/protocol';
import type { ThreadItem } from './generated/v2/ThreadItem.js';
import type { UserInput } from './generated/v2/UserInput.js';
import type { TurnError } from './generated/v2/TurnError.js';
import type { CodexErrorInfo } from './generated/v2/CodexErrorInfo.js';
import type { TurnStatus } from './generated/v2/TurnStatus.js';
import type { TurnPlanStep } from './generated/v2/TurnPlanStep.js';
import type { SandboxMode } from './generated/v2/SandboxMode.js';
import type { SandboxPolicy } from './generated/v2/SandboxPolicy.js';
import type { AskForApproval } from './generated/v2/AskForApproval.js';
import type { ApprovalsReviewer } from './generated/v2/ApprovalsReviewer.js';

// ---- Inputs -----------------------------------------------------------------

/** Resolves a stored blob (`ContentBlock.ref`) to something Codex can read. Return null to fall back to a text placeholder. */
export type MediaResolver = (block: { ref: string; mime: string; name?: string; type: 'image' | 'file' | 'audio' }) =>
  | Promise<{ path: string } | { url: string } | null>
  | { path: string }
  | { url: string }
  | null;

const text = (t: string): UserInput => ({ type: 'text', text: t, text_elements: [] });

/** One-line, structured sender context so the model knows who is talking and from where. */
export function senderPreface(input: InputRecord): string {
  const o = input.origin;
  const parts = [`from=${o.principal?.id ?? 'unknown'}`, `kind=${o.kind}`, `via=${o.via}`];
  if (o.declared) parts.push(`declared=${o.declared}`);
  for (const [k, v] of Object.entries(input.channelContext)) parts.push(`${k}=${JSON.stringify(v)}`);
  return `[sender ${parts.join(' ')}]`;
}

function blockText(b: Exclude<ContentBlock, { ref: string; mime: string }>): string {
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

/** Renders input records to Codex `UserInput` items: text-like blocks become text, images go through the resolver. */
export async function renderInputs(
  inputs: InputRecord[],
  opts: { resolveMedia?: MediaResolver; preface?: boolean } = {},
): Promise<UserInput[]> {
  const out: UserInput[] = [];
  for (const input of inputs) {
    const lines: string[] = [];
    if (opts.preface !== false) lines.push(senderPreface(input));
    const flush = () => {
      if (lines.length) out.push(text(lines.splice(0).join('\n')));
    };
    for (const b of input.content) {
      if ('ref' in b) {
        const resolved = opts.resolveMedia ? await opts.resolveMedia(b) : null;
        if (resolved && b.type !== 'file') {
          flush();
          if (b.type === 'image') out.push('path' in resolved ? { type: 'localImage', path: resolved.path } : { type: 'image', url: resolved.url });
          else out.push('path' in resolved ? { type: 'localAudio', path: resolved.path } : { type: 'audio', url: resolved.url });
        } else if (resolved && 'path' in resolved) {
          lines.push(`[file ${b.name ?? ''} (${b.mime}) at ${resolved.path}]`);
        } else {
          lines.push(`[${b.type} ${b.name ?? b.ref} (${b.mime}) not available]`);
        }
        continue;
      }
      lines.push(blockText(b));
    }
    flush();
  }
  return out;
}

/**
 * `clientUserMessageId` is one string per turn/start or turn/steer, but one call
 * may carry several inputs. A single input uses its inputId verbatim; a batch is
 * encoded as a JSON array so it survives an adapter restart.
 */
export function encodeClientId(inputIds: string[]): string {
  return inputIds.length === 1 ? inputIds[0]! : JSON.stringify(inputIds);
}

export function decodeClientId(clientId: string): string[] {
  if (clientId.startsWith('[')) {
    try {
      const v = JSON.parse(clientId);
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
    } catch {
      /* a plain id that happens to start with '[' */
    }
  }
  return [clientId];
}

// ---- Items ------------------------------------------------------------------

const PREVIEW = 2000;

function preview(s: string | null | undefined, isError: boolean): ItemSummary['result'] {
  if (s == null) return undefined;
  const truncated = s.length > PREVIEW;
  return { preview: truncated ? '…' + s.slice(-PREVIEW) : s, truncated, isError };
}

function clip(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** `/bin/zsh -lc 'touch x'` → `touch x` (Codex wraps commands in a login shell). */
export function displayCommand(cmd: string): string {
  const m = cmd.match(/^\S*\/(?:ba|z)?sh -l?c (?:'(.*)'|([^'\s]+))$/s);
  if (!m) return cmd;
  return m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!;
}

const itemStatus = (s: string): ItemSummary['status'] =>
  s === 'inProgress' ? 'running' : s === 'completed' ? 'completed' : s === 'declined' ? 'declined' : s === 'interrupted' ? 'failed' : 'failed';

export interface MappedItem {
  summary: ItemSummary;
  audience: Audience;
  level: Level;
}

/** Maps a Codex ThreadItem to an ItemSummary. Returns undefined for items that only go out as `native`. */
export function summarizeItem(item: ThreadItem, cwd?: string): MappedItem | undefined {
  const rel = (p: string) => (cwd && p.startsWith(cwd.endsWith('/') ? cwd : cwd + '/') ? p.slice(cwd.length).replace(/^\//, '') : p);
  const base = (type: ItemSummary['type'], title: string, status: ItemSummary['status']): ItemSummary => ({
    itemId: item.id,
    type,
    title,
    status,
  });
  switch (item.type) {
    case 'agentMessage':
      return {
        summary: { ...base('agent_message', clip(item.text.split('\n')[0] ?? ''), 'completed') },
        audience: phaseAudience(item.phase),
        level: 'primary',
      };
    case 'reasoning':
      return {
        summary: { ...base('reasoning', clip(item.summary.join(' ') || 'Reasoning'), 'completed') },
        audience: 'internal',
        level: 'detail',
      };
    case 'commandExecution': {
      const status = itemStatus(item.status);
      const s = base('command', clip(displayCommand(item.command)), status);
      s.inputSummary = item.cwd;
      const failed = status === 'failed' || (item.exitCode != null && item.exitCode !== 0);
      const r = preview(item.aggregatedOutput ?? (item.exitCode != null ? `exit ${item.exitCode}` : null), failed);
      if (r && status !== 'running') s.result = r;
      return { summary: s, audience: 'status', level: 'primary' };
    }
    case 'fileChange': {
      const paths = item.changes.map((c) => rel(c.path));
      const s = base('file_change', clip(`Edit ${paths.join(', ') || '(no files)'}`), itemStatus(item.status));
      if (s.status !== 'running') {
        s.result = preview(
          item.changes.map((c) => `${c.kind.type} ${rel(c.path)}`).join('\n'),
          s.status === 'failed',
        );
      }
      return { summary: s, audience: 'status', level: 'primary' };
    }
    case 'mcpToolCall': {
      const s = base('mcp_tool', `${item.server}.${item.tool}`, itemStatus(item.status));
      s.inputSummary = clip(JSON.stringify(item.arguments ?? null));
      if (item.error) s.result = preview(item.error.message, true);
      else if (item.result) s.result = preview(contentText(item.result.content), false);
      return { summary: s, audience: 'status', level: 'primary' };
    }
    case 'dynamicToolCall': {
      const s = base('tool', item.namespace ? `${item.namespace}.${item.tool}` : item.tool, itemStatus(item.status));
      s.inputSummary = clip(JSON.stringify(item.arguments ?? null));
      if (item.contentItems) s.result = preview(contentText(item.contentItems), item.success === false);
      return { summary: s, audience: 'status', level: 'primary' };
    }
    case 'collabAgentToolCall': {
      const s = base('subagent', clip(`${item.tool}${item.prompt ? `: ${item.prompt}` : ''}`), itemStatus(item.status));
      return { summary: s, audience: 'status', level: 'primary' };
    }
    case 'subAgentActivity':
      return { summary: base('subagent', clip(`${item.kind} ${item.agentPath}`), 'completed'), audience: 'status', level: 'detail' };
    case 'webSearch':
      return { summary: base('web_search', clip(item.query || 'Web search'), 'completed'), audience: 'status', level: 'primary' };
    case 'imageView':
      return { summary: base('tool', clip(`View image ${item.path}`), 'completed'), audience: 'status', level: 'detail' };
    case 'imageGeneration':
      return { summary: base('tool', 'Generate image', 'completed'), audience: 'status', level: 'detail' };
    case 'contextCompaction':
      return { summary: base('compaction', 'Compacting context', 'completed'), audience: 'status', level: 'detail' };
    case 'hookPrompt':
      return { summary: base('hook', 'Hook prompt', 'completed'), audience: 'internal', level: 'debug' };
    case 'userMessage':
      return {
        summary: { ...base('user_message', clip(item.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ')), 'completed') },
        audience: 'status',
        level: 'detail',
      };
    default:
      // plan, functionCallOutput, sleep, review mode markers…
      return undefined;
  }
}

/**
 * Started items report `running`; Codex completes one-shot items (agent message,
 * reasoning, web search…) only in `item/completed`, so the started copy is forced
 * to running and the completed copy keeps the item's own status (never running).
 */
export function asStarted(s: ItemSummary): ItemSummary {
  const { result: _r, ...rest } = s;
  return { ...rest, status: 'running' };
}

export function asCompleted(s: ItemSummary): ItemSummary {
  return s.status === 'running' ? { ...s, status: 'completed' } : s;
}

function contentText(content: unknown[]): string {
  return content
    .map((c) => {
      if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string') return (c as { text: string }).text;
      return JSON.stringify(c);
    })
    .join('\n');
}

export function phaseAudience(phase: string | null | undefined): Audience {
  // Providers do not always set phase; unknown is treated as the answer (legacy behaviour).
  return phase === 'commentary' ? 'commentary' : 'answer';
}

// ---- Turn / plan / diff -------------------------------------------------------

export function turnStatus(s: TurnStatus): BodyOf<'turn.completed'>['status'] {
  return s === 'inProgress' ? 'ambiguous' : s;
}

const RETRYABLE = new Set([
  'serverOverloaded',
  'rateLimitExceeded',
  'internalServerError',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'flexUnavailable',
]);

export function errorCode(info: CodexErrorInfo | null | undefined): string {
  if (!info) return 'other';
  return typeof info === 'string' ? info : (Object.keys(info)[0] ?? 'other');
}

export function turnError(e: TurnError): NonNullable<BodyOf<'turn.completed'>['error']> {
  const code = errorCode(e.codexErrorInfo);
  return { code, retryable: RETRYABLE.has(code), message: e.additionalDetails ? `${e.message}\n${e.additionalDetails}` : e.message };
}

export function planSteps(plan: TurnPlanStep[]): BodyOf<'plan.updated'>['steps'] {
  return plan.map((p) => ({ text: p.step, status: p.status === 'inProgress' ? 'in_progress' : p.status }));
}

/** Per-file +/- counts from the aggregated unified diff in `turn/diff/updated`. */
export function diffStats(diff: string): BodyOf<'diff.updated'>['files'] {
  const files: BodyOf<'diff.updated'>['files'] = [];
  let cur: (typeof files)[number] | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      cur = { path: m?.[2] ?? line.slice(11), added: 0, removed: 0 };
      files.push(cur);
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      if (!cur) {
        // diff without `diff --git` headers
        if (line.startsWith('+++ ')) {
          cur = { path: line.slice(4).replace(/^b\//, ''), added: 0, removed: 0 };
          files.push(cur);
        }
      } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') cur.path = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
  }
  return files;
}

// ---- Profiles -------------------------------------------------------------------

/** Deployment mapping from an agents-io permission profile name to Codex settings. */
export interface CodexProfile {
  approvalPolicy?: AskForApproval;
  approvalsReviewer?: ApprovalsReviewer;
  /** Thread-level sandbox mode (thread/start, thread/resume). */
  sandbox?: SandboxMode;
  /** Full turn-level policy; when set it is sent on turn/start instead of one derived from `sandbox`. */
  sandboxPolicy?: SandboxPolicy;
}

export const DEFAULT_PROFILES: Record<string, CodexProfile> = {
  bypass: { approvalPolicy: 'never', sandbox: 'workspace-write' },
};

/** Profiles not configured and not built in: ask before leaving the sandbox. */
export const FALLBACK_PROFILE: CodexProfile = { approvalPolicy: 'on-request', sandbox: 'workspace-write' };

export function resolveProfile(name: string, profiles: Record<string, CodexProfile> | undefined): CodexProfile {
  return profiles?.[name] ?? DEFAULT_PROFILES[name] ?? FALLBACK_PROFILE;
}

export function sandboxModeOf(p: CodexProfile): SandboxMode | undefined {
  if (p.sandbox) return p.sandbox;
  switch (p.sandboxPolicy?.type) {
    case 'dangerFullAccess':
      return 'danger-full-access';
    case 'readOnly':
      return 'read-only';
    case 'workspaceWrite':
      return 'workspace-write';
    default:
      return undefined;
  }
}

export function sandboxPolicyOf(p: CodexProfile): SandboxPolicy | undefined {
  if (p.sandboxPolicy) return p.sandboxPolicy;
  switch (p.sandbox) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    default:
      return undefined;
  }
}
