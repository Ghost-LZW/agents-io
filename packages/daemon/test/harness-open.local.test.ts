import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { BlobAccess } from '@agents-io/protocol';
import { CodexHarness, type CodexHarnessOptions } from '@agents-io/harness-codex';
import { FakeChannel, type FakeHarness } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway, InstanceHarness } from '../src/gateway.js';
import { readTokenFile, tokenPath } from '../src/token.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * What a `use: "module"` harness gets besides lifecycle calls and static capabilities: the daemon's
 * blob store (`HarnessFactoryInit.blobs`), the agent's instructions (`HarnessOpenArgs.instructions`,
 * during the transition also `options.developerInstructions`), and a launched session's or task
 * run's env the way its adapter declares (`sessionEnv`, `ownProcess`): fixtures/harness-env.mjs.
 */

const here = dirname(fileURLToPath(import.meta.url));
type Own = { o: { env: Record<string, string>; cwd?: string }; fake: FakeHarness; disposed: number };
type Rec = { init: { blobs?: BlobAccess }; fake: FakeHarness; owned: Own[] };
let keys = 0;

/** A daemon whose one instance `plug` (env BASE=1) is the env module with `config`; agent `dev` (instructions, launches under `ws`) and task agent `exec` run on it. */
async function start(config: Record<string, unknown>) {
  const key = `e${++keys}`;
  const dir = realpathSync(tmp());
  const ws = join(dir, 'ws');
  mkdirSync(join(dir, 'work'), { recursive: true });
  for (const d of ['a', 'b']) mkdirSync(join(ws, d), { recursive: true });
  writeFileSync(join(dir, 'dev.md'), 'Be brief.');
  const raw = {
    dataDir: dir,
    policy: { owners: ['fake:alice'] },
    local: { principal: 'me' },
    cwd: join(dir, 'work'),
    harnesses: { plug: { use: 'module', module: './fixtures/harness-env.mjs', env: { BASE: '1' }, config: { key, ...config } } },
    agents: {
      dev: { harness: 'plug', instructionsFile: join(dir, 'dev.md'), sessionParams: { cwdRoots: [ws], envKeys: ['FOO'] } },
      exec: { harness: 'plug', mode: 'task' },
    },
    defaultAgent: 'dev',
  };
  const base = resolveConfig(raw, { env: {}, baseDir: here, cwd: dir });
  const socketPath = join(dir, 'run', 'aio.sock');
  const gw = await Gateway.start({ config: { ...base, socketPath }, channels: [{ adapter: new FakeChannel('fake') }], logger: () => {} });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await gw.stop();
  };
  cleanups.push(stop);
  const h = await LocalClient.connect(socketPath);
  cleanups.push(() => h.close());
  await h.hello({ token: readTokenFile(tokenPath(socketPath)), name: 'test' });
  const rec = (globalThis as { __env?: Record<string, Rec> }).__env![key]!;
  /** One turn on `sessionKey` (prepared with `launch` first, when given), done. */
  const turn = async (sessionKey: string, launch?: { cwd?: string; env?: Record<string, string> }) => {
    if (launch) await h.call('session.prepare', { sessionKey, agent: 'dev', launch });
    h.input(sessionKey, 'hi');
    await until(() => gw.hub.log.read(sessionKey, 0).some((e) => e.body.t === 'turn.completed'));
  };
  return { gw, h, rec, ws, stop, turn };
}

describe('module harness: what its factory and opens get', () => {
  it('the factory gets the blob store read-only (stat and get, each working detached): a stored ref stats to its file and reads back; a platform ref is not there', async () => {
    const w = await start({});
    const ref = await w.gw.blobs.put(new TextEncoder().encode('hello'), { mime: 'text/plain', name: 'h.txt' });
    const blobs = w.rec.init.blobs!;
    expect(Object.keys(blobs).sort()).toEqual(['get', 'stat']);
    expect(Object.isFrozen(blobs)).toBe(true);
    expect(blobs).not.toHaveProperty('put');
    const { stat, get } = blobs;
    expect(await stat(ref)).toMatchObject({ mime: 'text/plain', name: 'h.txt', size: 5, path: expect.stringMatching(/^\//) });
    expect(new TextDecoder().decode((await get(ref)).bytes)).toBe('hello');
    expect(await stat('lark-file:om_1/k')).toBeUndefined();
  });

  it("an open carries the agent's instructions, and still as options.developerInstructions", async () => {
    const w = await start({});
    await w.turn('S1');
    expect(w.rec.fake.sessions[0]!.args).toMatchObject({ sessionKey: 'S1', instructions: 'Be brief.', options: { developerInstructions: 'Be brief.' } });
  });

  it("sessionEnv 'own-process': a launched session with env opens on the adapter ownProcess gave it (the env not in its open args), disposed with the lane; a cwd alone shares the instance", async () => {
    const w = await start({ sessionEnv: 'own-process', own: true });
    const a = join(w.ws, 'a');
    await w.turn('L1', { cwd: a, env: { FOO: 'bar' } });
    expect(w.rec.owned).toHaveLength(1);
    const own = w.rec.owned[0]!;
    expect(own.o).toEqual({ env: { FOO: 'bar' }, cwd: a });
    // The instance's env still comes through the open args, as for every module open.
    expect(own.fake.sessions[0]!.args).toMatchObject({ sessionKey: 'L1', cwd: a, env: { BASE: '1' }, instructions: 'Be brief.' });
    expect(own.fake.sessions[0]!.args.env).not.toHaveProperty('FOO');

    await w.turn('L2', { cwd: join(w.ws, 'b') });
    expect(w.rec.owned).toHaveLength(1);
    expect(w.rec.fake.sessions.map((s) => s.args.sessionKey)).toEqual(['L2']);
    expect(own.disposed).toBe(0);
    await w.stop();
    expect(own.disposed).toBe(1);
  });

  it("by default a launched session's env comes through the open args, over the instance's", async () => {
    const w = await start({ own: true });
    await w.turn('L1', { cwd: join(w.ws, 'a'), env: { FOO: 'bar' } });
    expect(w.rec.owned).toHaveLength(0);
    expect(w.rec.fake.sessions[0]!.args.env).toEqual({ BASE: '1', FOO: 'bar' });
  });

  it('sessionEnv { refused }: a launch with env is launch_unsupported, saying why; a cwd alone is fine', async () => {
    const w = await start({ sessionEnv: { refused: 'a shared test server' } });
    const refused = w.h.call('session.prepare', { sessionKey: 'U1', agent: 'dev', launch: { env: { FOO: 'bar' } } });
    await expect(refused).rejects.toMatchObject({ code: 'launch_unsupported' });
    await expect(refused).rejects.toThrow('harness instance plug is a shared test server; a session env cannot apply there (a cwd alone can)');
    await w.turn('U2', { cwd: join(w.ws, 'a') });
    expect(w.rec.fake.sessions.map((s) => s.args.sessionKey)).toEqual(['U2']);
  });

  it('a task run opens on its own process when the adapter has ownProcess (also with only AGENTS_IO_RUN_ID), disposed when it ends; without it on the shared adapter; the env always in its open args, over the instance env', async () => {
    const w = await start({ sessionEnv: { refused: 'a shared test server' }, own: true });
    await w.h.runStart({ runId: 'r1', agent: 'exec', cwd: join(w.ws, 'a'), input: [{ type: 'text', text: 'go' }] });
    expect(await w.h.runEndedOf('r1')).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(w.rec.owned.map((x) => x.o)).toEqual([{ env: {}, cwd: join(w.ws, 'a') }]);
    expect(w.rec.owned[0]!.fake.sessions[0]!.args).toMatchObject({ sessionKey: 'run:r1', cwd: join(w.ws, 'a'), env: { BASE: '1', AGENTS_IO_RUN_ID: 'r1' } });
    await until(() => w.rec.owned[0]!.disposed === 1);
    expect(w.rec.fake.sessions).toHaveLength(0);

    const plain = await start({});
    await plain.h.runStart({ runId: 'r2', agent: 'exec', input: [{ type: 'text', text: 'go' }], env: { X: 'y' } });
    expect(await plain.h.runEndedOf('r2')).toMatchObject({ status: 'completed' });
    expect(plain.rec.fake.sessions[0]!.args.env).toEqual({ BASE: '1', X: 'y', AGENTS_IO_RUN_ID: 'r2' });
  });

  it('unavailable for now (an env: reference in its config not set): its factory never ran, so a launch with env is launch_unsupported, saying why it cannot run; a cwd alone is fine', async () => {
    const dir = realpathSync(tmp());
    const a = join(dir, 'ws', 'a');
    mkdirSync(a, { recursive: true });
    const config = resolveConfig(
      {
        dataDir: dir,
        local: { principal: 'me' },
        cwd: dir,
        // The default instance is built at start, so it is another one.
        harnesses: { cc: { use: 'claude-code' }, plug: { use: 'module', module: './fixtures/harness-env.mjs', config: { key: `e${++keys}`, token: 'env:AIO_TEST_UNSET_TOKEN' } } },
        defaultHarness: 'cc',
        agents: { dev: { harness: 'plug', sessionParams: { cwdRoots: [join(dir, 'ws')], envKeys: ['FOO'] } } },
        defaultAgent: 'dev',
      },
      { env: {}, baseDir: here, cwd: dir },
    );
    const gw = await Gateway.start({ config: { ...config, socketPath: join(dir, 'run', 'aio.sock') }, logger: () => {} });
    cleanups.push(() => gw.stop());
    const prep = (sessionKey: string, launch: { cwd?: string; env?: Record<string, string> }) => gw.prepareSession({ v: 1, type: 'session.prepare', id: 'x', sessionKey, agent: 'dev', launch } as never);
    expect(prep('U1', { cwd: a, env: { FOO: 'bar' } })).toMatchObject({
      ok: false,
      code: 'launch_unsupported',
      message: 'harness instance plug is unavailable: harnesses.plug.config.token: environment variable AIO_TEST_UNSET_TOKEN is not set; a session env cannot apply there (a cwd alone can)',
    });
    expect(prep('U2', { cwd: a })).toMatchObject({ ok: true, value: { created: true } });
  });

  it("sessionEnv 'own-process' without ownProcess fails the start", async () => {
    await expect(start({ sessionEnv: 'own-process' })).rejects.toThrow(/harnesses\.plug \(module .*\): the factory did not return a HarnessAdapter \(bad sessionEnv \('own-process' needs ownProcess\)\)/);
  });
});

describe('built-in harness instances', () => {
  it("get the daemon's blob store as module harnesses do (read-only) and declare how a session env reaches them", async () => {
    const dir = tmp();
    const config = resolveConfig(
      { dataDir: dir, harnesses: { cc: { use: 'claude-code' }, cx: { use: 'codex' }, ux: { use: 'codex', transport: { kind: 'unix', spawn: 'own', stateDir: join(dir, 'ux') } } }, local: { principal: 'me' } },
      { env: {}, baseDir: dir, cwd: dir },
    );
    const gw = await Gateway.start({ config: { ...config, socketPath: join(dir, 'run', 'aio.sock') }, logger: () => {} });
    cleanups.push(() => gw.stop());
    const inner = (name: string) => (gw.harness(name) as InstanceHarness).inner as unknown as { sessionEnv: unknown; config?: { blobs?: unknown }; opts?: { blobs?: unknown } };
    expect(inner('cc').config!.blobs).toBe(gw.harnessBlobs);
    expect(inner('cx').opts!.blobs).toBe(gw.harnessBlobs);
    expect(Object.keys(gw.harnessBlobs).sort()).toEqual(['get', 'stat']);
    expect([inner('cc').sessionEnv, inner('cx').sessionEnv, inner('ux').sessionEnv]).toEqual(['open', 'own-process', { refused: 'a shared Codex app-server (unix transport)' }]);
    // Read through the instance's wrapper, as the gateway reads it.
    expect(gw.harness('ux').sessionEnv).toEqual({ refused: 'a shared Codex app-server (unix transport)' });
  });
});

describe('a task run on a Codex instance', () => {
  it('runs on an app-server of its own over stdio, also on a unix instance: the run env (with AGENTS_IO_RUN_ID) over the instance env, the instance home kept', async () => {
    const ownProcess = vi.spyOn(CodexHarness.prototype, 'ownProcess');
    cleanups.push(() => ownProcess.mockRestore());
    const dir = realpathSync(tmp());
    mkdirSync(join(dir, 'home'));
    const config = resolveConfig(
      {
        dataDir: dir,
        local: { principal: 'me' },
        harnesses: { ux: { use: 'codex', executable: join(dir, 'missing-codex'), home: join(dir, 'home'), env: { BASE: '1' }, transport: { kind: 'unix', spawn: 'own', stateDir: join(dir, 'ux') } } },
        agents: { exec: { harness: 'ux', mode: 'task' } },
      },
      { env: {}, baseDir: dir, cwd: dir },
    );
    const socketPath = join(dir, 'run', 'aio.sock');
    const gw = await Gateway.start({ config: { ...config, socketPath }, logger: () => {} });
    cleanups.push(() => gw.stop());
    const h = await LocalClient.connect(socketPath);
    cleanups.push(() => h.close());
    await h.hello({ token: readTokenFile(tokenPath(socketPath)), name: 'test' });
    await h.runStart({ runId: 'r1', agent: 'exec', cwd: dir, input: [{ type: 'text', text: 'go' }], env: { X: 'y', CODEX_HOME: join(dir, 'other') } });
    // The binary is missing: the run fails to start, after its adapter was set up.
    expect(await h.runEndedOf('r1')).toMatchObject({ status: 'failed' });
    expect(ownProcess).toHaveBeenCalledTimes(1);
    const own = ownProcess.mock.results[0]!.value as unknown as { opts: CodexHarnessOptions };
    expect(own.opts).toMatchObject({ transport: { kind: 'stdio' }, codexHome: join(dir, 'home'), env: { BASE: '1', X: 'y', AGENTS_IO_RUN_ID: 'r1' } });
  });
});
