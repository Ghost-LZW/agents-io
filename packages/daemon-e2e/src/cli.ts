#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CommandError, buildHarness, defaultInstance, loadConfig } from '@agents-io/daemon';
import { exitCodeFor, parseCli } from '@agents-io/daemon/cli';
import { runScenarios } from './scenarios.js';

/*
 * `aio-e2e` (`pnpm e2e` from the repo root): the scenarios against the REAL harness from the
 * config (docs/E2E.md §1.1). This was `aio e2e`; it lives outside the daemon so the production
 * package does not carry the scenarios or depend on testkit. Same options, same output.
 */

const USAGE = `aio-e2e: the agents-io daemon's end-to-end scenarios against the real harness (was \`aio e2e\`; docs/E2E.md §1.1)

  aio-e2e [--harness <instance>] [--only <id|name>[,…]] [--data-dir <dir>] [--verbose]

--harness: a name from \`harnesses\` (or claude-code|codex: that kind's first instance)
exit codes: 0 no scenario failed, 1 failed, 2 usage/config error

common: --config <aio.config.json> (or $AIO_CONFIG)  --env-file <.env.live>`;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export async function main(argv: string[]): Promise<number> {
  // The daemon's parser, as `aio e2e …` would have been parsed: same options, same usage errors.
  const a = parseCli(['e2e', ...argv]);
  if (a.cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  const config = str(a.values.config);
  const envFile = str(a.values['env-file']);
  const harness = str(a.values.harness);
  const c = loadConfig({ ...(config ? { path: config } : {}), ...(envFile ? { envFile } : {}), ...(harness ? { harness } : {}), channels: false });
  const inst = defaultInstance(c);
  const probe = await buildHarness(inst).probe();
  const modelFrom = process.env[inst.kind === 'codex' ? 'AGENTS_IO_LIVE_CODEX_MODEL' : 'AGENTS_IO_LIVE_CLAUDE_MODEL'] ? 'env' : 'config/default';
  console.log(`e2e against ${inst.name} (${inst.kind}): ${probe.version}; model ${inst.run.model || '(codex default)'} from ${modelFrom}`);
  const only = str(a.values.only)?.split(',').map((s) => s.trim());
  const root = str(a.values['data-dir']);
  const results = await runScenarios(c, { ...(only ? { only } : {}), ...(root ? { root: resolve(root.replace(/^~(?=$|\/)/, homedir())) } : {}), verbose: a.values.verbose === true });
  const n = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped`);
  return n('FAIL') ? 1 : 0;
}

/** Run the scenarios and exit the process with the code (the `aio-e2e` bin). */
export function run(argv: string[]): void {
  main(argv).then(
    (code) => process.exit(code),
    (e: Error) => {
      const code = exitCodeFor(e);
      console.error(code === 1 && !(e instanceof CommandError) ? (e.stack ?? e.message) : `aio-e2e: ${e.message}`);
      process.exit(code);
    },
  );
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
if (invoked === import.meta.url) run(process.argv.slice(2));
