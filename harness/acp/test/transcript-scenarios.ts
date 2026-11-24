import type { HarnessAdapter, HarnessEvent, HarnessOpenArgs, HarnessSession, InputRecord, RunSpec } from '@agents-io/protocol';

/*
 * The ACP sessions recorded as transcripts (packages/testkit/conformance/transcripts/acp/,
 * docs/design/conformance-fixtures §2): what the recording did with a real ACP agent
 * (`harness/acp/scripts/record-transcripts.ts`) and the replay does again through the real adapter
 * (`transcripts.test.ts`). The inputs are fixed, so the adapter writes the same frames; each action
 * waits on an event the transcript has before the frame the action makes.
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
    until(pred, ms = 180_000) {
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

export interface AcpScenario {
  name: string;
  description: string;
  run: RunSpec;
  /** The instance's profiles (`AcpHarnessOptions.profiles`): the session mode a turn's profile selects. */
  profiles?: Record<string, Record<string, unknown>>;
  /**
   * Done on another agent process before the recorded one starts, not recorded: what the recorded
   * session resumes (`open({ resume })` with the native id it answers). The replay gives a made-up id.
   */
  before?(adapter: HarnessAdapter, open: HarnessOpenArgs): Promise<string>;
  /** What the session is asked and when; resolves once its turn completed. */
  drive(s: HarnessSession, ev: Events): Promise<void>;
}

const run: RunSpec = { harness: 'acp', model: '', profile: 'restricted' };

export const ACP_SCENARIOS: AcpScenario[] = [
  {
    name: 'plain-turn',
    description: 'One turn answered with text, no tools; the session closes after it.',
    run,
    async drive(s, ev) {
      await s.startTurn('t1', [input('in-1', 'Reply with exactly the word: pong. Do not use any tool.')], run);
      await ev.until(completed);
    },
  },
  {
    name: 'permission',
    description: 'A shell command the agent asks permission for (session/request_permission) in the session mode the profile selects (session/set_mode): allowed once, it runs and the turn completes.',
    run,
    // Claude Code's ACP agent opens in "auto"; "default" asks before it changes anything.
    profiles: { restricted: { mode: 'default' } },
    async drive(s, ev) {
      await s.startTurn('t1', [input('in-1', 'Run exactly this shell command in the current directory: touch approved.txt — then reply with the word: done')], run);
      const opened = await ev.until((e) => e.body.t === 'request.opened');
      await s.respond((opened.body as { requestId: string }).requestId, { kind: 'allow_once' });
      await ev.until(completed);
    },
  },
  {
    name: 'cancel',
    description: 'A long answer cancelled once it started (session/cancel): the turn ends interrupted.',
    run,
    async drive(s, ev) {
      await s.startTurn('t1', [input('in-1', 'Count from 1 to 400, one number per line, with no other text. Do not use any tool.')], run);
      await ev.until((e) => e.body.t === 'text.delta' && e.body.stream === 'answer');
      await s.interrupt('t1');
      await ev.until(completed);
    },
  },
  {
    name: 'load',
    description: 'A session resumed on a new agent process (session/load): the agent replays the conversation before it answers, and the next turn runs on it.',
    run,
    async before(adapter, open) {
      const s = await adapter.open(open);
      const ev = events(s);
      await s.startTurn('t0', [input('in-0', 'Remember the word: kiwi. Reply with exactly: ok')], run);
      await ev.until(completed);
      const id = s.nativeId()!;
      await s.close('recorded');
      await ev.done;
      return id;
    },
    async drive(s, ev) {
      await s.startTurn('t1', [input('in-1', 'Which word did I ask you to remember? Reply with just that word.')], run);
      await ev.until(completed);
    },
  },
];
