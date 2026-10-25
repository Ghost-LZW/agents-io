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

// Moved from commands.test.ts: feature-path tests with no promise in docs/INVARIANTS.md (decision 14: local tier).

describe('codex-commands', () => {
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
});
