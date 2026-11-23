import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessAdapter, SessionEvent } from '@agents-io/protocol';
import { CodexHarness } from '@agents-io/harness-codex';
import { FakeChannel } from '@agents-io/testkit';
import { FakeAppServer } from '../../../harness/codex/test/fake-app-server.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { cleanups, tmp, until } from './helpers.js';

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const of = (evs: SessionEvent[], t: string) => evs.map((e) => e.body).filter((b) => b.t === t);

/** A private directory with a short path: a Unix socket's path is at most ~104 bytes on macOS. */
function privDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'aio-r-'));
  chmodSync(d, 0o700);
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A daemon on `dir`'s log whose one harness instance `cx` is `entry`; `harness` replaces every instance's adapter. */
async function start(dir: string, entry: Record<string, unknown>, harness?: HarnessAdapter) {
  const raw = { dataDir: dir, policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, cwd: dir, harnesses: { cx: entry }, defaultHarness: 'cx' };
  const config = { ...resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir }), socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  const gw = await Gateway.start({ config, ...(harness ? { harness } : {}), channels: [{ adapter: chat }], logger: () => {} });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await gw.stop();
  };
  cleanups.push(stop);
  return { gw, chat, stop };
}

describe('a daemon restart with a turn running (INVARIANTS RS-2, RS-4, RS-5)', () => {
  it('Codex over a Unix socket mid-turn at stop: the lane and the instance detach (no interrupt, no unsubscribe, the connection closes); the next start reopens the session with no new input and Codex adopts the turn, which completes once #RS-2', async () => {
    const dir = tmp();
    const sd = privDir();
    const sock = join(sd, 's.sock');
    const fake = new FakeAppServer();
    await fake.listen(sock);
    chmodSync(sock, 0o600);
    cleanups.push(() => fake.stopListening());
    let codexTurn = '';
    fake.onTurnStart = (p, t) => {
      codexTurn = t;
      fake.echoUser(p.threadId, t, p.clientUserMessageId);
    };
    // Built from the config, like a deployment's adapter: the app-server outlives the daemon.
    const cx = { use: 'codex', transport: { kind: 'unix', spawn: 'none', path: sock, stateDir: sd } };
    const a = await start(dir, cx);
    await a.chat.inject({ sender: alice, text: 'long job' });
    const key = await until(() => a.gw.hub.log.sessions().find((k) => a.gw.hub.snapshot(k).turn));
    const turnId = a.gw.hub.snapshot(key).turn!.turnId;
    await until(() => codexTurn && of(a.gw.hub.log.read(key, 0), 'input.consumed').length === 1);
    const closed = fake.closedByClient;
    await a.stop();
    // Codex keeps running the turn; the instance's own detach closed its connection.
    expect(fake.sent('turn/interrupt')).toEqual([]);
    expect(fake.sent('thread/unsubscribe')).toEqual([]);
    await until(() => fake.closedByClient === closed + 1);
    expect(fake.activeTurn.get('thr-1')).toBe(codexTurn);
    expect(existsSync(join(sd, 'turns', 'thr-1.json'))).toBe(true);

    const b = await start(dir, cx);
    // No new input: the start reopens the session so that Codex adopts the turn.
    await until(() => of(b.gw.hub.log.read(key, 0), 'turn.adopted').length === 1);
    expect(fake.sent('thread/resume').map((m) => (m.params as { threadId: string }).threadId)).toEqual(['thr-1']);
    expect(of(b.gw.hub.log.read(key, 0), 'turn.adopted')[0]).toMatchObject({ turnId });
    expect(of(b.gw.hub.log.read(key, 0), 'turn.completed')).toEqual([]);
    expect(b.gw.hub.snapshot(key).turn?.turnId).toBe(turnId);
    fake.completeTurn('thr-1', codexTurn, 'completed');
    await until(() => !b.gw.hub.snapshot(key).turn);
    expect(of(b.gw.hub.log.read(key, 0), 'turn.completed')).toEqual([expect.objectContaining({ turnId, status: 'completed' })]);
  });

  it('an injected adapter is detached at stop like a built one: Codex over stdio leaves its turn open, and the next start settles it ambiguous (host_restarted) without opening the harness #RS-4 #RS-5', async () => {
    const dir = tmp();
    const stdio = { use: 'codex', transport: { kind: 'stdio' } };
    // Over stdio the app-server is the daemon's child: a new FakeAppServer per start is a new process.
    const fake1 = new FakeAppServer();
    fake1.onTurnStart = (p, t) => fake1.echoUser(p.threadId, t, p.clientUserMessageId);
    const a = await start(dir, stdio, new CodexHarness({ transport: fake1.transport }));
    await a.chat.inject({ sender: alice, text: 'long job' });
    const key = await until(() => a.gw.hub.log.sessions().find((k) => a.gw.hub.snapshot(k).turn));
    await until(() => fake1.activeTurn.size === 1);
    const closed = fake1.closedByClient;
    await a.stop();
    expect(fake1.sent('turn/interrupt')).toEqual([]);
    expect(fake1.sent('thread/unsubscribe')).toEqual([]);
    expect(fake1.closedByClient).toBe(closed + 1);

    const fake2 = new FakeAppServer();
    const b = await start(dir, stdio, new CodexHarness({ transport: fake2.transport }));
    await until(() => !b.gw.hub.snapshot(key).turn);
    expect(of(b.gw.hub.log.read(key, 0), 'turn.completed')).toEqual([expect.objectContaining({ status: 'ambiguous', error: expect.objectContaining({ code: 'host_restarted' }) })]);
    // Settled through the lane without opening a harness session: nothing started an app-server.
    expect(fake2.spawned).toBe(0);
  });
});
