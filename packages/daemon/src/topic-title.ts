import { randomUUID } from 'node:crypto';
import type { HarnessAdapter, InputRecord, KernelContext, ModuleManifest, RunSpec, SessionEvent } from '@agents-io/protocol';

/*
 * Topic titles made by the model, as a built-in feature module (core-slimming G4, G6 step 2;
 * `bundle.ts` registers it, nothing else in the daemon imports it). After a completed turn of a
 * configured agent's topic session, on the 1st completed turn and every 3rd after, it asks the
 * harness that turn ran on (when it declares `ephemeralOpen`: Codex) for a short title in an
 * ephemeral session of its own, and gives it to the topic while the topic's title is still the
 * generated one it read (`KernelContext.topics.setAutoTitle`, which also edits the latest card).
 * A host-level feature (decision 16): on by default; `topicTitles: { enabled: false }` turns it
 * off, and a host names its topics itself (docs/HOSTS.md §4.4).
 */

/** The `topicTitles` section of the config file: only `enabled` (the daemon's). */
export interface TopicTitleSection {
  enabled?: boolean;
}

/** What the section resolves to: nothing of its own yet. */
export type TopicTitleConfig = Record<string, never>;

export const topicTitleModule: ModuleManifest<TopicTitleConfig> = {
  id: 'topic-title',
  kind: 'feature',
  needs: ['kernel:events', 'kernel:topics', 'kernel:lanes', 'kernel:stopping'],
  config: {
    section: 'topicTitles',
    schema: {},
    // On, as it was before it was a module: a file without the section titles topics.
    defaultEnabled: true,
    resolve: () => ({}),
  },
  setup: (kernel) => {
    // One title job per topic at a time.
    const jobs = new Set<string>();
    return {
      hooks: {
        onTurnCompleted: ({ sessionKey, turnId, status }) => {
          if (status === 'completed') void titleTopic(kernel, jobs, sessionKey, turnId).catch((e) => kernel.log('warn', `${sessionKey}: title update failed: ${(e as Error).message}`));
        },
      },
    };
  },
};

/** After a completed turn: title the session's topic when the turn is its 1st or every 3rd after (see the file comment). */
async function titleTopic(k: KernelContext, jobs: Set<string>, sessionKey: string, turnId: string): Promise<void> {
  const topic = k.topics.bySession(sessionKey);
  if (!topic || k.topics.titleSource(topic.id) !== 'auto') return;
  const lane = k.lanes.harness(sessionKey);
  if (!lane || jobs.has(topic.id)) return;
  const events = k.events(sessionKey);
  const started = events.find((e) => e.body.t === 'turn.started' && e.body.turnId === turnId);
  if (started?.body.t !== 'turn.started' || !started.body.inputIds.length) return;
  // The turn's own instance: a session's preset may have moved it off the agent's.
  const name = started.body.run?.harness ?? lane.instance;
  const adapter = lane.adapter(name);
  // An ephemeral session of the harness that ran the turn, where it can open one (Codex).
  if (adapter.ephemeralOpen !== true) return;
  const eligible = new Set(events.filter((e) => e.body.t === 'turn.started' && e.body.inputIds.length > 0).map((e) => e.body.t === 'turn.started' ? e.body.turnId : ''));
  const completed = events.filter((e) => e.body.t === 'turn.completed' && e.body.status === 'completed' && eligible.has(e.body.turnId)).length;
  if (completed !== 1 && completed % 3 !== 1) return;
  const expected = topic.title;
  const prompt = topicTitlePrompt(events, expected);
  if (!prompt) return;
  const run = started.body.run ?? { ...lane.run(name), profile: 'restricted' };
  jobs.add(topic.id);
  try {
    const title = await generateTopicTitle(adapter, { cwd: lane.cwd, run, prompt });
    // A name given meanwhile wins (setAutoTitle checks it is still auto and still `expected`).
    if (!k.stopping() && title) k.topics.setAutoTitle(topic.id, expected, title);
  } finally {
    jobs.delete(topic.id);
  }
}

const MAX_CONTEXT = 4000;
const MAX_TITLE = 36;

/** Only human messages and final answers enter the title prompt; no tool output or request answers. */
export function topicTitlePrompt(events: SessionEvent[], current?: string): string | undefined {
  const lines: string[] = [];
  for (const e of events) {
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
    // In place of the agent's instructions.
    instructions: 'You only return a brief title for supplied text. Do not use tools or read files.',
    options: {
      ephemeral: true,
      preface: false,
      profiles: { 'topic-title': { approvalPolicy: 'never', sandbox: 'read-only' } },
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
