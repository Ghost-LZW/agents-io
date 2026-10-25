import { randomUUID } from 'node:crypto';
import type { HarnessAdapter, InputRecord, RunSpec, SessionEvent } from '@agents-io/protocol';

const MAX_CONTEXT = 4000;
const MAX_TITLE = 36;

/**
 * Only human messages and final answers enter the title prompt; no tool output or request answers.
 * `skip` (U20, a session an `outbound.scoped` host checks): events left out, e.g. the answers of
 * checked turns not past the exit check (what `withholding` withholds: checking, held or denied).
 */
export function topicTitlePrompt(events: SessionEvent[], current?: string, skip?: (e: SessionEvent) => boolean): string | undefined {
  const lines: string[] = [];
  for (const e of events) {
    if (skip?.(e)) continue;
    if (e.body.t === 'input.admitted' && e.body.input?.origin.kind === 'human') {
      const value = e.body.input.content.filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text').map((c) => c.text).join(' ').trim();
      if (value) lines.push(`User: ${value}`);
    } else if (e.body.t === 'text.snapshot' && e.body.final && e.audience === 'answer' && e.parentItemId === undefined) {
      if (e.body.text.trim()) lines.push(`Assistant: ${e.body.text.trim()}`);
    }
  }
  if (!lines.length) return undefined;
  const recent = lines.slice(-8).join('\n').slice(-MAX_CONTEXT);
  return `Name this conversation's current task in the user's language. Return only a concise single-line title, at most ${MAX_TITLE} characters. Keep the current title exactly if it is still accurate. Do not answer the conversation, use tools, or add punctuation.\nCurrent title: ${current ?? '(none)'}\nConversation:\n${recent}`;
}

/** An isolated ephemeral Codex thread keeps metadata generation out of the user's conversation. */
export async function generateTopicTitle(adapter: HarnessAdapter, args: { cwd: string; run: RunSpec; prompt: string; timeoutMs?: number }): Promise<string | undefined> {
  const id = randomUUID();
  const run: RunSpec = { ...args.run, profile: 'topic-title', effort: 'low', mode: 'default' };
  const session = await adapter.open({
    sessionKey: `topic-title:${id}`, generation: 1, cwd: args.cwd, run,
    options: {
      ephemeral: true,
      preface: false,
      profiles: { 'topic-title': { approvalPolicy: 'never', sandbox: 'read-only' } },
      developerInstructions: 'You only return a brief title for supplied text. Do not use tools or read files.',
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input: InputRecord = {
      inputId: `title:${id}`,
      origin: { kind: 'system', principal: null, evidence: 'daemon', via: 'topic-title', adapter: 'session' },
      content: [{ type: 'text', text: args.prompt }], replyRoute: null, channelContext: {},
    };
    const result = (async () => {
      let answer = '';
      await session.startTurn(id, [input], run);
      for await (const e of session.events) {
        if (e.body.t === 'text.delta' && e.body.stream === 'answer' && e.audience === 'answer') answer += e.body.delta;
        if (e.body.t === 'text.snapshot' && e.body.final && e.audience === 'answer') answer = e.body.text;
        if (e.body.t === 'turn.completed' && e.body.turnId === id) {
          if (e.body.status !== 'completed') return undefined;
          const title = answer.split(/\r?\n/)[0]?.replace(/^[\s"'`#*]+|[\s"'`#*。.!！?？]+$/g, '').trim();
          if (!title) return undefined;
          const chars = [...title];
          if (chars.length <= MAX_TITLE) return title;
          const clipped = chars.slice(0, MAX_TITLE).join('');
          const word = clipped.lastIndexOf(' ');
          return word > 20 ? clipped.slice(0, word) : clipped;
        }
      }
      return undefined;
    })();
    return await Promise.race([result, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), args.timeoutMs ?? 30_000); })]);
  } finally {
    if (timer) clearTimeout(timer);
    await session.close('topic title complete').catch(() => undefined);
  }
}
