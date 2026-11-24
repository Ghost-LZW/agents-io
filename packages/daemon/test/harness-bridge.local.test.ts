import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalClient, readTokenFile, tokenPath } from '@agents-io/kernel';
import { Gateway, resolveConfig } from '../src/defaults.js';
import { cleanups, tmp, until } from './helpers.js';

/* A task run on a bridge instance (`use: "bridge"`): what it starts and stops. The fixture is harness/jsonl-bridge's. */

const here = dirname(fileURLToPath(import.meta.url));
const loader = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', join(here, '..', '..', '..', 'scripts', 'source-loader.mjs')];
const program = join(here, '..', '..', '..', 'harness', 'jsonl-bridge', 'test', 'fixtures', 'fake_harness.mjs');
const calls = (record: string): Record<string, any>[] => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('a bridge harness: task runs', () => {
  it("a task run runs on a program of its own (the run's env over the instance's, its cwd), shut down when the run ends; the instance's program is not opened", async () => {
    const dir = tmp();
    const record = join(dir, 'record.jsonl');
    mkdirSync(join(dir, 'work'), { recursive: true });
    const config = resolveConfig(
      {
        dataDir: dir,
        local: { principal: 'me' },
        cwd: join(dir, 'work'),
        harnesses: { plug: { use: 'bridge', command: process.execPath, args: [...loader, program], env: { RECORD: record, ROLE: 'instance' } } },
        agents: { exec: { harness: 'plug', mode: 'task' } },
      },
      { env: {}, baseDir: here, cwd: dir },
    );
    const socketPath = join(dir, 'run', 'aio.sock');
    const gw = await Gateway.start({ config: { ...config, socketPath }, logger: () => {} });
    cleanups.push(() => gw.stop());
    const h = await LocalClient.connect(socketPath);
    cleanups.push(() => h.close());
    await h.hello({ token: readTokenFile(tokenPath(socketPath)), name: 'test' });
    await h.runStart({ runId: 'r1', agent: 'exec', input: [{ type: 'text', text: 'go' }], env: { FOO: 'bar' } });
    expect(await h.runEndedOf('r1')).toMatchObject({ status: 'completed', exitCode: 0 });
    const [instance, run] = calls(record).filter((c) => c.call === 'start');
    expect(instance).toMatchObject({ role: 'instance' });
    expect(run).toMatchObject({ role: 'instance', foo: 'bar', runId: 'r1' });
    expect(calls(record).filter((c) => c.call === 'open')).toEqual([expect.objectContaining({ pid: run!.pid, sessionKey: 'run:r1' })]);
    await until(() => calls(record).some((c) => c.call === 'exit' && c.pid === run!.pid), 5000);
    expect(calls(record).some((c) => c.call === 'exit' && c.pid === instance!.pid)).toBe(false);
  });

  it("unavailable for now (an env: reference not set): its program is not started, so it declares nothing: a launch with env is launch_unsupported, saying why it cannot run; a cwd alone is fine", async () => {
    const dir = tmp();
    const a = join(dir, 'ws', 'a');
    mkdirSync(a, { recursive: true });
    const record = join(dir, 'record.jsonl');
    const config = resolveConfig(
      {
        dataDir: dir,
        local: { principal: 'me' },
        cwd: dir,
        harnesses: { cc: { use: 'claude-code' }, plug: { use: 'bridge', command: process.execPath, args: [...loader, program], env: { RECORD: record, TOKEN: 'env:AIO_TEST_UNSET_BRIDGE_TOKEN' } } },
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
      message: 'harness instance plug is unavailable: harnesses.plug.env.TOKEN: environment variable AIO_TEST_UNSET_BRIDGE_TOKEN is not set; a session env cannot apply there (a cwd alone can)',
    });
    expect(prep('U2', { cwd: a })).toMatchObject({ ok: true, value: { created: true } });
    expect(calls(record)).toEqual([]);
  });
});
