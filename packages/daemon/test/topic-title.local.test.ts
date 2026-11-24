import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessEvent, SessionEvent } from '@agents-io/protocol';
import { MemorySessionLog, TOPIC_KEY, withholding } from '@agents-io/session';
import { FakeChannel, FakeHarness, type FakeHarnessSession, type FakeTurnScript } from '@agents-io/testkit';
import { type HarnessInstance, LocalClient } from '@agents-io/kernel';
import { Gateway, InstanceHarness, resolveConfig } from '../src/defaults.js';
import { generateTopicTitle, topicTitlePrompt } from '../src/topic-title.js';
import { CLAUDE_CODE_DECLARES, CODEX_DECLARES } from './declares.js';
import { cleanups, tmp, until } from './helpers.js';

describe('topic title generation', () => {
  it('uses human text and final answers, excluding other event content', () => {
    const event = (body: SessionEvent['body'], audience: SessionEvent['audience'] = 'status') => ({ body, audience }) as SessionEvent;
    const prompt = topicTitlePrompt([
      event({ t: 'input.admitted', inputId: 'i1', disposition: 'new_turn', input: { inputId: 'i1', origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: 'chat', adapter: 'fake' }, content: [{ type: 'text', text: 'Build a calendar' }], replyRoute: null, channelContext: {} } }),
      event({ t: 'text.snapshot', text: 'Use the existing calendar API', final: true }, 'answer'),
      event({ t: 'request.resolved', requestId: 'secret', decision: null, by: 'runtime_cancelled' }),
    ], 'Build a calendar');
    expect(prompt).toContain('User: Build a calendar');
    expect(prompt).toContain('Assistant: Use the existing calendar API');
    expect(prompt).not.toContain('secret');
  });

  it('a session the scoped host checks: what has not passed the check is left out (withholding) #DL-7', () => {
    const route = { channel: 'fake', account: 'default', conversationId: 'g1' };
    const human = { kind: 'human' as const, principal: null, evidence: 'platform_signed' as const, via: 'chat', adapter: 'fake' };
    const e = (seq: number, body: SessionEvent['body'], extra: Partial<SessionEvent> = {}) => ({ seq, ts: seq, level: 'primary', audience: 'status', durability: 'durable', body, ...extra }) as SessionEvent;
    const events = [
      e(1, { t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: route, checked: true }, { turnId: 't1' }),
      e(2, { t: 'input.admitted', inputId: 'i1', disposition: 'new_turn', input: { inputId: 'i1', origin: human, content: [{ type: 'text', text: 'Plan the offsite' }], replyRoute: route, channelContext: {} } }, { turnId: 't1' }),
      e(3, { t: 'text.snapshot', text: 'Held private budget', final: true }, { turnId: 't1', audience: 'answer' }),
      e(4, { t: 'turn.completed', turnId: 't1', status: 'completed' }, { turnId: 't1' }),
      e(5, { t: 'delivery.settled', operationId: 'op1', route, result: 'held', kind: 'reply', turnId: 't1' }, { turnId: 't1' }),
      e(6, { t: 'turn.started', turnId: 't2', inputIds: ['i2'], replyRoute: route, checked: true }, { turnId: 't2' }),
      e(7, { t: 'text.snapshot', text: 'Agenda for the offsite', final: true }, { turnId: 't2', audience: 'answer' }),
      e(8, { t: 'turn.completed', turnId: 't2', status: 'completed' }, { turnId: 't2' }),
      e(9, { t: 'delivery.settled', operationId: 'op2', route, result: 'delivered', kind: 'reply', turnId: 't2' }, { turnId: 't2' }),
    ];
    const w = withholding(events);
    const prompt = topicTitlePrompt(events, undefined, (x) => x.body.t === 'text.snapshot' && w.of(x) !== undefined)!;
    expect(prompt).toContain('User: Plan the offsite');
    expect(prompt).toContain('Assistant: Agenda for the offsite');
    expect(prompt).not.toContain('budget');
  });

  it('generates a title in a separate ephemeral read-only session', async () => {
    let opened: any;
    let closed = false;
    const adapter: HarnessAdapter = {
      id: 'codex', probe: async () => ({ version: 'test', caps: {} as any }),
      open: async (args) => {
        opened = args;
        let turnId = '';
        return {
          nativeId: () => 'helper', startTurn: async (id) => { turnId = id; },
          steer: async () => 'unsupported', interrupt: async () => {}, respond: async () => {},
          close: async () => { closed = true; },
          events: { async *[Symbol.asyncIterator](): AsyncGenerator<HarnessEvent> {
            yield { ts: 1, turnId, level: 'primary', audience: 'answer', durability: 'durable', body: { t: 'text.snapshot', text: 'Plan calendar integration', final: true } };
            yield { ts: 2, turnId, level: 'primary', audience: 'status', durability: 'durable', body: { t: 'turn.completed', turnId, status: 'completed' } };
          } },
        };
      },
    };
    expect(await generateTopicTitle(adapter, { cwd: '/tmp', run: { harness: 'codex', model: 'default', profile: 'bypass' }, prompt: 'Name this task' })).toBe('Plan calendar integration');
    expect(opened.options).toMatchObject({ ephemeral: true, preface: false, profiles: { 'topic-title': { sandbox: 'read-only', approvalPolicy: 'never' } } });
    expect(closed).toBe(true);
  });
});

/*
 * When the daemon titles a topic (the `topic-title` module): after a completed turn of a configured
 * agent's topic session, on the instance that turn ran on when it declares `ephemeralOpen` (Codex
 * today), on the 1st completed turn and every 3rd after (4th, 7th, …), only while the topic's title
 * is generated (`titleSource` "auto"); a result that comes back after the topic was named is
 * dropped; the card of the latest turn is edited to carry the new title.
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };
const CONV = 'fake:default:c-alice';
const textOf = (inputs: { content: { type: string; text?: string }[] }[]) => inputs.flatMap((i) => i.content).map((c) => c.text ?? '').join(' ');

/**
 * A daemon with instances `cx` (a fake declaring what Codex declares: `ephemeralOpen`) and `cc`
 * (what Claude Code declares), each its own FakeHarness. `raw` goes over the config (`agents`,
 * `presets`, `defaultHarness`, …). A turn answers `echo: <text>` (`fail` fails it); a title turn
 * (the daemon's own ephemeral session) answers `Title <n>`, after `gate` when given.
 */
async function titled(raw: Record<string, unknown>, o: { gate?: () => Promise<void> } = {}) {
  const dir = tmp('aio-title-');
  mkdirSync(join(dir, 'work'), { recursive: true });
  let titles = 0;
  /** What each title turn was asked (the prompt). */
  const prompts: string[] = [];
  const script: FakeTurnScript = async (t) => {
    if (t.inputs[0]?.origin.via === 'topic-title') {
      prompts.push(textOf(t.inputs));
      await o.gate?.();
      t.emit({ t: 'text.snapshot', text: `Title ${++titles}`, final: true }, { audience: 'answer' });
      return;
    }
    const text = textOf(t.inputs);
    if (text === 'fail') throw new Error('the turn fails');
    t.emit({ t: 'text.snapshot', text: `echo: ${text}`, final: true }, { audience: 'answer' });
  };
  const declares: Record<string, object> = { cx: CODEX_DECLARES, cc: CLAUDE_CODE_DECLARES };
  const fakes: Record<string, FakeHarness> = {};
  const base = resolveConfig(
    {
      harnesses: { cx: { use: 'codex' }, cc: { use: 'claude-code' } },
      defaultHarness: 'cx',
      policy: { owners: ['fake:alice'] },
      local: { principal: 'fake:alice' },
      cwd: join(dir, 'work'),
      ...raw,
    },
    { env: {}, baseDir: dir, cwd: dir },
  );
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  const gw = await Gateway.start({
    config,
    buildHarness: (i: HarnessInstance) => new InstanceHarness(i, (fakes[i.name] ??= Object.assign(new FakeHarness(script), declares[i.name] ?? {}))),
    log: new MemorySessionLog(),
    channels: [{ adapter: chat }],
    logger: () => {},
  });
  cleanups.push(() => gw.stop());
  /** Every topic-title session opened, on any instance. */
  const titleSessions = (): (FakeHarnessSession & { instance: string })[] =>
    Object.entries(fakes).flatMap(([instance, f]) => f.sessions.filter((s) => s.args.sessionKey.startsWith('topic-title:')).map((s) => Object.assign(s, { instance })));
  const completed = (sk: string) => gw.hub.log.read(sk, 0).filter((e) => e.body.t === 'turn.completed').length;
  /** Alice says `text`; resolves once the session's turn for it completed (a command: once answered). */
  const say = async (text: string) => {
    const before = gw.sessions().reduce((n, s) => n + completed(s.sessionKey), 0);
    const sent = chat.sent.length;
    await chat.inject({ ...dm, sender: alice, text });
    if (text.startsWith('/')) return until(() => chat.sent.length > sent);
    return until(() => gw.sessions().reduce((n, s) => n + completed(s.sessionKey), 0) > before);
  };
  const topic = () => gw.topics.list({ conversation: CONV })[0]!;
  /** The card (sent record) whose text is the answer `echo: <text>`. */
  const card = (text: string) => chat.sent.find((s) => (s.edits.at(-1)?.text ?? s.msg.text) === `echo: ${text}`);
  const cardTitles = (text: string) => (card(text)?.edits ?? []).map((m) => ((m.channelData as Record<string, unknown> | undefined)?.[TOPIC_KEY] as { title?: string } | undefined)?.title);
  const client = async () => {
    const c = await LocalClient.connect(config.socketPath);
    cleanups.push(() => c.close());
    return c;
  };
  return { gw, say, topic, titleSessions, cardTitles, client, prompts, answered: () => titles };
}

/** Let a title job the last turn may have started open its session (it opens synchronously at the turn's end). */
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('topic titles in the daemon', () => {
  it("titles a configured agent's topic on its 1st completed turn and every 3rd after, in an ephemeral session of the turn's instance, and edits the latest card to carry it", async () => {
    const w = await titled({ agents: { helper: { harness: 'cx' } } });
    await w.say('one');
    expect(w.topic()).toMatchObject({ sessionKey: expect.any(String) });
    await until(() => w.topic().title === 'Title 1');
    const [first] = w.titleSessions();
    expect(first!.instance).toBe('cx');
    expect(first!.args).toMatchObject({ run: { harness: 'cx', profile: 'topic-title', effort: 'low', mode: 'default' }, options: { ephemeral: true, preface: false } });
    // The title prompt carries what was said in the topic and the title it has.
    expect(w.prompts[0]).toMatch(/Current title: one\nConversation:\nUser: one\nAssistant: echo: one$/);
    // The card of the turn that was titled is edited to carry the new title.
    await until(() => w.cardTitles('one').includes('Title 1'));
    expect(w.gw.topics.titleSource(w.topic().id)).toBe('auto');

    for (const text of ['two', 'three']) await w.say(text);
    await settle();
    expect(w.titleSessions()).toHaveLength(1);
    await w.say('four');
    await until(() => w.topic().title === 'Title 2');
    await until(() => w.cardTitles('four').includes('Title 2'));
    for (const text of ['five', 'six']) await w.say(text);
    await settle();
    expect(w.titleSessions()).toHaveLength(2);
    await w.say('seven');
    await until(() => w.topic().title === 'Title 3');
    expect(w.titleSessions()).toHaveLength(3);
  });

  it('counts only completed turns: a failed one neither titles nor counts', async () => {
    const w = await titled({ agents: { helper: { harness: 'cx' } } });
    await w.say('one');
    await until(() => w.topic().title === 'Title 1');
    await w.say('two');
    await w.say('fail');
    await w.say('three');
    await settle();
    // Completed: one, two, three (3): no title yet.
    expect(w.titleSessions()).toHaveLength(1);
    await w.say('four');
    await until(() => w.topic().title === 'Title 2');
  });

  it('only on an instance declaring ephemeralOpen: none on Claude Code', async () => {
    const w = await titled({ agents: { helper: { harness: 'cc' } } });
    await w.say('one');
    await settle();
    expect(w.titleSessions()).toEqual([]);
    expect(w.topic().title).toBe('one');
  });

  it("on the turn's own instance: a session the owner moved onto one declaring ephemeralOpen (/preset) is titled there", async () => {
    const w = await titled({
      presets: { fast: { harness: 'cx', model: 'gpt-x' } },
      agents: { helper: { harness: 'cc' } },
    });
    await w.say('/preset fast');
    await w.say('one');
    await until(() => w.topic().title === 'Title 1');
    expect(w.titleSessions().map((s) => [s.instance, s.args.run.harness, s.args.run.model])).toEqual([['cx', 'cx', 'gpt-x']]);
  });

  it('only for configured agents: none for the default agent of a deployment without agents', async () => {
    const w = await titled({});
    await w.say('one');
    await settle();
    expect(w.titleSessions()).toEqual([]);
  });

  it('never for a topic named explicitly (topic.switch with a title)', async () => {
    const w = await titled({ agents: { helper: { harness: 'cx' } } });
    await w.say('one');
    await until(() => w.topic().title === 'Title 1');
    const c = await w.client();
    const created = await c.topicSwitch({ conversation: CONV, new: { title: 'Plans' } });
    expect(w.gw.topics.titleSource(created.topic.id)).toBe('explicit');
    await w.say('two');
    await settle();
    expect(w.gw.topics.get(created.topic.id)).toMatchObject({ title: 'Plans' });
    expect(w.titleSessions()).toHaveLength(1);
  });

  it('a title that comes back after the topic was named is dropped (and the card keeps its title)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = await titled({ agents: { helper: { harness: 'cx' } } }, { gate: () => gate });
    await w.say('one');
    await until(() => w.titleSessions().length === 1);
    w.gw.topics.setTitle(w.topic().id, 'Mine');
    release();
    await until(() => w.answered() === 1);
    await settle();
    expect(w.topic().title).toBe('Mine');
    expect(w.gw.topics.titleSource(w.topic().id)).toBe('explicit');
    expect(w.cardTitles('one')).not.toContain('Title 1');
  });

  it('is the built-in module topic-title, on by default; topicTitles: { enabled: false } turns it off (no title sessions), its section has no other keys', async () => {
    const off = await titled({ agents: { helper: { harness: 'cx' } }, topicTitles: { enabled: false } });
    expect(off.gw.adminStatus().modules?.[0]).toEqual({ id: 'topic-title', origin: 'builtin', enabled: false });
    await off.say('one');
    await settle();
    expect(off.titleSessions()).toEqual([]);
    expect(off.topic().title).toBe('one');
    const on = await titled({ agents: { helper: { harness: 'cx' } }, topicTitles: {} });
    expect(on.gw.adminStatus().modules?.[0]).toEqual({ id: 'topic-title', origin: 'builtin', enabled: true });
    await on.say('one');
    await until(() => on.topic().title === 'Title 1');
    expect(() => resolveConfig({ topicTitles: { model: 'x' } }, { env: {}, baseDir: '/base', cwd: '/work' })).toThrow('invalid config: /topicTitles/model: Unexpected property');
  });

  it('one title job per topic at a time: a turn that would title while one runs does not start another', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = await titled({ agents: { helper: { harness: 'cx' } } }, { gate: () => gate });
    await w.say('one');
    await until(() => w.titleSessions().length === 1);
    // two, three, four: the 4th completed turn would title, but the first job still runs.
    for (const text of ['two', 'three', 'four']) await w.say(text);
    await settle();
    expect(w.titleSessions()).toHaveLength(1);
    release();
    await until(() => w.topic().title === 'Title 1');
    expect(w.titleSessions()).toHaveLength(1);
  });
});
