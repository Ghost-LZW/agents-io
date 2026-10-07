import type { ProgressStep, ProgressView, RenderedMessage } from '@agents-io/protocol';

/**
 * The reply card for a message that carries `progress`: status banner, collapsible
 * process panels, the answer, buttons and a footer, with stable element ids so a
 * CardKit streaming card can update each part on its own.
 */

export type Locale = 'zh' | 'en';
export type PanelKey = 'thinking' | 'tools' | 'plan';
type Status = ProgressView['status'];

/** CardKit element ids: start with a letter, letters/digits/underscore, at most 20 chars. */
export const EL = {
  status: 'status',
  answer: 'answer',
  footer: 'footer',
  panel: (k: PanelKey) => `p_${k}`,
  panelBody: (k: PanelKey) => `p_${k}_md`,
} as const;

export const PANEL_ORDER: readonly PanelKey[] = ['thinking', 'tools', 'plan'];

const L = {
  zh: {
    status: { running: '处理中', requires_action: '等待确认', completed: '已完成', interrupted: '已中断', failed: '失败', ambiguous: '结果未知' },
    panel: { thinking: '思考过程', tools: '工具调用', plan: '计划' },
    working: '处理中…',
    toolsCount: (n: number, shown: number) => (n > shown ? `共 ${n} 次，显示最近 ${shown} 次` : `共 ${n} 次`),
    thinkingCount: (n: number, shown: number) => (n > shown ? `共 ${n} 段，显示最近 ${shown} 段` : ''),
    elapsed: '用时',
    running: '已运行',
    tools: (n: number) => `工具 ${n} 次`,
    continued: '（续见下一条消息）',
    continuing: '（内容较长，完成后在下一条消息续写）',
    cotThinking: '思考中…',
    cotDone: '✓ 已完成',
    cotFailed: '✗ 失败',
    toolStatus: { running: '运行中', completed: '', failed: '失败', declined: '已拒绝', skipped: '已跳过' },
  },
  en: {
    status: { running: 'Working', requires_action: 'Waiting for approval', completed: 'Done', interrupted: 'Interrupted', failed: 'Failed', ambiguous: 'Outcome unknown' },
    panel: { thinking: 'Thinking', tools: 'Tool calls', plan: 'Plan' },
    working: 'Working…',
    toolsCount: (n: number, shown: number) => (n > shown ? `${n} calls, last ${shown} shown` : `${n} calls`),
    thinkingCount: (n: number, shown: number) => (n > shown ? `${n} blocks, last ${shown} shown` : ''),
    elapsed: 'took',
    running: 'running',
    tools: (n: number) => `${n} tool calls`,
    continued: '(continued in the next message)',
    continuing: '(long answer: the rest follows in another message when done)',
    cotThinking: 'Thinking…',
    cotDone: '✓ Done',
    cotFailed: '✗ Failed',
    toolStatus: { running: 'running', completed: '', failed: 'failed', declined: 'declined', skipped: 'skipped' },
  },
} as const;

export const labels = (locale: Locale) => L[locale];

const ICON: Record<Status, string> = { running: '⏳', requires_action: '✋', completed: '✅', interrupted: '⏹', failed: '❌', ambiguous: '❔' };
const TEMPLATE: Record<Status, string> = { running: 'blue', requires_action: 'orange', completed: 'green', interrupted: 'grey', failed: 'red', ambiguous: 'grey' };
const TOOL_MARK: Record<Extract<ProgressStep, { kind: 'tool' }>['status'], string> = {
  running: '⏳',
  completed: '✅',
  failed: '❌',
  declined: '⛔',
  skipped: '⏭',
};
/** Decoration the adapter adds; `plain` relies on the card header colour and words instead. */
export type CardStyle = 'emoji' | 'plain';
const PANEL_ICON: Record<PanelKey, string> = { thinking: '💭', tools: '🛠', plan: '📋' };
const NARRATION_ICON = '💬';
const PLAN_MARK = { pending: '○', in_progress: '◐', completed: '●' } as const;

export interface ProcessModel {
  status: Status;
  done: boolean;
  title: string;
  template: string;
  summary: string;
  banner: string;
  panels: { key: PanelKey; title: string; body: string }[];
  /** First answer page; `overflow` holds the rest (sent as follow-up messages once final). */
  answer: string;
  overflow: string[];
  actions: NonNullable<RenderedMessage['actions']>;
  footer: string;
}

export interface ModelOptions {
  locale: Locale;
  /** Default `emoji`. */
  style?: CardStyle;
  /** Leave thinking/tools out of the card (the native thinking bubble shows them). */
  processElsewhere: boolean;
  maxEntries: number;
  panelMaxChars: number;
  /** UTF-8 budget of the answer element. */
  answerBytes: number;
  now: number;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s);
const clipTail = (s: string, max: number) => (s.length > max ? `…${s.slice(s.length - max + 1)}` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Inline code that survives backticks in the text. */
const code = (s: string) => `\`${s.replace(/`/g, 'ˋ')}\``;

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return sec % 60 ? `${m}m ${sec % 60}s` : `${m}m`;
}

function thinkingBody(steps: ProgressStep[], o: ModelOptions): string {
  const blocks = steps.filter((s): s is Extract<ProgressStep, { kind: 'reasoning' | 'narration' }> => (s.kind === 'reasoning' || s.kind === 'narration') && !!s.text.trim());
  if (!blocks.length) return '';
  const shown = blocks.slice(-o.maxEntries);
  const per = Math.max(200, Math.floor(o.panelMaxChars / shown.length));
  const parts = shown.map((s) => {
    const t = clipTail(s.text.trim(), per);
    return s.kind === 'narration' && o.style !== 'plain' ? `${NARRATION_ICON} ${t}` : t;
  });
  const head = labels(o.locale).thinkingCount(blocks.length, shown.length);
  return clipTail([head, ...parts].filter(Boolean).join('\n\n'), o.panelMaxChars);
}

function toolsBody(steps: ProgressStep[], o: ModelOptions): string {
  const tools = steps.filter((s): s is Extract<ProgressStep, { kind: 'tool' }> => s.kind === 'tool');
  if (!tools.length) return '';
  const shown = tools.slice(-o.maxEntries);
  const lines = shown.map((t) => {
    const indent = t.parentItemId ? '　↳ ' : '';
    const title = code(clip(oneLine(t.title), 120));
    const st = labels(o.locale).toolStatus[t.status];
    let line = o.style === 'plain' ? `${indent}${title}${st ? ` ${st}` : ''}` : `${indent}${TOOL_MARK[t.status]} ${title}`;
    if (t.isError && t.resultPreview) line += `\n${indent}　> ${clip(oneLine(t.resultPreview), 200)}`;
    return line;
  });
  const body = [labels(o.locale).toolsCount(tools.length, shown.length), ...lines].join('\n');
  return clipTail(body, o.panelMaxChars);
}

function planBody(p: ProgressView): string {
  if (!p.plan?.length) return '';
  return p.plan.map((s) => `${PLAN_MARK[s.status]} ${oneLine(s.text)}`).join('\n');
}

const bytes = (s: string) => Buffer.byteLength(s);

/** Split one line into pieces of at most `max` UTF-8 bytes (never inside a code point). */
function hardSplit(line: string, max: number): string[] {
  if (bytes(line) <= max) return [line];
  const out: string[] = [];
  let cur = '';
  let n = 0;
  for (const ch of line) {
    const b = bytes(ch);
    if (cur && n + b > max) {
      out.push(cur);
      cur = '';
      n = 0;
    }
    cur += ch;
    n += b;
  }
  out.push(cur);
  return out;
}

const FENCE = /^\s*(`{3,}|~{3,})/;

/** Fence-aware markdown split: every page fits `maxBytes`; a page cut inside a code fence closes it and the next reopens it. */
export function splitMarkdown(text: string, maxBytes: number): string[] {
  if (maxBytes <= 0 || bytes(text) <= maxBytes) return [text];
  const budget = Math.max(32, maxBytes - 16); // room for a closing fence
  const pages: string[] = [];
  let cur = '';
  let curBytes = 0;
  let fence: string | null = null; // opening fence line while inside a code block
  const push = () => {
    pages.push(fence ? `${cur}\n${FENCE.exec(fence)![1]}` : cur);
    cur = fence ?? '';
    curBytes = bytes(cur);
  };
  for (const line of text.split('\n')) {
    const room = budget - (fence ? bytes(fence) + 1 : 0) - 1;
    for (const piece of hardSplit(line, Math.max(8, room))) {
      const pb = bytes(piece);
      if (cur && cur !== fence && curBytes + 1 + pb > budget) push();
      curBytes += (cur ? 1 : 0) + pb;
      cur = cur ? `${cur}\n${piece}` : piece;
    }
    if (FENCE.test(line)) fence = fence ? null : line;
  }
  if (cur && cur !== fence) pages.push(cur);
  return pages;
}

export function buildModel(msg: RenderedMessage, p: ProgressView, o: ModelOptions): ProcessModel {
  const t = labels(o.locale);
  const status = p.status;
  const done = status !== 'running' && status !== 'requires_action';
  const statusSection = msg.sections?.find((s) => s.kind === 'status')?.text;
  const current = done ? t.status[status] : (statusSection ?? p.headline ?? t.working);
  const plain = o.style === 'plain';
  const banner = plain ? current : `${ICON[status]} ${current}`;
  const panelTitle = (k: PanelKey) => (plain ? t.panel[k] : `${PANEL_ICON[k]} ${t.panel[k]}`);

  const panels: ProcessModel['panels'] = [];
  if (!o.processElsewhere) {
    const th = thinkingBody(p.steps, o);
    if (th) panels.push({ key: 'thinking', title: panelTitle('thinking'), body: th });
    const tl = toolsBody(p.steps, o);
    if (tl) panels.push({ key: 'tools', title: panelTitle('tools'), body: tl });
  }
  const pl = planBody(p);
  if (pl) panels.push({ key: 'plan', title: panelTitle('plan'), body: pl });

  const full = (done ? p.answer || msg.text : p.answer).trim();
  const pages = full ? splitMarkdown(full, o.answerBytes) : [''];
  let answer = pages[0] ?? '';
  const overflow = done ? pages.slice(1) : [];
  if (pages.length > 1) answer += `\n\n${done ? t.continued : t.continuing}`;
  if (!answer) answer = done ? `_${t.status[status]}_` : '…';

  const toolCount = p.steps.filter((s) => s.kind === 'tool').length;
  const started = p.startedAt;
  const elapsed = started !== undefined ? formatDuration((p.endedAt ?? o.now) - started) : undefined;
  const footerParts = done
    ? [plain ? t.status[status] : `${ICON[status]} ${t.status[status]}`, elapsed ? `${t.elapsed} ${elapsed}` : '', toolCount ? t.tools(toolCount) : '']
    : [elapsed ? `${t.running} ${elapsed}` : '', toolCount ? t.tools(toolCount) : ''];
  const footer = footerParts.filter(Boolean).join(' · ') || ' ';

  return {
    status,
    done,
    title: t.status[status],
    template: TEMPLATE[status],
    summary: clip(oneLine(done ? full || t.status[status] : current), 60),
    banner,
    panels,
    answer,
    overflow,
    actions: done ? [] : (msg.actions ?? []),
    footer,
  };
}

const md = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ tag: 'markdown', element_id: id, content, ...extra });

export function statusElement(m: ProcessModel) {
  return md(EL.status, m.banner, { text_size: 'notation' });
}

export function footerElement(m: ProcessModel) {
  return md(EL.footer, m.footer, { text_size: 'notation' });
}

export function panelElement(panel: ProcessModel['panels'][number]) {
  return {
    tag: 'collapsible_panel',
    element_id: EL.panel(panel.key),
    expanded: false,
    header: {
      title: { tag: 'markdown', content: `**${panel.title}**` },
      // Header colours must be enum tokens (hex/rgba are rejected with code 11310).
      background_color: 'grey-50',
      padding: '4px 8px 4px 8px',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements: [md(EL.panelBody(panel.key), panel.body, { text_size: 'notation' })],
  };
}

/** Button element ids are derived from the action id so they stay stable across updates. */
export function actionElementId(actionId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < actionId.length; i++) h = Math.imul(h ^ actionId.charCodeAt(i), 0x01000193) >>> 0;
  return `act_${h.toString(16).padStart(8, '0')}`;
}

export function actionElement(a: NonNullable<RenderedMessage['actions']>[number]) {
  return {
    tag: 'button',
    element_id: actionElementId(a.id),
    text: { tag: 'plain_text', content: a.label },
    type: a.style ?? 'default',
    behaviors: [{ type: 'callback', value: { actionId: a.id } }],
  };
}

/** Typewriter tuning for CardKit streaming mode (per platform). */
export const STREAMING_CONFIG = {
  print_frequency_ms: { default: 30, android: 25, ios: 40, pc: 50 },
  print_step: { default: 2, android: 3, ios: 4, pc: 5 },
  print_strategy: 'fast',
};

/** Card JSON 2.0 for the model. `streaming` turns on CardKit streaming mode (CardKit cards only). */
export function processCard(m: ProcessModel, o: { streaming?: boolean } = {}): Record<string, unknown> {
  const elements: unknown[] = [statusElement(m)];
  for (const k of PANEL_ORDER) {
    const p = m.panels.find((x) => x.key === k);
    if (p) elements.push(panelElement(p));
  }
  elements.push(md(EL.answer, m.answer));
  for (const a of m.actions) elements.push(actionElement(a));
  elements.push(footerElement(m));
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
      summary: { content: m.summary },
      ...(o.streaming ? { streaming_mode: true, streaming_config: STREAMING_CONFIG } : {}),
    },
    header: { title: { tag: 'plain_text', content: m.title }, template: m.template },
    body: { elements },
  };
}

/** Shrink panels, then the answer, until the card fits `maxBytes` (message create/patch path). */
export function fitProcessCard(m: ProcessModel, maxBytes: number, o: { streaming?: boolean } = {}): Record<string, unknown> {
  let model = m;
  let card = processCard(model, o);
  let factor = 1;
  while (bytes(JSON.stringify(card)) > maxBytes && factor > 0.02) {
    factor *= 0.7;
    model = {
      ...m,
      panels: m.panels.map((p) => ({ ...p, body: clipTail(p.body, Math.max(40, Math.floor(p.body.length * factor))) })),
      answer: factor < 0.5 ? clip(m.answer, Math.max(40, Math.floor(m.answer.length * factor * 2))) : m.answer,
    };
    card = processCard(model, o);
  }
  return card;
}
