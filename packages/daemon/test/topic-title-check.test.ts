import { describe, expect, it } from 'vitest';
import type { FakeTurnScript } from '@agents-io/testkit';
import { CODEX_DECLARES } from './declares.js';
import { daemon, until } from './helpers.js';

/*
 * U20 and the topic titles the model makes (the `topic-title` module): where an `outbound.scoped`
 * host checks a topic's conversation, the kernel calls the module's `onTurnCompleted` for a checked
 * turn once its checked answer settled, the module leaves out of the title prompt what a reader
 * outside the host may not read (a held answer), and the kernel asks the host about the title
 * (`kind: title`) before keeping the title, whichever module made it: `KernelContext.topics.setAutoTitle`.
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };
const CONV = 'fake:default:c-alice';
const textOf = (inputs: { content: { type: string; text?: string }[] }[]) => inputs.flatMap((i) => i.content).map((c) => c.text ?? '').join(' ');

describe('generated topic titles where the scoped host checks', () => {
  it('the title is asked of the host (kind title) before it is kept: held, not kept; allowed, kept. The prompt has what passed the check: not a held answer, and the turn\'s own answer once it was let out #DL-7', async () => {
    const prompts: string[] = [];
    let titles = 0;
    const script: FakeTurnScript = async (t) => {
      // The module's title turn (the kernel's ephemeral session): what it was asked, and a title.
      if (t.inputs[0]?.origin.via === 'topic-title') {
        prompts.push(textOf(t.inputs));
        t.emit({ t: 'text.snapshot', text: `Title ${++titles}`, final: true }, { audience: 'answer' });
        return;
      }
      t.emit({ t: 'text.snapshot', text: `echo: ${textOf(t.inputs)}`, final: true }, { audience: 'answer' });
    };
    // A configured agent on an instance that runs ephemeral turns (as Codex declares): its topics get titles.
    const w = await daemon({ raw: { agents: { helper: { harness: 'claude-code' } } }, declares: CODEX_DECLARES, script });
    const h = await w.client();
    const asked: Record<string, unknown>[] = [];
    let reply: unknown = { verdict: 'hold', reason: 'private' };
    let title: unknown = { verdict: 'hold', reason: 'not yet' };
    h.onRequest('policy', (f) => {
      const a = (f as { args: Record<string, unknown> }).args;
      asked.push(a);
      return a.kind === 'title' ? title : a.kind === 'reply' ? reply : { verdict: 'allow' };
    });
    await h.hello({ token: w.gw.token, name: 'lb', callouts: ['outbound.scoped'], outboundScope: { routes: [{ channel: 'fake', account: 'default', conversationId: 'c-alice' }] } } as never);
    const topic = () => w.gw.topics.list({ conversation: CONV })[0]!;
    const completed = () => w.gw.hub.log.read(topic().sessionKey, 0).filter((e) => e.body.t === 'turn.completed').length;
    const say = async (text: string) => {
      const before = w.gw.topics.list({ conversation: CONV }).length ? completed() : 0;
      await w.chat.inject({ ...dm, sender: alice, text });
      await until(() => w.gw.topics.list({ conversation: CONV }).length > 0 && completed() > before, 5000);
    };

    // The first turn: checked, its answer held. Its title job comes once that settled; the held answer is not in the prompt.
    await say('plan the offsite');
    await until(() => asked.some((a) => a.kind === 'title'), 5000);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('User: plan the offsite');
    expect(prompts[0]).not.toContain('echo:');
    expect(asked.filter((a) => a.kind === 'title')).toEqual([expect.objectContaining({ kind: 'title', content: { text: 'Title 1' }, to: expect.objectContaining({ conversationId: 'c-alice' }) })]);
    // Held: not kept, the topic keeps the title of its first message.
    await new Promise((r) => setTimeout(r, 50));
    expect(topic().title).toBe('plan the offsite');
    expect(w.gw.topics.titleSource(topic().id)).toBe('auto');

    // Answers let out from now on, titles too: the 4th completed turn is titled from what passed the check.
    reply = { verdict: 'allow' };
    title = { verdict: 'allow' };
    for (const text of ['the budget', 'the venue', 'the agenda']) await say(text);
    await until(() => topic().title === 'Title 2', 5000);
    expect(prompts).toHaveLength(2);
    // The turn's own answer is in: the hook came after it settled (past the check), not while it was being checked.
    expect(prompts[1]).toContain('Assistant: echo: the agenda');
    expect(prompts[1]).not.toContain('echo: plan the offsite');
    expect(asked.filter((a) => a.kind === 'title').map((a) => a.content)).toEqual([{ text: 'Title 1' }, { text: 'Title 2' }]);
  });
});
