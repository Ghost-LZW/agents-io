import type { BodyOf, ItemSummary } from '@agents-io/protocol';

type ItemType = ItemSummary['type'];

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Tools that ask the human something instead of doing something. */
export const QUESTION_TOOLS = new Set(['AskUserQuestion']);

export function itemType(tool: string): ItemType {
  if (SHELL_TOOLS.has(tool)) return 'command';
  if (FILE_TOOLS.has(tool)) return 'file_change';
  if (SUBAGENT_TOOLS.has(tool)) return 'subagent';
  if (NETWORK_TOOLS.has(tool)) return 'web_search';
  if (tool.startsWith('mcp__')) return 'mcp_tool';
  return 'tool';
}

export function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A short, human-readable summary of a tool's input. */
export function inputSummary(tool: string, input: unknown, max = 120): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  const pick =
    str(i.command) ??
    str(i.file_path) ??
    str(i.notebook_path) ??
    str(i.url) ??
    str(i.query) ??
    str(i.pattern) ??
    str(i.description) ??
    str(i.prompt) ??
    str(i.path);
  if (pick) return oneLine(pick, max);
  if (tool === 'TodoWrite' && Array.isArray(i.todos)) return `${i.todos.length} todos`;
  if (QUESTION_TOOLS.has(tool) && Array.isArray(i.questions)) {
    const q = i.questions[0] as { question?: unknown } | undefined;
    if (str(q?.question)) return oneLine(q!.question as string, max);
  }
  const json = JSON.stringify(input);
  return json && json !== '{}' ? oneLine(json, max) : undefined;
}

/** `mcp__server__tool` → `server.tool`; built-ins unchanged. */
export function toolLabel(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool;
  const [, server, ...rest] = tool.split('__');
  return `${server}.${rest.join('__')}`;
}

export function itemTitle(tool: string, input: unknown): string {
  const s = inputSummary(tool, input, 80);
  return s ? `${toolLabel(tool)}: ${s}` : toolLabel(tool);
}

/** Risk flags from the tool name (and, for shells, an obvious elevation marker). */
export function riskOf(tool: string, input: unknown, blockedPath?: string): BodyOf<'request.opened'>['risk'] {
  const risk: BodyOf<'request.opened'>['risk'] = {};
  if (SHELL_TOOLS.has(tool)) {
    risk.writes = true;
    const cmd = str((input as Record<string, unknown> | undefined)?.command) ?? '';
    if (/(^|[\s;&|(])(sudo|doas|su)\s/.test(cmd)) risk.elevated = true;
    if (/(^|[\s;&|(])(curl|wget|ssh|scp|rsync|git\s+(push|pull|fetch|clone)|npm\s+(publish|install)|pnpm\s+(publish|install|add))\b/.test(cmd))
      risk.network = true;
  } else if (FILE_TOOLS.has(tool)) risk.writes = true;
  else if (NETWORK_TOOLS.has(tool)) risk.network = true;
  else if (tool.startsWith('mcp__')) risk.network = true;
  else if (!READ_TOOLS.has(tool) && !QUESTION_TOOLS.has(tool) && !SUBAGENT_TOOLS.has(tool)) risk.writes = true;
  if (blockedPath) risk.elevated = true;
  return risk;
}

/** Flattens a tool_result `content` into text. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((c: { type?: string; text?: string }) => (c?.type === 'text' ? (c.text ?? '') : c?.type ? `[${c.type}]` : ''))
    .join('\n');
}

export function preview(text: string, max: number): { preview: string; truncated: boolean } {
  return text.length > max ? { preview: text.slice(0, max - 1) + '…', truncated: true } : { preview: text, truncated: false };
}

/** TodoWrite input → plan steps, or undefined if it is not a todo list. */
export function planSteps(tool: string, input: unknown): BodyOf<'plan.updated'>['steps'] | undefined {
  if (tool !== 'TodoWrite') return undefined;
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return undefined;
  return todos.map((t: { content?: unknown; status?: unknown }) => ({
    text: typeof t.content === 'string' ? t.content : JSON.stringify(t),
    status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
  }));
}
