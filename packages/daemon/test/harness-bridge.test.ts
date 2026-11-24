import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { FakeChannel } from '@agents-io/testkit';
import { ConfigError, LocalClient, readTokenFile, tokenPath } from '@agents-io/kernel';
import { Gateway, resolveConfig } from '../src/defaults.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * A harness in another process (`use: "bridge"`, harness/jsonl-bridge) gets what an in-process one
 * gets: what its program declares in its hello reaches the chat commands and `session.compact`
 * (CT-2, CT-3), stop and restart follow its `detach` / `adopts` (RS-2, RS-4, RS-5, RS-8), it reads
 * the daemon's blob store (MD-1), a launched session's env reaches it as it declares (LA-3), and a
 * hello of the wrong shape fails the start (CF-4). The program is harness/jsonl-bridge's fixture
 * (`serveHarness` over a FakeHarness), which records every call it gets.
 */

const here = dirname(fileURLToPath(import.meta.url));
const loader = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', join(here, '..', '..', '..', 'scripts', 'source-loader.mjs')];
const program = join(here, '..', '..', '..', 'harness', 'jsonl-bridge', 'test', 'fixtures', 'fake_harness.mjs');
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };
const of = (evs: SessionEvent[], t: string) => evs.map((e) => e.body).filter((b) => b.t === t);
type Call = Record<string, any>;

/** A bridge instance running the fixture program with `env` (its RECORD is `record`). */
const bridge = (record: string, env: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({ use: 'bridge', command: process.execPath, args: [...loader, program], env: { RECORD: record, ...env }, ...extra });
const calls = (record: string): Call[] => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A daemon on `dir`'s log with these harness instances (the first is the default) and `raw` over the config. */
async function start(dir: string, harnesses: Record<string, unknown>, raw: Record<string, unknown> = {}) {
  mkdirSync(join(dir, 'work'), { recursive: true });
  const base = resolveConfig(
    { dataDir: dir, policy: { owners: ['fake:alice'] }, local: { principal: 'fake:alice' }, cwd: join(dir, 'work'), harnesses, defaultHarness: Object.keys(harnesses)[0], ...raw },
    { env: {}, baseDir: here, cwd: dir },
  );
  const socketPath = join(dir, 'run', 'aio.sock');
  const chat = new FakeChannel('fake');
  const logs: string[] = [];
  const gw = await Gateway.start({ config: { ...base, socketPath }, channels: [{ adapter: chat }], logger: (level, msg) => logs.push(`${level}: ${msg}`) });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await gw.stop();
  };
  cleanups.push(stop);
  const host = async () => {
    const c = await LocalClient.connect(socketPath);
    cleanups.push(() => c.close());
    await c.hello({ token: readTokenFile(tokenPath(socketPath)), name: 'test' });
    return c;
  };
  const replies = () => chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);
  /** Alice says `text`; the reply to it that `match` finds. */
  const say = async (text: string, match: (reply: string) => boolean = () => true) => {
    const before = replies().length;
    await chat.inject({ ...dm, sender: alice, text });
    return until(() => replies().slice(before).find((r) => r !== undefined && match(r)), 5000);
  };
  const turnStarts = () => gw.sessions().flatMap((s) => gw.hub.log.read(s.sessionKey, 0).filter((e) => e.body.t === 'turn.started').map((e) => ({ key: s.sessionKey, body: e.body as Extract<SessionEvent['body'], { t: 'turn.started' }> })));
  return { gw, chat, stop, host, say, logs, turnStarts };
}

describe('a bridge harness: its declarations', () => {
  it('declaring compaction, Plan mode and the profile switch: /plan and /bypass apply to the next turns, /status shows Plan mode, /compact and session.compact send its own command as a turn of its own #CT-2 #CT-3', async () => {
    const dir = tmp();
    const record = join(dir, 'record.jsonl');
    const w = await start(dir, { plug: bridge(record, { DECLARES: JSON.stringify({ displayName: 'Plug', compact: { command: '/squash' }, modes: ['plan'], ownerProfileSwitch: true }) }) });
    await w.say('hi', (r) => r.includes('echo: hi'));
    expect(await w.say('/plan on')).toBe('Plan mode on from the next turn.');
    expect(await w.say('/bypass off')).toBe('Bypass off for owner turns from the next turn.');
    expect(await w.say('/status', (r) => r.startsWith('session '))).toContain('Plan mode on · bypass restricted');
    await w.say('second', (r) => r.includes('echo: second'));
    const [first, second] = w.turnStarts();
    expect(first!.body.run).not.toHaveProperty('mode');
    expect(second!.body.run).toMatchObject({ harness: 'plug', mode: 'plan', profile: 'restricted' });

    const commands = () => calls(record).filter((c) => c.call === 'startTurn' && c.inputs.some((i: { native: boolean }) => i.native));
    expect(await w.say('/compact', (r) => r.startsWith('Compacting'))).toBe('Compacting (queued behind anything running).');
    await until(() => commands().length === 1 && !w.gw.hub.snapshot(second!.key).turn, 5000);
    expect(commands()[0]!.inputs).toEqual([{ text: '/squash', native: true }]);
    const h = await w.host();
    expect(await h.sessionCompact({ sessionKey: second!.key, inputId: 'cmp-1' })).toMatchObject({ sessionKey: second!.key, inputId: 'cmp-1', duplicate: false });
    await until(() => commands().length === 2, 5000);
    expect(commands()[1]!.inputs).toEqual([{ text: '/squash', native: true }]);
  });

  it('declaring none (an older program: its hello has version and caps only): /plan and /bypass name the registered kinds that have them, /compact and session.compact are unsupported, /status says Plan mode unavailable #CT-2 #CT-3', async () => {
    const dir = tmp();
    const record = join(dir, 'record.jsonl');
    const w = await start(dir, { bare: bridge(record) });
    await w.say('hi', (r) => r.includes('echo: hi'));
    expect(await w.say('/plan on')).toBe('/plan is available only on Codex (this session runs bridge).');
    expect(await w.say('/bypass on')).toBe('/bypass is available only on Codex (this session runs bridge).');
    expect(await w.say('/compact')).toBe('/compact is not available on bridge yet.');
    expect(await w.say('/status', (r) => r.startsWith('session '))).toContain('Plan mode unavailable');
    const sessionKey = w.turnStarts()[0]!.key;
    const h = await w.host();
    await expect(h.sessionCompact({ sessionKey })).rejects.toMatchObject({ code: 'unsupported', message: 'unsupported: bare (bridge) has no compaction command' });
    expect(calls(record).filter((c) => c.call === 'startTurn')).toHaveLength(1);
  });

  it('a hello of the wrong shape fails the start, naming the instance and the member, and its program does not stay; so does one declaring a takeover, and a program that cannot be run; an instance unavailable for now is not started #CF-4', async () => {
    const failed = async (harnesses: Record<string, unknown>) => {
      const e = (await start(tmp(), harnesses).catch((err) => err)) as Error;
      expect(e).toBeInstanceOf(ConfigError);
      return e.message;
    };
    const dir = tmp();
    const record = join(dir, 'record.jsonl');
    expect(await failed({ plug: bridge(record, { DECLARES: JSON.stringify({ modes: ['fast'] }) }) })).toMatch(/^harnesses\.plug \(bridge\): invalid probe answer: \/declares\/modes\/0: /);
    const pid = calls(record).find((c) => c.call === 'start')!.pid as number;
    await until(() => !alive(pid));
    expect(await failed({ plug: bridge(record, { DECLARES: JSON.stringify({ sessionEnv: { refused: '' } }) }) })).toMatch(/^harnesses\.plug \(bridge\): invalid probe answer: \/declares\/sessionEnv/);
    expect(await failed({ plug: bridge(record, { DECLARES: JSON.stringify({ attach: 'takeover' }) }) })).toBe("harnesses.plug (bridge): declares attach 'takeover', which needs a takeover (HarnessAdapter.takeover); the bridge cannot carry one");
    // The default instance is fine; another one's program fails.
    expect(await failed({ ok: bridge(join(dir, 'ok.jsonl')), gone: { use: 'bridge', command: '/nonexistent/harness-program' } })).toBe('harnesses.gone (bridge): spawn /nonexistent/harness-program ENOENT');

    const later = join(dir, 'later.jsonl');
    const w = await start(tmp(), { ok: bridge(join(dir, 'ok2.jsonl')), later: bridge(later, { TOKEN: 'env:AIO_TEST_UNSET_BRIDGE_TOKEN' }) });
    expect(w.gw.harness('ok').displayName).toBeUndefined();
    expect(calls(later)).toEqual([]);
  });
});

describe('a bridge harness: stop and restart', () => {
  it('declaring detach and adopts: at stop the lane detaches and the program is told detach (no close, no interrupt), then shut down; the next start reopens the session with no new input, the program adopts the turn and it completes once #RS-2', async () => {
    const dir = tmp();
    const record = join(dir, 'record.jsonl');
    const plug = bridge(record, { METHODS: 'detach', STATE: join(dir, 'state.json'), DECLARES: JSON.stringify({ adopts: true }) });
    const a = await start(dir, { plug });
    await a.chat.inject({ ...dm, sender: alice, text: 'long job' });
    const key = await until(() => a.gw.hub.log.sessions().find((k) => a.gw.hub.snapshot(k).turn), 5000);
    const first = calls(record).find((c) => c.call === 'start')!.pid as number;
    await a.stop();
    expect(calls(record).map((c) => c.call)).toEqual(['start', 'init', 'open', 'startTurn', 'detach', 'exit']);
    expect(alive(first)).toBe(false);

    const b = await start(dir, { plug });
    const turnId = calls(record).find((c) => c.call === 'detach')!.running[key].turnId;
    await until(() => calls(record).some((c) => c.call === 'adopt'), 5000);
    expect(calls(record).filter((c) => c.call === 'open').at(-1)).toMatchObject({ sessionKey: key, resume: `native-${key}` });
    await until(() => !b.gw.hub.snapshot(key).turn, 5000);
    const done = of(b.gw.hub.log.read(key, 0), 'turn.completed');
    expect(done).toEqual([expect.objectContaining({ turnId, status: 'completed' })]);
  });

  it('declaring detach but not adopts: the next start settles the turn it left ambiguous (host_restarted) without opening a session on the program #RS-4 #RS-5', async () => {
    const dir = tmp();
    const record = join(dir, 'record.jsonl');
    const plug = bridge(record, { METHODS: 'detach' });
    const a = await start(dir, { plug });
    await a.chat.inject({ ...dm, sender: alice, text: 'long job' });
    const key = await until(() => a.gw.hub.log.sessions().find((k) => a.gw.hub.snapshot(k).turn), 5000);
    await a.stop();
    const before = calls(record).length;
    const b = await start(dir, { plug });
    expect(b.gw.hub.snapshot(key).turn).toBeFalsy();
    expect(of(b.gw.hub.log.read(key, 0), 'turn.completed')).toEqual([expect.objectContaining({ status: 'ambiguous', error: expect.objectContaining({ code: 'host_restarted' }) })]);
    // Probed at start (it says what it declares there), never asked to open.
    expect(calls(record).slice(before).map((c) => c.call)).toEqual(['start', 'init']);
  });

  it('without detach: at stop its sessions are closed (the running turn ends) and the program is shut down; one that ignores shutdown is killed, within the stop bounds #RS-8', async () => {
    const dir = tmp();
    const record = join(dir, 'record.jsonl');
    const a = await start(dir, { plug: bridge(record) });
    await a.chat.inject({ ...dm, sender: alice, text: 'long job' });
    const key = await until(() => a.gw.hub.log.sessions().find((k) => a.gw.hub.snapshot(k).turn), 5000);
    await a.stop();
    expect(calls(record).map((c) => c.call)).toEqual(['start', 'init', 'open', 'startTurn', 'close', 'dispose', 'exit']);
    expect(calls(record).find((c) => c.call === 'close')).toMatchObject({ sessionKey: key, reason: 'gateway stopping' });

    const stubborn = join(dir, 'stubborn.jsonl');
    const b = await start(tmp(), { plug: bridge(stubborn, { MODE: 'stubborn' }) });
    await b.say('hi', (r) => r.includes('echo: hi'));
    const pid = calls(stubborn).find((c) => c.call === 'start')!.pid as number;
    const t0 = Date.now();
    await b.stop();
    expect(Date.now() - t0).toBeLessThan(6000);
    await until(() => !alive(pid));
  });
});

describe('a bridge harness: media and launches', () => {
  it("its program reads an inbound image from the daemon's blob store (blob.stat: the stored file; blob.get: the bytes); a platform ref the store lacks is not there #MD-1", async () => {
    const dir = tmp();
    const record = join(dir, 'record.jsonl');
    const w = await start(dir, { plug: bridge(record) });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const ref = await w.gw.blobs.put(png, { mime: 'image/png', name: 'a.png' });
    await w.chat.inject({ ...dm, sender: alice, content: [{ type: 'image', ref, mime: 'image/png' }, { type: 'image', ref: 'lark-file:om_1/k', mime: 'image/*' }] });
    await until(() => calls(record).some((c) => c.call === 'blobs'), 5000);
    expect(calls(record).find((c) => c.call === 'blobs')!.seen).toEqual([`${ref}: stat image/png 8 true; get image/png 8 89504e470d0a1a0a`, 'lark-file:om_1/k: stat none; get error not_found']);
  });

  it("a launched session's env reaches the program as it declares: 'open' in the session's open, 'own-process' on a copy of the program of the session's own (its env, its cwd), shut down with the lane #LA-3", async () => {
    const dir = realpathSync(tmp());
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, 'a'), { recursive: true });
    const agents = (harness: string) => ({ agents: { dev: { harness, sessionParams: { cwdRoots: [ws], envKeys: ['FOO'] } } }, defaultAgent: 'dev' });
    const turn = async (w: Awaited<ReturnType<typeof start>>, sessionKey: string) => {
      const h = await w.host();
      await h.call('session.prepare', { sessionKey, agent: 'dev', launch: { cwd: join(ws, 'a'), env: { FOO: 'bar' } } });
      await h.input(sessionKey, 'hi');
      await until(() => w.gw.hub.log.read(sessionKey, 0).some((e) => e.body.t === 'turn.completed'), 5000);
    };

    const opens = join(dir, 'open.jsonl');
    const o = await start(join(dir, 'o'), { plug: bridge(opens) }, agents('plug'));
    await turn(o, 'L1');
    expect(calls(opens).filter((c) => c.call === 'start')).toHaveLength(1);
    expect(calls(opens).find((c) => c.call === 'open')).toMatchObject({ sessionKey: 'L1', cwd: join(ws, 'a'), env: { FOO: 'bar' } });

    const owns = join(dir, 'own.jsonl');
    const w = await start(join(dir, 'w'), { plug: bridge(owns, { DECLARES: JSON.stringify({ sessionEnv: 'own-process' }) }) }, agents('plug'));
    await turn(w, 'L2');
    const [shared, own] = calls(owns).filter((c) => c.call === 'start');
    expect(shared!.foo).toBeUndefined();
    expect(own).toMatchObject({ foo: 'bar', cwd: join(ws, 'a') });
    expect(calls(owns).filter((c) => c.call === 'open')).toEqual([expect.objectContaining({ pid: own!.pid, sessionKey: 'L2' })]);
    expect(calls(owns).find((c) => c.call === 'open')!.env).toBeUndefined();
    await w.stop();
    expect(calls(owns).filter((c) => c.call === 'exit').map((c) => c.pid).sort()).toEqual([shared!.pid, own!.pid].sort());
  });
});
