import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalClient } from '../src/client.js';
import { readTokenFile, tokenPath } from '../src/token.js';
import { SOURCE_LOADER, cleanups, tmp, until } from './helpers.js';

/*
 * `aio serve` itself (the CLI, a child process over the sources): it imports the modules a config
 * names before it resolves the config, so a `modules` entry's feature module runs, and a bad entry
 * fails the start as a config error (exit 2) naming it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'src', 'cli.ts');
const fx = join(here, 'fixtures');

/** `aio serve --config <file>` over a config in a fresh directory; its stderr so far and its exit code once it exits. */
function serve(raw: Record<string, unknown>) {
  const dir = tmp('aio-cme-');
  mkdirSync(join(dir, 'work'), { recursive: true });
  const socketPath = join(dir, 'run', 'aio.sock');
  const path = join(dir, 'aio.config.json');
  const config = { dataDir: dir, socketPath, cwd: join(dir, 'work'), console: { enabled: false }, harnesses: { plug: { use: 'module', module: join(fx, 'harness-descriptor-full.mjs') } }, ...raw };
  writeFileSync(path, JSON.stringify(config));
  const child = spawn(process.execPath, [...SOURCE_LOADER, CLI, 'serve', '--config', path], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, AIO_CONFIG: '' } });
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exit = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  cleanups.push(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
  });
  return { socketPath, stderr: () => err, exit };
}

describe('aio serve with modules a config names', () => {
  it('runs a modules entry\'s feature module (its host.hello feature); a bad entry fails the start, exit 2, naming it #CF-4', async () => {
    const ok = serve({ modules: [{ use: 'module', module: join(fx, 'feature-module.mjs'), config: { key: 'e2e', greeting: 'hey' } }] });
    await until(() => ok.stderr().includes('serving on'), 20_000);
    const c = await LocalClient.connect(ok.socketPath);
    cleanups.push(() => c.close());
    expect((await c.hello({ token: readTokenFile(tokenPath(ok.socketPath)), name: 'e2e' })).features).toContain('acme.greet');

    const bad = serve({ modules: [{ use: 'module', module: join(fx, 'feature-module.mjs'), export: 'noSetup' }] });
    expect(await bad.exit).toBe(2);
    expect(bad.stderr()).toMatch(/aio: modules\[0\] \(module .*feature-module\.mjs\): module acme\.nosetup: setup must be a function/);
  }, 40_000);
});
