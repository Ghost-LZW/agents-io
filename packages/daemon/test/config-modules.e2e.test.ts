import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalClient, readTokenFile, tokenPath } from '@agents-io/kernel';
import { SOURCE_LOADER, cleanups, tmp, until } from './helpers.js';

/*
 * `aio serve` itself (the CLI, a child process over the sources): it imports the modules a config
 * names before it resolves the config, so a `modules` entry's feature module runs, and a bad entry
 * fails the start as a config error (exit 2) naming it; a descriptor channel of a package keeps
 * its state directory across an upgrade of the package between two starts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'src', 'cli.ts');
const fx = join(here, 'fixtures');

/** `aio serve --config <file>` over a config in a fresh directory (or `dir`, a deployment's again); its stderr so far, its exit code once it exits, and a stop. */
function serve(raw: Record<string, unknown>, dir = tmp('aio-cme-')) {
  mkdirSync(join(dir, 'work'), { recursive: true });
  const socketPath = join(dir, 'run', 'aio.sock');
  const path = join(dir, 'aio.config.json');
  const config = { dataDir: dir, socketPath, cwd: join(dir, 'work'), console: { enabled: false }, harnesses: { plug: { use: 'module', module: join(fx, 'harness-descriptor-full.mjs') } }, ...raw };
  writeFileSync(path, JSON.stringify(config));
  const child = spawn(process.execPath, [...SOURCE_LOADER, CLI, 'serve', '--config', path], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, AIO_CONFIG: '' } });
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exit = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
  };
  cleanups.push(stop);
  return { socketPath, stderr: () => err, exit, stop };
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

  it("a descriptor channel of a package (a bare specifier, installed as pnpm does: its directory a link into one named by its version) keeps its state directory when the package is upgraded between two starts #RS-1", async () => {
    const dir = tmp('aio-cme-');
    const versioned = pathToFileURL(join(fx, 'chan-versioned.mjs')).href;
    const link = join(dir, 'node_modules', 'acme-chan');
    // require.resolve answers the real path, `.pnpm/acme-chan@<version>/…`: the file the entry resolves to moves with each version.
    const install = (version: string) => {
      const real = join(dir, 'node_modules', '.pnpm', `acme-chan@${version}`, 'node_modules', 'acme-chan');
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, 'package.json'), JSON.stringify({ name: 'acme-chan', version, type: 'module', main: 'index.mjs' }));
      writeFileSync(join(real, 'index.mjs'), `import { versioned } from ${JSON.stringify(versioned)};\nexport const createChannel = versioned(${JSON.stringify(version)});\n`);
      rmSync(link, { force: true });
      symlinkSync(real, link, 'dir');
    };
    const raw = { channels: [{ type: 'module', module: 'acme-chan', config: { id: 'e2e1', token: 'x' } }] };
    const typeDir = join(dir, 'channels', 'module.default');
    // Each start appends its version to `starts` in the state directory its channel was given.
    const starts = () => (existsSync(typeDir) ? readdirSync(typeDir).map((d) => (existsSync(join(typeDir, d, 'starts')) ? readFileSync(join(typeDir, d, 'starts'), 'utf8') : '')) : []);
    install('1.0.0');
    const one = serve(raw, dir);
    expect(await until(() => starts().some(Boolean) && starts(), 20_000)).toEqual(['1.0.0\n']);
    await one.stop();
    install('1.1.0');
    serve(raw, dir);
    await until(() => starts().join('').includes('1.1.0'), 20_000);
    expect(starts()).toEqual(['1.0.0\n1.1.0\n']);
  }, 60_000);
});
