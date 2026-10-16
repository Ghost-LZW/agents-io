import type { BodyOf, Decision, RequestQuestion } from '@agents-io/protocol';

/** A channel-neutral question form. Adapters with forms may render it directly. */
export const QUESTION_KEY = 'agents-io/question';
export interface QuestionData {
  actionId: string;
  title: string;
  questions: RequestQuestion[];
  state?: 'submitted' | 'ended';
}

/** Includes the session so simultaneous native requests with the same id cannot cross topics. */
export function questionActionId(sessionKey: string, requestId: string): string {
  return `ask:${Buffer.from(JSON.stringify([sessionKey, requestId])).toString('base64url')}`;
}

export function parseQuestionActionId(id: string): { sessionKey: string; requestId: string } | undefined {
  if (!id.startsWith('ask:') || id.length > 1024) return undefined;
  try {
    const pair: unknown = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString());
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((s) => typeof s === 'string' && s.length > 0)) return undefined;
    return { sessionKey: pair[0], requestId: pair[1] };
  } catch {
    return undefined;
  }
}

/** Text fallback for channels without forms; a single answer needs no JSON. */
export function questionPrompt(req: BodyOf<'request.opened'>, actionId: string): string {
  const questions = req.questions?.length ? req.questions : [{ id: '0', text: req.title }];
  const lines = questions.flatMap((q, i) => [
    `${i + 1}. ${q.text}${q.multiSelect ? ' (multiple answers allowed)' : ''}`,
    ...(q.options?.length ? q.options.map((o) => `   • ${o.label}${o.description ? ` — ${o.description}` : ''}`) : []),
  ]);
  const example = questions.length === 1
    ? `/answer ${actionId} your answer`
    : `/answer ${actionId} {${questions.map((q) => `${JSON.stringify(q.id)}:"your answer"`).join(',')}}`;
  return `Please answer to continue:\n${lines.join('\n')}\n\nReply with ${example}`;
}

function checked(req: BodyOf<'request.opened'>, values: Record<string, unknown>): Decision | string {
  const questions = req.questions?.length ? req.questions : [{ id: '0', text: req.title }];
  const answers: Record<string, string | string[]> = {};
  for (const [i, q] of questions.entries()) {
    const value = values[q.id];
    if (q.multiSelect) {
      const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/).map((s) => s.trim()) : [];
      if (!list.length || list.some((s) => typeof s !== 'string' || !s.trim())) return `Question ${i + 1} needs an answer.`;
      answers[q.id] = list.map((s) => s.trim());
    } else {
      if (typeof value !== 'string' || !value.trim()) return `Question ${i + 1} needs an answer.`;
      answers[q.id] = value.trim();
    }
  }
  return { kind: 'answer', answers };
}

/** Values from a Lark form use q0, q1…; no field name is trusted as a question id. */
export function questionFormAnswer(req: BodyOf<'request.opened'>, form: Record<string, unknown>): Decision | string {
  const questions = req.questions?.length ? req.questions : [{ id: '0', text: req.title }];
  const values: Record<string, unknown> = {};
  for (const [i, q] of questions.entries()) {
    const legacy = form[`q${i}`];
    if (!q.options?.length || q.secret || (form[`q${i}_choice`] === undefined && form[`q${i}_other`] === undefined)) {
      values[q.id] = legacy;
      continue;
    }
    const selected = form[`q${i}_choice`];
    const indexes = selected === undefined || selected === null || selected === '' ? [] : Array.isArray(selected) ? selected : [selected];
    if (indexes.some((v) => typeof v !== 'string' || !/^\d+$/.test(v) || !q.options![Number(v)])) return `Question ${i + 1} has an invalid option.`;
    if (!q.multiSelect && indexes.length > 1) return `Question ${i + 1} has an invalid option.`;
    const labels = indexes.map((v) => q.options![Number(v)]!.label);
    const other = typeof form[`q${i}_other`] === 'string' ? (form[`q${i}_other`] as string).trim() : '';
    values[q.id] = q.multiSelect
      ? [...new Set([...labels, ...other.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)])]
      : other || labels[0];
  }
  return checked(req, values);
}

export function questionTextAnswer(req: BodyOf<'request.opened'>, text: string): Decision | string {
  const questions = req.questions?.length ? req.questions : [{ id: '0', text: req.title }];
  if (questions.length === 1 && !text.trim().startsWith('{')) return checked(req, { [questions[0]!.id]: text });
  try {
    const values: unknown = JSON.parse(text);
    if (!values || typeof values !== 'object' || Array.isArray(values)) return 'Answers must be a JSON object keyed by question id.';
    return checked(req, values as Record<string, unknown>);
  } catch {
    return 'For multiple questions, provide a JSON object keyed by question id.';
  }
}
