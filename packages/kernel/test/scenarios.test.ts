import { basename, join } from 'node:path';
import { describe, it } from 'vitest';
import { readScenario, runScenario, scenarioFiles, type ScenarioDriver } from '@agents-io/testkit';
import { resolveConfig } from '../src/config.js';
import { coreRegistries } from '../src/core.js';
import { Gateway } from '../src/gateway.js';

/*
 * The kernel scenarios (packages/testkit/conformance/scenarios/kernel/*.ndjson, docs/design/
 * conformance-fixtures §3), each a test of the INVARIANTS ids its header names
 * (`scripts/invariants.mjs` counts the file as one), run by testkit's runner against the kernel with
 * no modules: `coreRegistries()`, the runner's reference channel and harness as the embedder's.
 * Another kernel (another language) runs the same files with its own driver.
 */

const DIR = join(import.meta.dirname, '..', '..', 'testkit', 'conformance', 'scenarios', 'kernel');

const driver: ScenarioDriver = {
  async start({ dir, config, harness, channel }) {
    const registries = coreRegistries();
    const socketPath = join(dir, 'run', 'aio.sock');
    const resolved = { ...resolveConfig({ dataDir: dir, cwd: dir, ...config }, { env: {}, baseDir: dir, cwd: dir, ...registries }), socketPath };
    const gw = await Gateway.start({ config: resolved, ...registries, harness, channels: [{ adapter: channel }], hostPush: { timeoutMs: 300, retryMs: 20 }, logger: () => {} });
    return {
      socketPath,
      token: gw.token,
      log: (key) => gw.hub.log.read(key, 0),
      attention: (key) => gw.hub.attention(key),
      stop: () => gw.stop(),
    };
  },
};

const FILES = scenarioFiles(DIR);

describe('kernel scenarios (language-neutral fixtures, the kernel with no modules)', () => {
  for (const file of FILES) {
    const s = readScenario(file);
    // The name carries the header's ids, so `-t '#IN-1\b'` selects it (the file itself is what invariants.mjs counts).
    const name = `${basename(file)}: ${s.header.description} ${s.header.invariants.map((i) => `#${i}`).join(' ')}`;
    it(name, async () => {
      await runScenario(s, driver, process.env.AIO_SCENARIO_TRACE ? { trace: (end, item) => console.log(end, JSON.stringify(item)) } : {});
    }, 30_000);
  }
});
