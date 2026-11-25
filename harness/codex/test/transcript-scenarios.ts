import type { HarnessEvent, HarnessSession, InputRecord, RunSpec } from '@agents-io/protocol';
import type { CodexProfile } from '../src/index.js';

/*
 * The Codex sessions recorded as transcripts (packages/testkit/conformance/transcripts/codex/,
 * docs/design/conformance-fixtures §2): what the recording did with a real `codex app-server`
 * (`harness/codex/scripts/record-transcripts.ts`) and the replay does again through the real
 * adapter (`transcripts.test.ts`). The inputs are fixed, so the adapter writes the same frames; each
 * action waits on an event the transcript has before the frame the action makes.
 */

/** A session's events as they come, and a wait for the first one that matches. */
export interface Events {
  readonly all: HarnessEvent[];
  until(pred: (e: HarnessEvent) => boolean, ms?: number): Promise<HarnessEvent>;
}

export function events(s: HarnessSession): Events & { done: Promise<void> } {
  const all: HarnessEvent[] = [];
  const waiters: { pred: (e: HarnessEvent) => boolean; resolve: (e: HarnessEvent) => void }[] = [];
  const done = (async () => {
    for await (const e of s.events) {
      all.push(e);
      for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
    }
  })();
  return {
    all,
    done,
    until(pred, ms = 120_000) {
      const hit = all.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          if (!waiters.includes(w)) return;
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`no matching event within ${ms}ms; got ${all.map((e) => e.body.t).join(', ')}`));
        }, ms).unref();
      });
    },
  };
}

export const input = (inputId: string, text: string): InputRecord => ({
  inputId,
  origin: { kind: 'human', principal: { id: 'owner', labels: ['owner'] }, evidence: 'platform_signed', via: 'local:me', adapter: 'local' },
  content: [{ type: 'text', text }],
  replyRoute: null,
  channelContext: {},
});

const completed = (e: HarnessEvent) => e.body.t === 'turn.completed';

export interface CodexScenario {
  name: string;
  description: string;
  run: RunSpec;
  profiles?: Record<string, CodexProfile>;
  /** What the session is asked and when; resolves once its turn completed. */
  drive(s: HarnessSession, ev: Events): Promise<void>;
}

const model = 'gpt-6-sol';

export const CODEX_SCENARIOS: CodexScenario[] = [
  {
    name: 'plain-turn',
    description: 'One turn answered with text, no tools; the session closes after it.',
    run: { harness: 'codex', model, effort: 'low', profile: 'bypass' },
    async drive(s, ev) {
      await s.startTurn('t1', [input('in-1', 'Reply with exactly the word: pong. Do not run any command.')]);
      await ev.until(completed);
    },
  },
  {
    name: 'steer',
    description: 'A long answer steered once it started: the steered input joins the running turn, which then answers it.',
    run: { harness: 'codex', model, effort: 'low', profile: 'bypass' },
    async drive(s, ev) {
      await s.startTurn('t1', [input('in-1', 'Count from 1 to 400, one number per line, with no other text. Do not run any command.')]);
      await ev.until((e) => e.body.t === 'text.delta');
      const r = await s.steer([input('in-2', 'Stop counting now and reply with exactly the word: steered')], 't1');
      if (r !== 'steered') throw new Error(`steer answered ${r}`);
      await ev.until(completed);
    },
  },
  {
    name: 'approval',
    description: 'A command that needs approval: the request opens, is allowed once, the command runs and the turn completes.',
    run: { harness: 'codex', model, effort: 'low', profile: 'ask' },
    profiles: { ask: { approvalPolicy: 'untrusted', sandbox: 'read-only' } },
    async drive(s, ev) {
      await s.startTurn('t1', [input('in-1', 'Run exactly this shell command in the current directory: touch approved.txt — then reply with the word: done')]);
      const opened = await ev.until((e) => e.body.t === 'request.opened');
      await s.respond((opened.body as { requestId: string }).requestId, { kind: 'allow_once' });
      await ev.until(completed);
    },
  },
  {
    name: 'interrupt',
    description: 'A long answer interrupted once it started: the turn ends interrupted.',
    run: { harness: 'codex', model, effort: 'low', profile: 'bypass' },
    async drive(s, ev) {
      await s.startTurn('t1', [input('in-1', 'Count from 1 to 400, one number per line, with no other text. Do not run any command.')]);
      await ev.until((e) => e.body.t === 'text.delta');
      await s.interrupt('t1');
      await ev.until(completed);
    },
  },
];
