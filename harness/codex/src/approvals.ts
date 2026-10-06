import type { BodyOf, Decision, DecisionKind, RequestQuestion } from '@agents-io/protocol';
import type { CommandExecutionRequestApprovalParams } from './generated/v2/CommandExecutionRequestApprovalParams.js';
import type { CommandExecutionRequestApprovalResponse } from './generated/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalParams } from './generated/v2/FileChangeRequestApprovalParams.js';
import type { FileChangeRequestApprovalResponse } from './generated/v2/FileChangeRequestApprovalResponse.js';
import type { PermissionsRequestApprovalParams } from './generated/v2/PermissionsRequestApprovalParams.js';
import type { PermissionsRequestApprovalResponse } from './generated/v2/PermissionsRequestApprovalResponse.js';
import type { ToolRequestUserInputParams } from './generated/v2/ToolRequestUserInputParams.js';
import type { ToolRequestUserInputResponse } from './generated/v2/ToolRequestUserInputResponse.js';
import type { McpServerElicitationRequestParams } from './generated/v2/McpServerElicitationRequestParams.js';
import type { McpServerElicitationRequestResponse } from './generated/v2/McpServerElicitationRequestResponse.js';
import { displayCommand } from './map.js';

/** Server→client requests the adapter turns into `request.opened`. */
export const APPROVAL_METHODS = {
  'item/commandExecution/requestApproval': 'tool_approval',
  'item/fileChange/requestApproval': 'file_change',
  'item/permissions/requestApproval': 'permissions',
  'item/tool/requestUserInput': 'question',
  'mcpServer/elicitation/request': 'elicitation',
} as const satisfies Record<string, BodyOf<'request.opened'>['kind']>;

export type ApprovalMethod = keyof typeof APPROVAL_METHODS;

export const isApprovalMethod = (m: string): m is ApprovalMethod => m in APPROVAL_METHODS;

type Opened = Omit<BodyOf<'request.opened'>, 't' | 'requestId'>;

/**
 * Codex sends `availableDecisions` on command approvals at runtime (only declared
 * in the experimental schema). When present it narrows what we offer: e.g. under
 * `untrusted` it is `accept | acceptWithExecpolicyAmendment | cancel`, no
 * `acceptForSession` and no `decline`.
 */
type WithAvailable = { availableDecisions?: unknown[] };

const offersAmendment = (avail: unknown[]) => avail.some((x) => x && typeof x === 'object' && 'acceptWithExecpolicyAmendment' in x);

function commandDecisions(p: WithAvailable): { allowed: DecisionKind[]; allowAlways: boolean } {
  const avail = p.availableDecisions;
  if (!Array.isArray(avail)) return { allowed: ['allow_once', 'allow_session', 'deny', 'native'], allowAlways: true };
  const has = (d: string) => avail.some((x) => x === d);
  // "Always" is either acceptForSession or accepting Codex's proposed execpolicy amendment.
  const always = has('acceptForSession') || offersAmendment(avail);
  const allowed: DecisionKind[] = [];
  if (has('accept')) allowed.push('allow_once');
  if (always) allowed.push('allow_session');
  if (has('decline') || has('cancel')) allowed.push('deny');
  allowed.push('native');
  return { allowed, allowAlways: always };
}

/**
 * Suggestions travel back in `Decision.allow_session.updatedPermissions`:
 * `{ execpolicyAmendment }` → acceptWithExecpolicyAmendment,
 * `{ networkPolicyAmendment }` → applyNetworkPolicyAmendment.
 */
export interface CodexPermissionUpdate {
  execpolicyAmendment?: string[];
  networkPolicyAmendment?: unknown;
}

function commandSuggestions(p: CommandExecutionRequestApprovalParams): CodexPermissionUpdate[] | undefined {
  const out: CodexPermissionUpdate[] = [];
  if (p.proposedExecpolicyAmendment) out.push({ execpolicyAmendment: p.proposedExecpolicyAmendment });
  for (const n of p.proposedNetworkPolicyAmendments ?? []) out.push({ networkPolicyAmendment: n });
  return out.length ? out : undefined;
}

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** `files`: paths of the fileChange item the request belongs to, when the session saw it start. */
export function openedFor(method: ApprovalMethod, params: unknown, files?: string[]): Opened {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const p = params as CommandExecutionRequestApprovalParams & WithAvailable;
      const { allowed, allowAlways } = commandDecisions(p);
      const cmd = p.command ? displayCommand(p.command) : p.kind === 'writeStdin' ? 'write to terminal' : 'command';
      return {
        kind: 'tool_approval',
        title: p.networkApprovalContext ? `Network access to ${p.networkApprovalContext.host} (${cmd})` : `Run: ${cmd}`,
        risk: { network: p.networkApprovalContext ? true : undefined, elevated: true },
        inputPreview: clip([cmd, p.cwd ? `(in ${p.cwd})` : '', p.reason ?? ''].filter(Boolean).join(' ')),
        suggestions: commandSuggestions(p),
        allowedDecisions: allowed,
        allowAlways,
        defaultDeny: true,
      };
    }
    case 'item/fileChange/requestApproval': {
      const p = params as FileChangeRequestApprovalParams;
      return {
        kind: 'file_change',
        title: p.grantRoot ? `Allow writes under ${p.grantRoot}` : p.reason ? `Apply changes: ${p.reason}` : 'Apply file changes',
        risk: { writes: true, elevated: p.grantRoot ? true : undefined },
        inputPreview: clip(files?.length ? files.join(', ') : (p.grantRoot ?? p.reason ?? '')) || undefined,
        allowedDecisions: ['allow_once', 'allow_session', 'deny', 'native'],
        allowAlways: true,
        defaultDeny: true,
      };
    }
    case 'item/permissions/requestApproval': {
      const p = params as PermissionsRequestApprovalParams;
      const fs = p.permissions.fileSystem;
      return {
        kind: 'permissions',
        title: p.reason ?? 'Grant additional permissions',
        risk: {
          network: p.permissions.network?.enabled ? true : undefined,
          writes: fs && (fs.write?.length || fs.entries?.length) ? true : undefined,
          elevated: true,
        },
        inputPreview: clip(
          [
            p.permissions.network?.enabled ? 'network' : '',
            fs?.write?.length ? `write ${fs.write.join(', ')}` : '',
            fs?.read?.length ? `read ${fs.read.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
        ) || undefined,
        allowedDecisions: ['allow_once', 'allow_session', 'deny', 'native'],
        allowAlways: true,
        defaultDeny: true,
      };
    }
    case 'item/tool/requestUserInput': {
      const p = params as ToolRequestUserInputParams;
      return {
        kind: 'question',
        title: p.questions.map((q) => q.question).join(' / ') || 'Question',
        risk: {},
        questions: p.questions.map((q) => ({
          id: q.id,
          text: q.question,
          header: q.header || undefined,
          options: q.options?.map((o) => ({ label: o.label, description: o.description || undefined })),
          secret: q.isSecret || undefined,
        })),
        allowedDecisions: ['answer', 'deny', 'native'],
        allowAlways: false,
        defaultDeny: false,
      };
    }
    case 'mcpServer/elicitation/request': {
      const p = params as McpServerElicitationRequestParams;
      return {
        kind: 'elicitation',
        title: `${p.serverName}: ${p.message}`,
        risk: {},
        inputPreview: p.mode === 'url' ? p.url : undefined,
        questions: p.mode === 'form' ? formQuestions(p.requestedSchema) : undefined,
        allowedDecisions: ['allow_once', 'answer', 'deny', 'native'],
        allowAlways: false,
        defaultDeny: true,
      };
    }
  }
}

/** MCP form schema (flat object of primitives / enums) → one question per field. */
function formQuestions(schema: unknown): RequestQuestion[] | undefined {
  const props = (schema as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties;
  if (!props) return undefined;
  const opts = (s: Record<string, unknown>): RequestQuestion['options'] => {
    const items = (s.items as Record<string, unknown> | undefined) ?? s;
    if (Array.isArray(items.enum)) return items.enum.map((v) => ({ label: String(v) }));
    const titled = (items.oneOf ?? items.anyOf) as { const?: unknown; title?: string }[] | undefined;
    if (Array.isArray(titled)) return titled.map((o) => ({ label: String(o.const ?? o.title), description: o.title }));
    return undefined;
  };
  return Object.entries(props).map(([id, s]) => ({
    id,
    text: String(s.title ?? s.description ?? id),
    header: typeof s.title === 'string' && typeof s.description === 'string' ? s.description : undefined,
    options: opts(s),
    multiSelect: s.type === 'array' || undefined,
  }));
}

export class UnsupportedDecisionError extends Error {}

/**
 * Translates a Decision into the JSON-RPC result for `method`. `native` passes its
 * payload through as the whole result. Returns `interrupt: true` when the decision
 * asks to stop the turn and the response itself cannot express that.
 */
export function responseFor(
  method: ApprovalMethod,
  params: unknown,
  d: Decision,
): { result: unknown; interrupt: boolean } {
  if (d.kind === 'native') return { result: d.payload, interrupt: false };
  const stop = d.kind === 'deny' && d.interruptTurn === true;
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const avail = (params as WithAvailable).availableDecisions;
      const offers = (x: string) => !Array.isArray(avail) || avail.includes(x);
      let decision: CommandExecutionRequestApprovalResponse['decision'];
      const p = params as CommandExecutionRequestApprovalParams;
      const upd = (d.kind === 'allow_session' ? d.updatedPermissions : undefined) as CodexPermissionUpdate | undefined;
      if (d.kind === 'allow_once') decision = 'accept';
      else if (upd?.execpolicyAmendment) decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: upd.execpolicyAmendment } };
      else if (upd?.networkPolicyAmendment)
        decision = { applyNetworkPolicyAmendment: { network_policy_amendment: upd.networkPolicyAmendment as never } };
      else if (d.kind === 'allow_session' && !offers('acceptForSession') && p.proposedExecpolicyAmendment)
        // "Always" where Codex only offers its proposed amendment (e.g. under `untrusted`).
        decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment } };
      else if (d.kind === 'allow_session') decision = 'acceptForSession';
      else if (d.kind === 'deny') decision = stop || !offers('decline') ? 'cancel' : 'decline';
      else throw new UnsupportedDecisionError(`${d.kind} is not a valid answer to a command approval`);
      const r: CommandExecutionRequestApprovalResponse = { decision };
      return { result: r, interrupt: false };
    }
    case 'item/fileChange/requestApproval': {
      let decision: FileChangeRequestApprovalResponse['decision'];
      if (d.kind === 'allow_once') decision = 'accept';
      else if (d.kind === 'allow_session') decision = 'acceptForSession';
      else if (d.kind === 'deny') decision = stop ? 'cancel' : 'decline';
      else throw new UnsupportedDecisionError(`${d.kind} is not a valid answer to a file change approval`);
      const r: FileChangeRequestApprovalResponse = { decision };
      return { result: r, interrupt: false };
    }
    case 'item/permissions/requestApproval': {
      const p = params as PermissionsRequestApprovalParams;
      if (d.kind === 'deny') {
        const r: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' };
        return { result: r, interrupt: stop };
      }
      if (d.kind !== 'allow_once' && d.kind !== 'allow_session')
        throw new UnsupportedDecisionError(`${d.kind} is not a valid answer to a permissions request`);
      const granted: PermissionsRequestApprovalResponse['permissions'] = {};
      if (p.permissions.network) granted.network = p.permissions.network;
      if (p.permissions.fileSystem) granted.fileSystem = p.permissions.fileSystem;
      const r: PermissionsRequestApprovalResponse = { permissions: granted, scope: d.kind === 'allow_session' ? 'session' : 'turn' };
      return { result: r, interrupt: false };
    }
    case 'item/tool/requestUserInput': {
      if (d.kind === 'deny') {
        const r: ToolRequestUserInputResponse = { answers: {} };
        return { result: r, interrupt: stop };
      }
      if (d.kind !== 'answer') throw new UnsupportedDecisionError(`${d.kind} is not a valid answer to a question`);
      const answers: ToolRequestUserInputResponse['answers'] = {};
      for (const [id, a] of Object.entries(d.answers)) answers[id] = { answers: Array.isArray(a) ? a : [a] };
      const r: ToolRequestUserInputResponse = { answers };
      return { result: r, interrupt: false };
    }
    case 'mcpServer/elicitation/request': {
      let r: McpServerElicitationRequestResponse;
      if (d.kind === 'deny') r = { action: stop ? 'cancel' : 'decline', content: null, _meta: null };
      else if (d.kind === 'answer') r = { action: 'accept', content: d.answers, _meta: null };
      else if (d.kind === 'allow_once') r = { action: 'accept', content: null, _meta: null };
      else throw new UnsupportedDecisionError(`${d.kind} is not a valid answer to an elicitation`);
      // MCP `cancel` only dismisses the form; stopping the turn takes a turn/interrupt.
      return { result: r, interrupt: stop };
    }
  }
}
