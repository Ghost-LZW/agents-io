import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { SqliteSessionLog, rejectionNotice } from '@agents-io/session';
import { CodexHarness } from '@agents-io/harness-codex';
import { FakeChannel, fakeEnvelope } from '@agents-io/testkit';
import { FakeAppServer } from '../../../harness/codex/test/fake-app-server.js';
import { resolveConfig } from '../src/config.js';
import { Gateway, InstanceHarness } from '../src/gateway.js';
import { cleanups, daemon, tmp, until } from './helpers.js';

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const of = (evs: SessionEvent[], t: string) => evs.map((e) => e.body).filter((b) => b.t === t);

/** The session log a stopped daemon left in `dir`. */
const readLog = (dir: string) => new SqliteSessionLog({ path: join(dir, 'log.sqlite') });

describe('inputs left when the daemon stops or crashes (INVARIANTS IN-1, RS-6)', () => {
  it('stop with queued inputs: they are rejected (lane_closed) and the sender is told on the chat; after a restart nothing stays queued #IN-1 #RS-6', async () => {
    const dir = tmp();
    // The turn runs until the daemon stops it.
    const w = await daemon({ dir, script: (t) => new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    await w.chat.inject({ sender: alice, text: 'long job' });
    await until(() => w.chat.sent.length === 1);
    await w.chat.inject({ sender: alice, text: 'then this' });
    const key = await until(() => w.gw.hub.log.sessions().find((k) => w.gw.hub.snapshot(k).queued.length === 1));
    await w.stop();

    const notice = w.chat.sent.find((s) => s.msg.text === rejectionNotice('lane_closed: gateway stopping'));
    expect(notice?.route).toMatchObject({ channel: 'fake', conversationId: 'c1' });
    const log = readLog(dir);
    expect(of(log.read(key, 0), 'input.rejected')[0]).toMatchObject({ reason: 'lane_closed: gateway stopping', replyRoute: { conversationId: 'c1' } });
    expect(log.snapshot(key).queued).toEqual([]);
    log.close();

    const w2 = await daemon({ dir });
    expect(w2.gw.hub.snapshot(key).queued).toEqual([]);
    expect(of(w2.gw.hub.log.read(key, 0), 'input.rejected').filter((b) => (b as { reason: string }).reason === 'host_restarted')).toEqual([]);
  });

  it('the stop notice reaches a channel that cannot send once aborted (a bridge closes its peer on abort) #IN-1 #RS-6', async () => {
    const w = await daemon({ script: (t) => new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    // Like a bridge: once the channel's start() is aborted, sending fails.
    const send = w.chat.send.bind(w.chat);
    let aborted = false;
    w.chat.send = async (...a) => {
      if (aborted) throw Object.assign(new Error('peer closed'), { code: 'unavailable' });
      return send(...a);
    };
    await w.chat.inject({ sender: alice, text: 'long job' });
    await until(() => w.chat.sent.length === 1);
    await w.chat.inject({ sender: alice, text: 'then this' });
    await until(() => w.gw.hub.log.sessions().some((k) => w.gw.hub.snapshot(k).queued.length === 1));
    const ctrl = (w.gw as unknown as { channels: { adapter: unknown; ac: AbortController }[] }).channels.find((c) => c.adapter === w.chat)!.ac;
    ctrl.signal.addEventListener('abort', () => (aborted = true));
    await w.stop();
    expect(w.chat.sent.some((s) => s.msg.text === rejectionNotice('lane_closed: gateway stopping'))).toBe(true);
  });

  it('a channel message arriving while the daemon stops is answered accepted:false, not permanent, so the channel does not confirm it #IN-7', async () => {
    const w = await daemon({ script: (t) => new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    await w.chat.inject({ sender: alice, text: 'long job' });
    await until(() => w.chat.sent.length === 1);
    // The channel's emit as the gateway gave it (the fake forgets it once closed).
    const ctx = (w.chat as unknown as { ctx: { emit: (e: unknown) => Promise<unknown> } }).ctx;
    const stopping = w.stop();
    await until(() => (w.gw as unknown as { refusingInbound: boolean }).refusingInbound);
    expect(await ctx.emit(fakeEnvelope({ channel: 'fake', id: 'late', sender: alice, text: 'late' }))).toEqual({ accepted: false, error: 'gateway stopping' });
    await stopping;
  });

  it('crash leftovers: inputs admitted but never settled by the previous process are rejected (host_restarted) at startup, and the snapshot lists none queued #IN-1 #RS-6', async () => {
    const dir = tmp();
    // What a crashed process leaves: admissions with no turn, no consumed / rejected record.
    const log = readLog(dir);
    const ev = { ts: 1, level: 'primary' as const, audience: 'status' as const, durability: 'durable' as const };
    log.append('fake:default:c9', { ...ev, body: { t: 'input.admitted', inputId: 'lost1', disposition: 'new_turn' } });
    log.append('fake:default:c9', { ...ev, body: { t: 'input.admitted', inputId: 'lost2', disposition: 'queued' } });
    log.close();

    const w = await daemon({ dir });
    expect(w.gw.hub.snapshot('fake:default:c9').queued).toEqual([]);
    expect(of(w.gw.hub.log.read('fake:default:c9', 0), 'input.rejected')).toEqual([{ t: 'input.rejected', inputIds: ['lost1', 'lost2'], reason: 'host_restarted' }]);
    const c = await w.client();
    expect((await c.sessions()).find((s) => s.sessionKey === 'fake:default:c9')).toMatchObject({ queued: 0 });
    // The route of a crashed process's input is not in the log: nothing is sent.
    expect(w.chat.sent).toEqual([]);
  });

  it('Claude Code mid-turn at stop: the turn is interrupted, the queued input rejected (lane_closed); after a restart the next input resumes the same native session #RS-3 #IN-1 #RS-6', async () => {
    const dir = tmp();
    // Kind claude-code (not Codex): the gateway closes the lane at stop instead of detaching it.
    const raw = { harnesses: { claude: { use: 'claude-code' } }, defaultHarness: 'claude' };
    const w = await daemon({
      dir,
      raw,
      script: (t) => {
        t.emit({ t: 'session.bound', nativeId: 'native-1' });
        return new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    });
    await w.chat.inject({ sender: alice, text: 'long job' });
    await until(() => w.chat.sent.length === 1);
    await w.chat.inject({ sender: alice, text: 'then this' });
    const key = await until(() => w.gw.hub.log.sessions().find((k) => w.gw.hub.snapshot(k).queued.length === 1));
    const queued = w.gw.hub.snapshot(key).queued[0];
    // Like the real adapter (harness/claude-code session.ts close): interrupt the running turn and wait for it to end, then end the stream.
    const s = w.harness.sessions[0]!;
    const close = s.close.bind(s);
    s.close = async () => {
      await s.interrupt(w.gw.hub.snapshot(key).turn!.turnId);
      await until(() => (s as unknown as { active?: unknown }).active === undefined);
      return close();
    };
    await w.stop();

    const log = readLog(dir);
    expect(of(log.read(key, 0), 'turn.completed')).toEqual([expect.objectContaining({ status: 'interrupted' })]);
    expect(of(log.read(key, 0), 'input.rejected')).toEqual([expect.objectContaining({ inputIds: [queued], reason: 'lane_closed: gateway stopping' })]);
    expect(log.snapshot(key).turn).toBeFalsy();
    log.close();

    const w2 = await daemon({ dir, raw });
    await w2.chat.inject({ sender: alice, text: 'again' });
    await until(() => w2.harness.sessions.length === 1);
    expect(w2.harness.sessions[0]!.args.resume).toBe('native-1');
  });

  // INVARIANTS RS-4 不成立 1: a Codex stdio lane is detached at stop like a unix one, and nothing settles its turn at start without new input; turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('Codex over stdio mid-turn at stop: after the next start, with no new input, the turn is settled (ambiguous host_restarted) and the snapshot no longer shows it running #RS-4 #RS-5', async () => {
    const dir = tmp();
    const raw = {
      dataDir: dir,
      policy: { owners: ['fake:alice'] },
      local: { principal: 'me' },
      cwd: dir,
      harnesses: { cx: { use: 'codex', transport: { kind: 'stdio' } } },
      defaultHarness: 'cx',
    };
    const config = { ...resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir }), socketPath: join(dir, 'run', 'aio.sock') };
    const start = async (fake: FakeAppServer) => {
      const chat = new FakeChannel('fake');
      const gw = await Gateway.start({
        config,
        // Over stdio the app-server is the daemon's child: a new FakeAppServer per start is a new process.
        buildHarness: (i) => new InstanceHarness(i, new CodexHarness({ transport: fake.transport })),
        channels: [{ adapter: chat }],
        logger: () => {},
      });
      let stopped = false;
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        await gw.stop();
      };
      cleanups.push(stop);
      return { gw, chat, stop };
    };
    const fake1 = new FakeAppServer();
    const a = await start(fake1);
    await a.chat.inject({ sender: alice, text: 'long job' });
    const key = await until(() => a.gw.hub.log.sessions().find((k) => a.gw.hub.snapshot(k).turn));
    await until(() => fake1.activeTurn.size === 1);
    await a.stop();

    const b = await start(new FakeAppServer());
    await new Promise((r) => setTimeout(r, 200));
    expect(b.gw.hub.snapshot(key).turn).toBeFalsy();
    expect(of(b.gw.hub.log.read(key, 0), 'turn.completed')).toEqual([expect.objectContaining({ status: 'ambiguous' })]);
  });
});
