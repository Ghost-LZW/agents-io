import type { HarnessEvent, HarnessOpenArgs, HarnessSession, InputRecord } from '@agents-io/protocol';
import { CodexHarness, type CodexHarnessOptions } from '../src/index.js';
import { FakeAppServer } from './fake-app-server.js';

export const input = (id: string, text: string, extra: Partial<InputRecord> = {}): InputRecord => ({
  inputId: id,
  origin: { kind: 'human', principal: { id: 'owner', labels: ['owner'] }, evidence: 'platform_signed', via: 'lark:a:c1', adapter: 'lark' },
  content: [{ type: 'text', text }],
  replyRoute: { channel: 'lark', account: 'a', conversationId: 'c1' },
  channelContext: { chat: 'Team' },
  ...extra,
});

export const run = { harness: 'codex', model: 'gpt-5.5', effort: 'high', profile: 'bypass' };

export function setup(opts: Partial<CodexHarnessOptions> = {}) {
  const fake = new FakeAppServer();
  const harness = new CodexHarness({ transport: fake.transport, ...opts });
  return { fake, harness };
}

export async function open(harness: CodexHarness, over: Partial<HarnessOpenArgs> = {}) {
  return harness.open({ sessionKey: 's1', generation: 1, cwd: '/work', run, ...over });
}

/** Collects events until `until` matches (inclusive). */
export function collector(s: HarnessSession) {
  const events: HarnessEvent[] = [];
  const waiters: { pred: (e: HarnessEvent) => boolean; resolve: (e: HarnessEvent) => void }[] = [];
  let ended = false;
  const done = (async () => {
    for await (const e of s.events) {
      events.push(e);
      for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
    }
    ended = true;
  })();
  return {
    events,
    done,
    get ended() {
      return ended;
    },
    until(pred: (e: HarnessEvent) => boolean): Promise<HarnessEvent> {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    of<T extends HarnessEvent['body']['t']>(t: T) {
      return events.filter((e) => e.body.t === t).map((e) => e.body as Extract<HarnessEvent['body'], { t: T }>);
    },
  };
}

export const isCompleted = (e: HarnessEvent) => e.body.t === 'turn.completed';
export const tick = () => new Promise((r) => setTimeout(r, 5));
