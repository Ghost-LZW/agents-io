import { chmodSync as chmod, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertConformingStream } from '@agents-io/testkit';
import { CodexHarness } from '../src/index.js';
import { pidAlive } from '../src/unix.js';
import { cleanupAfterEach, cleanups, cmdApproval, collector, fakeOnSocket, harnessFor, input, isCompleted, privDir, run, tick } from './unix-helpers.js';

// e2e tier (decision 14): real reconnect windows over a unix socket, and a real detached child process.
cleanupAfterEach();

describe('unix socket transport', () => {
  it('reconnects after a dropped connection: re-initializes, resumes the thread, keeps the turn and its pending approval #RS-2 #RQ-1', async () => {
    const { fake, sock, dir } = await fakeOnSocket();
    const h = harnessFor(sock, dir);
    const s = await h.open({ sessionKey: 's', generation: 1, cwd: '/w', run });
    const c = collector(s);
    let answer: unknown;
    let tid = '';
    fake.onTurnStart = async (p, t) => {
      tid = t;
      fake.echoUser(p.threadId, t, p.clientUserMessageId);
      answer = (await fake.request('item/commandExecution/requestApproval', cmdApproval(p.threadId, t))).result;
      fake.completeTurn(p.threadId, t, 'completed');
    };
    await s.startTurn('T1', [input('i1')]);
    await c.until((e) => e.body.t === 'request.opened');

    fake.dropClients();
    // While we are away Codex keeps going: this item's events are lost to us.
    fake.notify('item/started', { threadId: 'thr-1', turnId: tid, item: { type: 'webSearch', id: 'w-lost', query: 'q', action: null, results: null } });
    await fake.waitFor('thread/resume');
    await c.until((e) => e.body.t === 'notice' && (e.body as any).code === 'continuity');
    expect(fake.sent('initialize')).toHaveLength(2);
    expect(fake.sent('thread/resume')[0]!.params).toMatchObject({ threadId: 'thr-1', excludeTurns: true });

    await tick(20); // replayed request arrives after the resume response
    await s.respond('0', { kind: 'allow_once' });
    await c.until(isCompleted);
    expect(answer).toEqual({ decision: 'accept' });
    expect(c.of('request.opened')).toHaveLength(1); // the replay is not a new request
    expect(c.of('turn.completed')[0]).toMatchObject({ turnId: 'T1', status: 'completed' });
    assertConformingStream(c.events, { turnInputs: { T1: ['i1'] } });
  });

  it('closes requests that were answered elsewhere while disconnected #RQ-1', async () => {
    const { fake, sock, dir } = await fakeOnSocket();
    const s = await harnessFor(sock, dir).open({ sessionKey: 's', generation: 1, cwd: '/w', run });
    const c = collector(s);
    let pending: Promise<unknown> | undefined;
    fake.onTurnStart = (p, t) => {
      fake.echoUser(p.threadId, t, p.clientUserMessageId);
      pending = fake.request('item/commandExecution/requestApproval', cmdApproval(p.threadId, t));
    };
    await s.startTurn('T1', [input('i1')]);
    await c.until((e) => e.body.t === 'request.opened');
    fake.dropClients();
    // another client (say a TUI) answers before we are back: Codex will not replay it
    (fake as any).serverRequests.clear();
    void pending;
    await c.until((e) => e.body.t === 'request.resolved');
    expect(c.of('request.resolved')[0]).toMatchObject({ requestId: '0', decision: null, by: { kind: 'harness' } });
  }, 10_000);

  it('gives up after the reconnect window and fails the turn as ambiguous #RS-2 #IN-1', async () => {
    const { fake, sock, dir } = await fakeOnSocket();
    const h = new CodexHarness({ transport: { kind: 'unix', spawn: 'none', path: sock, stateDir: dir, reconnectWindowMs: 300 } });
    cleanups.push(() => h.dispose());
    const s = await h.open({ sessionKey: 's', generation: 1, cwd: '/w', run });
    const c = collector(s);
    fake.onTurnStart = (p, t) => fake.echoUser(p.threadId, t, p.clientUserMessageId);
    await s.startTurn('T1', [input('i1')]);
    await tick();
    await fake.stopListening();
    await c.done;
    expect(c.of('turn.completed')[0]).toMatchObject({ status: 'ambiguous', error: { code: 'harness_exited' } });
    assertConformingStream(c.events);
  });
});

describe("spawn: 'own'", () => {
  const bin = join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');

  it('spawns a detached server, records it, and a second host reattaches instead of spawning #RS-2 #SE-2', async () => {
    chmod(bin, 0o755);
    const stateDir = join(privDir(), 'state');
    const opts = { bin, env: { ...process.env, FAKE_CODEX_TURN_MS: '1500' }, transport: { kind: 'unix' as const, spawn: 'own' as const, stateDir } };
    const a = new CodexHarness(opts);
    cleanups.push(() => a.shutdownOwnServer());
    const s1 = await a.open({ sessionKey: 's', generation: 1, cwd: '/w', run });
    const c1 = collector(s1);
    await s1.startTurn('T1', [input('i1')]);
    await c1.until((e) => e.body.t === 'input.consumed');

    const state = JSON.parse(readFileSync(join(stateDir, 'server.json'), 'utf8'));
    expect(pidAlive(state.pid)).toBe(true);
    expect(state.socket).toBe(join(stateDir, 'app-server.sock'));
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, 'server.json')).mode & 0o777).toBe(0o600);
    expect(statSync(state.socket).mode & 0o777).toBe(0o600);

    await a.detach(); // "host exits"
    const b = new CodexHarness(opts);
    cleanups.push(() => b.dispose());
    const s2 = await b.open({ sessionKey: 's', generation: 2, cwd: '/w', run, resume: 'thr-own' });
    const c2 = collector(s2);
    await c2.until(isCompleted);
    expect(JSON.parse(readFileSync(join(stateDir, 'server.json'), 'utf8')).pid).toBe(state.pid); // same server
    expect(c2.of('turn.completed')[0]).toMatchObject({ turnId: 'T1', status: 'completed' });

    expect(await b.shutdownOwnServer()).toBe(true);
    for (let i = 0; i < 50 && pidAlive(state.pid); i++) await tick(20);
    expect(pidAlive(state.pid)).toBe(false);
  }, 20_000);
});
