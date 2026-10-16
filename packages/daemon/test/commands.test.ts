import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AckState, ReplyRoute, SessionEvent } from '@agents-io/protocol';
import { Ingress, MemorySessionLog, defaultPolicy } from '@agents-io/session';
import { FakeChannel, FakeHarness, fakeEnvelope, type FakeTurnScript } from '@agents-io/testkit';
import { resolveConfig, type HarnessInstance } from '../src/config.js';
import { Gateway, InstanceHarness } from '../src/gateway.js';
import { cleanups, until } from './gateway-helpers.js';

/* `/commands` in a chat with the deployment: the owner operates the session and its harness. */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };

class MarkedChannel extends FakeChannel {
  readonly marks: string[] = [];
  async acknowledge(_route: ReplyRoute, messageId: string, state: AckState) {
    this.marks.push(`${messageId}:${state}`);
  }
}

async function setup(o: { fixed?: boolean; script?: FakeTurnScript; marked?: boolean; codex?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-cmd-'));
  const channelId = o.marked ? 'lark-bot' : 'fake';
  const base = resolveConfig(
    {
      ...(o.codex ? { harnesses: { codex: { use: 'codex' as const }, 'claude-code': { use: 'claude-code' as const } }, defaultHarness: 'codex' } : {}),
      agents: { helper: { harness: o.codex ? 'codex' : 'claude-code' }, coder: { harness: 'claude-code', model: 'sonnet' } },
      defaultAgent: 'helper',
      policy: { owners: [`${channelId}:alice`], ...(o.fixed ? { ownerSessionKey: 'main' } : {}), strangers: 'ask' },
      local: { principal: `${channelId}:alice` },
      ...(o.marked ? { channels: [{ type: 'lark-bot' as const, ack: true, config: { appId: 'test-app', appSecret: 'test-secret' } }] } : {}),
    },
    { env: {}, baseDir: dir, cwd: dir },
  );
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const chat = o.marked ? new MarkedChannel(channelId) : new FakeChannel(channelId);
  const harness = new FakeHarness(o.script);
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), ...(o.marked ? { channelAdapter: () => chat } : { channels: [{ adapter: chat }] }), logger: () => {} });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => gw.stop());
  let nextMessage = 0;
  const say = (text: string, sender = alice, where = dm) => {
    const id = `in${++nextMessage}`;
    return chat.inject({ ...where, sender, text, ...(o.marked ? { id, replyRoute: { channel: channelId, account: 'default', conversationId: where.conversation.id, replyToMessageId: id } } : {}) });
  };
  const replies = () => chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);
  return { gw, chat, harness, say, replies };
}

const turns = (gw: Gateway) =>
  gw.sessions().flatMap((s) => gw.hub.log.read(s.sessionKey, 0).filter((e: SessionEvent) => e.body.t === 'turn.started').map((e) => ({ key: s.sessionKey, run: (e.body as { run?: { model?: string } }).run })));

describe('commands', () => {
  it('/help and /status answer on the route; no turn runs #CT-2', async () => {
    const w = await setup();
    await w.say('/help');
    await until(() => w.replies().some((t) => t.includes('/status')));
    await w.say('/status');
    await until(() => w.replies().some((t) => t.startsWith('session ')));
    expect(w.replies().find((t) => t.startsWith('session '))).toContain('agent helper');
    expect(w.harness.sessions).toHaveLength(0);
  });

  it('/model sets the model of this session from the next turn; /model default undoes it #CT-2', async () => {
    const w = await setup();
    await w.say('hi');
    await until(() => turns(w.gw).length === 1);
    await w.say('/model opus');
    await until(() => w.replies().some((t) => t.includes('model opus from the next turn')));
    await w.say('again');
    await until(() => turns(w.gw).length === 2);
    expect(turns(w.gw)[1]!.run?.model).toBe('opus');
    await w.say('/model');
    await until(() => w.replies().some((t) => t.includes('model opus') && t.includes('(set here)')));
    await w.say('/model default');
    await w.say('third');
    await until(() => turns(w.gw).length === 3);
    expect(turns(w.gw)[2]!.run?.model).not.toBe('opus');
  });

  it('/plan and /bypass apply on later Codex turns and can be reset', async () => {
    const w = await setup({ codex: true });
    await w.say('/plan on');
    await w.say('/bypass off');
    await w.say('first');
    await until(() => turns(w.gw).length === 1);
    expect(turns(w.gw)[0]!.run).toMatchObject({ mode: 'plan', profile: 'restricted' });
    await w.say('/plan off');
    await w.say('/bypass on');
    await w.say('second');
    await until(() => turns(w.gw).length === 2);
    expect(turns(w.gw)[1]!.run).toMatchObject({ mode: 'default', profile: 'bypass' });
    await w.say('/bypass default');
    await w.say('third');
    await until(() => turns(w.gw).length === 3);
    expect(turns(w.gw)[2]!.run).toMatchObject({ profile: 'bypass' });
    await w.say('/plan maybe');
    await until(() => w.replies().some((t) => t === 'Usage: /plan [on|off]'));
  });

  it('rejects Plan and bypass commands on a non-Codex agent', async () => {
    const w = await setup();
    await w.say('/plan on');
    await w.say('/bypass off');
    await until(() => w.replies().length === 2);
    expect(w.replies().every((t) => t.includes('available only on Codex'))).toBe(true);
  });

  it('/preset switches the session to another harness, model and effort as its agent (cwd, instructions); /preset default goes back #CT-2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-cmd-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const work = join(dir, 'work');
    mkdirSync(work);
    writeFileSync(join(dir, 'helper.md'), 'Be brief.');
    const config = {
      ...resolveConfig(
        {
          harnesses: { cx: { use: 'codex' }, cc: { use: 'claude-code', run: { model: 'sonnet' } } },
          presets: { fast: { harness: 'cx', model: 'gpt-x', effort: 'low' }, claude: { harness: 'cc', model: 'opus', effort: 'high', description: 'Claude on the gateway' } },
          agents: { helper: { preset: 'fast', cwd: 'work', instructionsFile: 'helper.md' } },
          policy: { owners: ['fake:alice'] },
          local: { principal: 'fake:alice' },
        },
        { env: {}, baseDir: dir, cwd: dir },
      ),
      socketPath: join(dir, 'run', 'aio.sock'),
    };
    const fakes: Record<string, FakeHarness> = {};
    const chat = new FakeChannel('fake');
    const gw = await Gateway.start({ config, buildHarness: (i: HarnessInstance) => new InstanceHarness(i, (fakes[i.name] ??= new FakeHarness())), log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: () => {} });
    cleanups.push(() => gw.stop());
    const say = (text: string) => chat.inject({ ...dm, sender: alice, text });
    const replies = () => chat.sent.map((x) => x.edits.at(-1)?.text ?? x.msg.text);
    const reply = (prefix: string) => until(() => replies().find((t) => t.startsWith(prefix)));

    await say('hi');
    await until(() => turns(gw).length === 1);
    expect(turns(gw)[0]!.run).toMatchObject({ harness: 'cx', model: 'gpt-x', effort: 'low' });
    expect(fakes.cx!.sessions[0]!.args.cwd).toBe(work);

    await say('/preset');
    const list = await reply('This session: preset fast, cx (codex) · model gpt-x · effort low');
    expect(list).toContain('- fast: cx (codex) · model gpt-x · effort low');
    expect(list).toContain('- claude: cc (claude-code) · model opus · effort high — Claude on the gateway');

    // What /model set goes with the old preset.
    await say('/model gpt-y');
    await reply('model gpt-y from the next turn');
    await say('/preset claude');
    expect(await reply('Preset claude from the next turn')).toBe(
      'Preset claude from the next turn: cc (claude-code) · model opus · effort high. The harness changes (cx → cc); each keeps its own context, so cc has not seen what was said on cx. /new starts a clean topic.',
    );
    await say('again');
    await until(() => turns(gw).length === 2);
    expect(turns(gw)[1]!.run).toMatchObject({ harness: 'cc', model: 'opus', effort: 'high' });
    // The other instance runs as the same agent: its cwd and instructions.
    const opened = fakes.cc!.sessions[0]!.args;
    expect(opened.cwd).toBe(work);
    expect((opened.options as { sdk?: { systemPrompt?: { append?: string } } }).sdk?.systemPrompt?.append).toBe('Be brief.');

    await say('/status');
    expect(await reply('session ')).toContain('agent helper · preset claude · cc (claude-code) · model opus · effort high (set here)');
    await say('/plan on');
    await reply('/plan is available only on Codex (this session runs claude-code)');
    await say('/preset nope');
    await reply('No preset nope. Presets: fast, claude');

    await say('/preset default');
    expect(await reply('Back to the agent’s own')).toBe(
      'Back to the agent’s own from the next turn: cx (codex) · model gpt-x · effort low. The harness changes (cc → cx); each keeps its own context, so cx has not seen what was said on cc. /new starts a clean topic.',
    );
    await say('third');
    await until(() => turns(gw).length === 3);
    expect(turns(gw)[2]!.run).toMatchObject({ harness: 'cx', model: 'gpt-x', effort: 'low' });
  });

  it('/preset without presets configured says so #CT-2', async () => {
    const w = await setup();
    await w.say('/preset');
    await until(() => w.replies().some((t) => t.startsWith('No presets configured (config `presets`). This session runs claude-code (claude-code) · model haiku')));
    await w.say('/preset fast');
    await until(() => w.replies().includes('No presets configured (config `presets`).'));
  });

  it('/new @agent switches the chat to that agent in a new topic; /agent says which #CT-2 #TP-1', async () => {
    const w = await setup();
    await w.say('hi');
    await until(() => turns(w.gw).length === 1);
    await w.say('/new @coder fix the build');
    await until(() => w.replies().some((t) => t.startsWith('New topic with coder')));
    await w.say('please look');
    const second = await until(() => turns(w.gw).find((t) => t.key.startsWith('coder:')));
    expect(second.run?.model).toBe('sonnet');
    await w.say('/agent');
    await until(() => w.replies().some((t) => t.startsWith('This chat talks to coder')));
    await w.say('/agent nobody');
    await until(() => w.replies().some((t) => t.startsWith('No agent nobody')));
  });

  it('/stop stops the running turn #CT-2 #CT-1', async () => {
    const w = await setup({
      script: async (t) => {
        await new Promise<void>((resolve) => t.signal.addEventListener('abort', () => resolve()));
      },
    });
    await w.say('long job');
    await until(() => w.gw.sessions().some((s) => s.state === 'running'));
    await w.say('/stop');
    await until(() => w.replies().some((t) => t === 'Stopped.'));
    await until(() => w.gw.sessions().every((s) => s.state !== 'running'));
  });

  it('a channel without message marks still gets a /steer confirmation #CT-2', async () => {
    const w = await setup({
      script: async (t) => {
        await new Promise<void>((resolve) => t.signal.addEventListener('abort', () => resolve()));
      },
    });
    await w.say('long job');
    await until(() => w.gw.sessions().some((s) => s.state === 'running'));
    await w.say('/steer also check this');
    await until(() => w.replies().some((t) => t.includes('Nothing was running: it starts a turn.')));
  });

  it('a channel with message marks sends no separate /steer confirmation #CT-2', async () => {
    const w = await setup({
      marked: true,
      script: async (t) => {
        await new Promise<void>((resolve) => t.signal.addEventListener('abort', () => resolve()));
      },
    });
    await w.say('long job');
    await until(() => w.gw.sessions().some((s) => s.state === 'running'));
    await w.say('/steer also check this');
    expect(w.replies()).not.toContain('Added to the running turn.');
    expect(w.replies()).not.toContain('Nothing was running: it starts a turn.');
  });

  it('/answer returns a native question answer to the waiting turn', async () => {
    const w = await setup({
      script: async (t) => {
        t.emit({ t: 'request.opened', requestId: 'q1', kind: 'question', title: 'Which DB?', risk: {}, questions: [{ id: 'db', text: 'Which DB?' }], allowedDecisions: ['answer', 'deny'], allowAlways: false, defaultDeny: false });
        const d = await t.waitDecision('q1');
        t.emit({ t: 'text.snapshot', text: JSON.stringify(d), final: true }, { audience: 'answer' });
      },
    });
    await w.say('ask me');
    const question = await until(() => w.replies().find((text) => text.includes('/answer ask:')));
    const code = /\/answer (ask:[A-Za-z0-9_-]+)/.exec(question)?.[1];
    expect(code).toBeDefined();
    await w.say(`/answer ${code} SQLite`);
    await until(() => w.replies().includes('{"kind":"answer","answers":{"db":"SQLite"}}'));
    expect(turns(w.gw)).toHaveLength(1);
  });

  it('/stop with nothing running says so; it stops a turn still running in an earlier topic of the chat #CT-2 #CT-1', async () => {
    const w = await setup({
      script: async (t) => {
        await new Promise<void>((resolve) => t.signal.addEventListener('abort', () => resolve()));
      },
    });
    await w.say('/stop');
    await until(() => w.replies().includes('Nothing is running.'));
    await w.say('long job');
    await until(() => w.gw.sessions().some((s) => s.state === 'running'));
    await w.say('/new something else');
    await until(() => w.replies().some((t) => t.startsWith('New topic')));
    await w.say('/stop'); // e.g. the Stop of the first topic's thinking bubble
    await until(() => w.replies().some((t) => t === 'Stopped (in another topic of this chat).'));
    await until(() => w.gw.sessions().every((s) => s.state !== 'running'));
  });

  it('with a fixed owner session, topic and agent commands say why they do nothing #CT-2', async () => {
    const w = await setup({ fixed: true });
    await w.say('/new @coder x');
    await until(() => w.replies().some((t) => t.includes('one fixed session')));
  });

  it('only the owner operates: anyone else\'s /stop is an ordinary message #CT-2', async () => {
    const w = await setup();
    const group = { conversation: { id: 'g1', kind: 'group' as const } };
    await w.say('/stop', { channelUserId: 'eve', evidence: 'platform_signed' }, group);
    await new Promise((r) => setTimeout(r, 30));
    expect(w.replies()).toEqual([]);
  });

  it('without ownerSessionKey, strangers are asked about in the owner\'s latest DM #ID-9', async () => {
    const w = await setup();
    await w.say('hi');
    await until(() => w.chat.sent.some((s) => s.finalized));
    await w.chat.inject({ conversation: { id: 'c-eve', kind: 'dm' }, sender: { channelUserId: 'eve', evidence: 'platform_signed' }, text: 'hello?' });
    const card = await until(() => w.chat.sent.find((s) => s.msg.actions?.some((a) => a.id.startsWith('aio:stranger:'))));
    expect(card.route.conversationId).toBe('c-alice');
  });
});

describe('nativeCommand is the daemon\'s to set', () => {
  it('an adapter cannot pass a message to the harness as a raw command #ID-3', async () => {
    const seen: Record<string, unknown>[] = [];
    const ingress = new Ingress({
      policy: defaultPolicy({ owners: ['fake:u1'] }),
      lanes: () => ({ command: async (c: { input: { channelContext: Record<string, unknown> } }) => (seen.push(c.input.channelContext), { ok: true }), observe: async () => ({ ok: true }) }) as never,
    });
    await ingress.accept(fakeEnvelope({ admission: 'dispatch', text: '/compact', context: { nativeCommand: true, chatName: 'x' } }));
    expect(seen[0]).toMatchObject({ chatName: 'x' });
    expect(seen[0]!.nativeCommand).toBeUndefined();
  });
});
