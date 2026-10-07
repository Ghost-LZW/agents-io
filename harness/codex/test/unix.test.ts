import { chmodSync, chmodSync as chmod, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessEvent, HarnessSession, InputRecord } from '@agents-io/protocol';
import { assertConformingStream } from '@agents-io/testkit';
import { CodexHarness, launchFlags, tomlValue, type CodexHarnessOptions } from '../src/index.js';
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

  it('settles an adopted turn that finished while another client started a turn on the thread', async () => {
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
    fake.activeTurn.set('thr-1', 'tui-2'); // e.g. a TUI starts its own turn: the thread is active again
    fake.turns.get('thr-1')!.push({ id: 'tui-2', items: [], status: 'inProgress', error: null });

    const s2 = await harnessFor(sock, dir).open({ sessionKey: 's', generation: 2, cwd: '/w', run, resume: 'thr-1' });
    const c2 = collector(s2);
    await c2.until(isCompleted);
    expect(c2.of('turn.completed')[0]).toMatchObject({ turnId: 'T1', status: 'completed' });
    // The other client's turn maps as a foreign turn once its events arrive.
    const msg = { type: 'agentMessage', id: 'm', text: 'ok', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null };
    fake.notify('item/started', { threadId: 'thr-1', turnId: 'tui-2', item: msg });
    fake.notify('item/completed', { threadId: 'thr-1', turnId: 'tui-2', item: msg });
    fake.completeTurn('thr-1', 'tui-2', 'completed');
    await c2.until((e) => isCompleted(e) && e.turnId === 'codex:tui-2');
  });

  it('keeps the adopted turn when Codex still runs it', async () => {
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
    fake.turns.set('thr-1', [{ id: tid, items: [], status: 'inProgress', error: null }]);

    const s2 = await harnessFor(sock, dir).open({ sessionKey: 's', generation: 2, cwd: '/w', run, resume: 'thr-1' });
    const c2 = collector(s2);
    await tick(20);
    expect(c2.of('turn.completed')).toHaveLength(0);
    fake.completeTurn('thr-1', tid, 'completed');
    await c2.until(isCompleted);
    expect(c2.of('turn.completed')[0]).toMatchObject({ turnId: 'T1', status: 'completed' });
  });

  it('an approval answered while reconnecting is delivered when Codex replays it, and only then reported resolved', async () => {
    const { fake, sock, dir } = await fakeOnSocket();
    const s = await harnessFor(sock, dir).open({ sessionKey: 's', generation: 1, cwd: '/w', run });
    const c = collector(s);
    let answer: unknown;
    fake.onTurnStart = async (p, t) => {
      fake.echoUser(p.threadId, t, p.clientUserMessageId);
      answer = (await fake.request('item/commandExecution/requestApproval', cmdApproval(p.threadId, t))).result;
      fake.completeTurn(p.threadId, t, 'completed');
    };
    await s.startTurn('T1', [input('i1')]);
    await c.until((e) => e.body.t === 'request.opened');

    // Hold the reconnect's handshake so the answer lands while the old connection is closed.
    const init = fake.handlers['initialize']!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.handlers['initialize'] = async (p, f) => (await gate, init(p, f));
    const first = fake.sent('initialize')[0];
    fake.dropClients();
    await fake.waitFor('initialize', (m) => m !== first);
    await s.respond('0', { kind: 'deny' });
    expect(c.of('request.resolved')).toHaveLength(0); // not delivered yet
    await expect(s.respond('0', { kind: 'allow_once' })).rejects.toThrow(/already resolved/);

    release();
    await c.until(isCompleted);
    expect(answer).toEqual({ decision: 'decline' });
    expect(c.of('request.opened')).toHaveLength(1); // the replay is the same request
    expect(c.of('request.resolved')).toEqual([{ t: 'request.resolved', requestId: '0', decision: { kind: 'deny' }, by: { kind: 'host' } }]);
    assertConformingStream(c.events, { turnInputs: { T1: ['i1'] } });
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

describe('launch settings (named instances)', () => {
  const bin = join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');

  it('-c values are inline TOML; keys and feature names are checked', () => {
    expect(launchFlags({ config: { model: 'gpt-x', model_reasoning_effort: 'low', 'shell_environment_policy.inherit': 'all', n: 3, ok: true, list: ['a', 'b"c'], 'mcp_servers.docs': { url: 'http://d', 'odd key': 1 } }, enable: ['web_search'], disable: ['undo'] })).toEqual([
      '-c', 'model="gpt-x"',
      '-c', 'model_reasoning_effort="low"',
      '-c', 'shell_environment_policy.inherit="all"',
      '-c', 'n=3',
      '-c', 'ok=true',
      '-c', 'list=["a", "b\\"c"]',
      '-c', 'mcp_servers.docs={ url = "http://d", "odd key" = 1 }',
      '--enable', 'web_search',
      '--disable', 'undo',
    ]);
    expect(launchFlags({ config: { 'mcp_servers."my server".url': 'u' } })).toEqual(['-c', 'mcp_servers."my server".url="u"']);
    expect(() => launchFlags({ config: { 'a b': 1 } })).toThrow(/not a dotted TOML key/);
    expect(() => launchFlags({ config: { 'x=y': 1 } })).toThrow(/not a dotted TOML key/);
    expect(() => launchFlags({ enable: ['--evil'] })).toThrow(/feature name/);
    expect(() => tomlValue(null, 'config.k')).toThrow('config.k: null cannot be written as TOML');
  });

  it('refuses secrets in -c values (argv is readable by other local users); env-var indirection is fine', () => {
    for (const config of [
      { 'model_providers.x.experimental_bearer_token': 'sk-1' },
      { 'mcp_servers.gh.env': { GITHUB_TOKEN: 'ghp-1' } },
      { 'mcp_servers.docs': { url: 'http://d', http_headers: { Authorization: 'Bearer t' } } },
      { mcp_servers: { docs: { http_headers: { 'X-Api-Key': 'k' } } } },
      { 'mcp_servers."my server".env.OPENAI_API_KEY': 'k' },
    ]) {
      expect(() => launchFlags({ config }), JSON.stringify(config)).toThrow(/command line.*env/);
    }
    expect(
      launchFlags({
        config: {
          'model_providers.x.env_key': 'MY_KEY',
          'mcp_servers.docs': { url: 'http://d', bearer_token_env_var: 'DOCS_TOKEN', env_http_headers: { Authorization: 'DOCS_AUTH' }, env_vars: ['GITHUB_TOKEN'] },
          model_auto_compact_token_limit: 1000,
        },
      }),
    ).toHaveLength(6);
  });

  it('stdio: launch flags follow app-server; env is merged over process.env and CODEX_HOME set', async () => {
    const dir = privDir();
    const out = join(dir, 'seen.json');
    const fake = join(dir, 'codex');
    writeFileSync(fake, `#!/bin/sh\nprintf '%s|%s|%s|%s' "$*" "$CODEX_HOME" "$AIO_T_INHERITED" "$AIO_T_REMOVED" > "${out}"\nexit 3\n`, { mode: 0o755 });
    process.env.AIO_T_INHERITED = 'yes';
    process.env.AIO_T_REMOVED = 'should-go';
    try {
      const h = new CodexHarness({ bin: fake, codexHome: join(dir, 'home'), env: { AIO_T_REMOVED: undefined, CODEX_HOME: '/loses' }, config: { model: 'm' }, disable: ['undo'], handshakeTimeoutMs: 2000 });
      await expect(h.probe()).rejects.toThrow();
      expect(readFileSync(out, 'utf8')).toBe(`app-server -c model="m" --disable undo|${join(dir, 'home')}|yes|`);
    } finally {
      delete process.env.AIO_T_INHERITED;
      delete process.env.AIO_T_REMOVED;
    }
  });

  it('own: the detached server gets the flags and CODEX_HOME; other settings on the same stateDir are refused', async () => {
    chmod(bin, 0o755);
    const dir = privDir();
    const stateDir = join(dir, 'state');
    const seen = join(dir, 'argv.json');
    const opts: CodexHarnessOptions = { bin, codexHome: join(dir, 'home'), env: { FAKE_CODEX_ARGV: seen, FAKE_SECRET: 's3' }, config: { model: 'gpt-x' }, enable: ['f1'], transport: { kind: 'unix', spawn: 'own', stateDir } };
    const a = new CodexHarness(opts);
    cleanups.push(() => a.shutdownOwnServer());
    await a.probe();
    const got = JSON.parse(readFileSync(seen, 'utf8'));
    expect(got.argv).toEqual(['app-server', '--listen', `unix://${join(stateDir, 'app-server.sock')}`, '-c', 'model="gpt-x"', '--enable', 'f1']);
    expect(got.codexHome).toBe(join(dir, 'home'));
    expect(got.secret).toBe('s3');
    const state = readFileSync(join(stateDir, 'server.json'), 'utf8');
    expect(JSON.parse(state).launch).toMatch(/^[0-9a-f]{16}$/);
    expect(state).not.toContain('gpt-x'); // fingerprint only, no values
    // Same settings: reattach. Different settings: refused, never silently shared.
    await new CodexHarness(opts).probe();
    await expect(new CodexHarness({ ...opts, config: { model: 'other' } }).probe()).rejects.toThrow(/started with other settings/);
    await expect(new CodexHarness({ ...opts, codexHome: join(dir, 'home2') }).probe()).rejects.toThrow(/started with other settings/);
  }, 20_000);

  it('config/enable/disable need a server the adapter starts', () => {
    expect(() => new CodexHarness({ config: { model: 'x' }, transport: { kind: 'unix', spawn: 'daemon' } })).toThrow(/not unix spawn 'daemon'/);
    expect(() => new CodexHarness({ enable: ['x'], transport: { kind: 'unix', spawn: 'none' } })).toThrow(/not unix spawn 'none'/);
  });
});
