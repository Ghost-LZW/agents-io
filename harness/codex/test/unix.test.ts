import { chmodSync as chmod, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertConformingStream } from '@agents-io/testkit';
import { CodexHarness, launchFlags, type CodexHarnessOptions } from '../src/index.js';
import { cleanupAfterEach, cleanups, cmdApproval, collector, fakeOnSocket, harnessFor, input, isCompleted, privDir, run, tick } from './unix-helpers.js';

cleanupAfterEach();

describe('unix socket transport', () => {
  it('speaks JSON-RPC as WebSocket frames over the socket and refuses sockets others can reach #SE-2', async () => {
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

  it('a restarted host adopts a running turn and its replayed approval #RS-2 #RQ-1', async () => {
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

  it('settles an adopted turn that finished while no host was attached #RS-2', async () => {
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

  it('settles an adopted turn that finished while another client started a turn on the thread #RS-2', async () => {
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

  it('keeps the adopted turn when Codex still runs it #RS-2', async () => {
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

  it('an approval answered while reconnecting is delivered when Codex replays it, and only then reported resolved #RQ-1', async () => {
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
});

describe('launch settings (named instances)', () => {
  const bin = join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');

  it('refuses secrets in -c values (argv is readable by other local users); env-var indirection is fine #SE-1', () => {
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

  it('own: the detached server gets the flags and CODEX_HOME; other settings on the same stateDir are refused #LA-3 #SE-1', async () => {
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
});
