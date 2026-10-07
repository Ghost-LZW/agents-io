import { chmodSync, chmodSync as chmod, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessEvent, HarnessSession, InputRecord } from '@agents-io/protocol';
import { assertConformingStream } from '@agents-io/testkit';
import { CodexHarness, type CodexHarnessOptions } from '../src/index.js';
import { pidAlive } from '../src/unix.js';
import { FakeAppServer } from './fake-app-server.js';

const input = (id: string, text = 'x'): InputRecord => ({
  inputId: id,
  origin: { kind: 'human', principal: { id: 'owner', labels: [] }, evidence: 'platform_signed', via: 'lark:a:c1', adapter: 'lark' },
  content: [{ type: 'text', text }],
  replyRoute: null,
  channelContext: {},
});
const run = { harness: 'codex', model: 'gpt-5.5', profile: 'bypass' };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Short private dir: sun_path is ~104 bytes on macOS. */
function privDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'aio-'));
  chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}

async function fakeOnSocket() {
  const dir = privDir();
  const sock = join(dir, 's.sock');
  const fake = new FakeAppServer();
  await fake.listen(sock);
  chmod(sock, 0o600);
  cleanups.push(() => fake.stopListening());
  return { fake, dir, sock };
}

function harnessFor(sock: string, stateDir: string, extra: Partial<CodexHarnessOptions> = {}) {
  const h = new CodexHarness({ transport: { kind: 'unix', spawn: 'none', path: sock, stateDir, reconnectWindowMs: 5000 }, ...extra });
  cleanups.push(() => h.dispose());
  return h;
}

function collector(s: HarnessSession) {
  const events: HarnessEvent[] = [];
  const waiters: { pred: (e: HarnessEvent) => boolean; resolve: () => void }[] = [];
  const done = (async () => {
    for await (const e of s.events) {
      events.push(e);
      for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve());
    }
  })();
  return {
    events,
    done,
    until: (pred: (e: HarnessEvent) => boolean) =>
      events.some(pred) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ pred, resolve })),
    of: <T extends HarnessEvent['body']['t']>(t: T) => events.filter((e) => e.body.t === t).map((e) => e.body as Extract<HarnessEvent['body'], { t: T }>),
  };
}
const isCompleted = (e: HarnessEvent) => e.body.t === 'turn.completed';
const cmdApproval = (th: string, tid: string) => ({
  kind: 'command', threadId: th, turnId: tid, itemId: 'c1', startedAtMs: 1, environmentId: 'local', command: 'rm -rf build', cwd: '/w', commandActions: [],
});

describe('unix socket transport', () => {
  it('speaks JSON-RPC as WebSocket frames over the socket and refuses sockets others can reach', async () => {
    const { fake, sock, dir } = await fakeOnSocket();
    chmod(sock, 0o666);
    await expect(harnessFor(sock, dir).probe()).rejects.toThrow(/accessible to other users/);
    chmod(sock, 0o600);
    chmod(dir, 0o755);
    await expect(harnessFor(sock, dir).probe()).rejects.toThrow(/socket directory .* accessible/);
    chmod(dir, 0o700);
    expect((await harnessFor(sock, dir).probe()).version).toBe('0.160.1');
    expect(fake.sent('initialize')).toHaveLength(1);
    expect(await harnessFor(sock, dir, {}).probe().then(() => 'ok')).toBe('ok');
    const loose = new CodexHarness({ transport: { kind: 'unix', spawn: 'none', path: sock, stateDir: dir, allowInsecureSocket: true } });
    cleanups.push(() => loose.dispose());
    chmod(sock, 0o666);
    expect((await loose.probe()).version).toBe('0.160.1');
  });

  it('reconnects after a dropped connection: re-initializes, resumes the thread, keeps the turn and its pending approval', async () => {
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

  it('closes requests that were answered elsewhere while disconnected', async () => {
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

  it('a restarted host adopts a running turn and its replayed approval', async () => {
    const { fake, sock, dir } = await fakeOnSocket();
    const a = harnessFor(sock, dir);
    const s1 = await a.open({ sessionKey: 's', generation: 1, cwd: '/w', run });
    const c1 = collector(s1);
    let answer: unknown;
    fake.onTurnStart = async (p, t) => {
      fake.echoUser(p.threadId, t, p.clientUserMessageId);
      answer = (await fake.request('item/commandExecution/requestApproval', cmdApproval(p.threadId, t))).result;
      fake.completeTurn(p.threadId, t, 'completed');
    };
    await s1.startTurn('T1', [input('i1')]);
    await c1.until((e) => e.body.t === 'request.opened');
    await a.detach(); // host shuts down without touching Codex
    await c1.done;
    expect(fake.sent('turn/interrupt')).toHaveLength(0);
    expect(fake.sent('thread/unsubscribe')).toHaveLength(0);
    expect(existsSync(join(dir, 'turns', 'thr-1.json'))).toBe(true);
    expect(statSync(join(dir, 'turns', 'thr-1.json')).mode & 0o777).toBe(0o600);

    const b = harnessFor(sock, dir);
    const s2 = await b.open({ sessionKey: 's', generation: 2, cwd: '/w', run, resume: 'thr-1' });
    const c2 = collector(s2);
    await c2.until((e) => e.body.t === 'request.opened');
    const opened = c2.of('request.opened')[0]!;
    expect(c2.events.find((e) => e.body.t === 'request.opened')?.turnId).toBe('T1');
    await s2.respond(opened.requestId, { kind: 'allow_once' });
    await c2.until(isCompleted);
    expect(answer).toEqual({ decision: 'accept' });
    expect(c2.of('turn.completed')[0]).toMatchObject({ turnId: 'T1', status: 'completed' });
    expect(c2.of('turn.started')).toHaveLength(0);
    expect(existsSync(join(dir, 'turns', 'thr-1.json'))).toBe(false);
    // The new host's stream opens the turn with turn.adopted and conforms on its own.
    expect(c2.of('turn.adopted')[0]).toMatchObject({ turnId: 'T1', inputIds: ['i1'] });
    assertConformingStream(c2.events, { turnInputs: { T1: ['i1'] } });
  });

  it('settles an adopted turn that finished while no host was attached', async () => {
    const { fake, sock, dir } = await fakeOnSocket();
    const a = harnessFor(sock, dir);
    const s1 = await a.open({ sessionKey: 's', generation: 1, cwd: '/w', run });
    collector(s1);
    let tid = '';
    fake.onTurnStart = (p, t) => {
      tid = t;
      fake.echoUser(p.threadId, t, p.clientUserMessageId);
    };
    await s1.startTurn('T1', [input('i1')]);
    await tick();
    await a.detach();
    fake.completeTurn('thr-1', tid, 'completed');

    const s2 = await harnessFor(sock, dir).open({ sessionKey: 's', generation: 2, cwd: '/w', run, resume: 'thr-1' });
    const c2 = collector(s2);
    await c2.until(isCompleted);
    expect(fake.sent('thread/turns/list')).toHaveLength(1);
    expect(c2.of('turn.completed')[0]).toMatchObject({ turnId: 'T1', status: 'completed' });
  });

  it('gives up after the reconnect window and fails the turn as ambiguous', async () => {
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

  it('spawns a detached server, records it, and a second host reattaches instead of spawning', async () => {
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
