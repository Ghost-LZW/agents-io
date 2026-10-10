import type { ProgressView, RenderedMessage, ReplyRoute } from '@agents-io/protocol';
import { LarkBotAdapter, type LarkBotConfig } from '../src/index.js';
import { FakeLark } from './fake-lark.js';

/* Shared by process.test.ts (core) and process.local.test.ts. */

export const cfg = {
  appId: 'cli_x',
  appSecret: 's',
  domain: 'feishu' as const,
  editMinIntervalMs: 0,
  streamTextIntervalMs: 0,
  streamAuxIntervalMs: 0,
};
export const route: ReplyRoute = { channel: 'lark-bot', account: 'acct', conversationId: 'oc_chat', replyToMessageId: 'om_in1' };

export function make(config: Partial<LarkBotConfig> = {}, lark = new FakeLark()) {
  const logs: string[] = [];
  const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps, sleep: async () => {}, log: (l, m) => logs.push(`${l}: ${m}`) });
  return { lark, adapter, logs };
}

/** A scripted turn: each call to `next` mutates the view and returns the message to render. */
export function turn(turnId = 't1') {
  const p: ProgressView = { turnId, status: 'running', steps: [], answer: '', answerFinal: false, startedAt: 1000 };
  const msg = (extra: Partial<RenderedMessage> = {}): RenderedMessage => ({
    text: p.answer || '…',
    sections: [{ kind: 'status', text: 'Working…' }],
    progress: structuredClone(p),
    ...extra,
  });
  return { p, msg };
}

export function script(t: ReturnType<typeof turn>) {
  const { p } = t;
  return [
    () => p.steps.push({ kind: 'reasoning', id: 'r0', text: 'Thinking about it', done: false }),
    () => {
      (p.steps[0] as { done: boolean }).done = true;
      p.steps.push({ kind: 'tool', itemId: 'i1', type: 'command', title: 'Bash: ls', status: 'running', inputSummary: 'ls' });
      p.plan = [{ text: 'look', status: 'in_progress' }];
    },
    () => {
      Object.assign(p.steps[1]!, { status: 'completed', resultPreview: 'a.ts', isError: false });
      p.steps.push({ kind: 'narration', id: 'n2', text: 'Now reading' });
      p.answer = 'Found a.ts';
    },
    () => {
      p.answer += ' and more.';
    },
  ];
}

export async function run(adapter: LarkBotAdapter, t: ReturnType<typeof turn>, extra: Partial<RenderedMessage> = {}, r = route) {
  const { providerMessageId: id } = await adapter.send(r, t.msg(extra), { operationId: `${t.p.turnId}:open` });
  let seq = 0;
  for (const step of script(t)) {
    step();
    await adapter.edit(r, id!, t.msg({ sections: [{ kind: 'status', text: `▶ step ${seq}` }], ...extra }), { operationId: `${t.p.turnId}:e${++seq}`, sequence: seq });
  }
  t.p.status = 'completed';
  t.p.answerFinal = true;
  t.p.endedAt = 5000;
  await adapter.finalize(r, id!, t.msg({ sections: [{ kind: 'status', text: 'Done' }] }));
  await adapter.settled();
  return id!;
}

export const cardOf = (lark: FakeLark, id: string) => {
  const m = lark.messages.find((x) => x.id === id)!;
  return lark.cards.get(JSON.parse(m.content).data.card_id)!;
};
