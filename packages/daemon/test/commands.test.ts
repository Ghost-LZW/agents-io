import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { Ingress, MemorySessionLog, defaultPolicy } from '@agents-io/session';
import { FakeChannel, FakeHarness, fakeEnvelope, type FakeTurnScript } from '@agents-io/testkit';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { cleanups, until } from './gateway-helpers.js';

/* `/commands` in a chat with the deployment: the owner operates the session and its harness. */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };

async function setup(o: { fixed?: boolean; script?: FakeTurnScript } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-cmd-'));
  const base = resolveConfig(
    {
      agents: { helper: { harness: 'claude-code' }, coder: { harness: 'claude-code', model: 'sonnet' } },
      defaultAgent: 'helper',
      policy: { owners: ['fake:alice'], ...(o.fixed ? { ownerSessionKey: 'main' } : {}), strangers: 'ask' },
      local: { principal: 'fake:alice' },
    },
    { env: {}, baseDir: dir, cwd: dir },
  );
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  const harness = new FakeHarness(o.script);
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: () => {} });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => gw.stop());
  const say = (text: string, sender = alice, where = dm) => chat.inject({ ...where, sender, text });
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

  it('a successful /steer sends no separate confirmation reply #CT-2', async () => {
    const w = await setup({
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
