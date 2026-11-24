import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gateway, coreRegistries, resolveConfig } from '@agents-io/kernel';
import { spawnHarness, type BridgedHarness } from '@agents-io/harness-jsonl-bridge';
import { readScenario, runScenario, scenarioFiles, type ScenarioDriver } from '@agents-io/testkit';

/*
 * The kernel scenarios whose harness is a transcript (packages/testkit/conformance/scenarios/
 * kernel/, docs/design/conformance-fixtures §3), with that transcript played out of process:
 * `aio-transcript-replay` as the program of the real harness bridge host (`spawnHarness`, what the
 * `bridge` harness kind runs), the way a kernel in any language would spawn it. The same files run
 * with the in-process replay in packages/kernel/test/scenarios.test.ts; gated ones need that one.
 */

const root = join(import.meta.dirname, '..', '..', '..');
const DIR = join(root, 'packages', 'testkit', 'conformance', 'scenarios', 'kernel');
const REPLAY = join(root, 'packages', 'testkit', 'src', 'transcript-replay.ts');
const loader = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', join(root, 'scripts', 'source-loader.mjs')];

const played = scenarioFiles(DIR)
  .map((file) => ({ file, s: readScenario(file) }))
  .filter(({ s }) => {
    const h = s.steps.flatMap(({ step }) => ('harness' in step && 'transcript' in step.harness ? [step.harness] : []));
    return h.length > 0 && h.every((x) => !x.gate?.length);
  });

describe('kernel scenarios with their harness transcript played out of process (aio-transcript-replay under the bridge host)', () => {
  for (const { file, s } of played) {
    const name = `${basename(file)}: ${s.header.description} ${s.header.invariants.map((i) => `#${i}`).join(' ')}`;
    it(name, async () => {
      const stderr: string[] = [];
      const programs: BridgedHarness[] = [];
      const driver: ScenarioDriver = {
        playsTranscripts: true,
        async start({ dir, config, harness, channel, transcript }) {
          const bridged = transcript
            ? spawnHarness({ command: process.execPath, args: [...loader, REPLAY, transcript.path, '--after-end', 'answer'], log: (_l, m, d) => (d as { stream?: string } | undefined)?.stream === 'stderr' && stderr.push(m) })
            : undefined;
          if (bridged) programs.push(bridged);
          const registries = coreRegistries();
          const socketPath = join(dir, 'run', 'aio.sock');
          const resolved = { ...resolveConfig({ dataDir: dir, cwd: dir, ...config }, { env: {}, baseDir: dir, cwd: dir, ...registries }), socketPath };
          const gw = await Gateway.start({ config: resolved, ...registries, harness: bridged ?? harness!, channels: [{ adapter: channel }], hostPush: { timeoutMs: 300, retryMs: 20 }, logger: () => {} });
          return {
            socketPath,
            token: gw.token,
            log: (key) => gw.hub.log.read(key, 0),
            attention: (key) => gw.hub.attention(key),
            stop: async () => {
              await gw.stop();
              await bridged?.dispose();
            },
          };
        },
      };
      await runScenario(s, driver);
      expect(programs.length).toBeGreaterThan(0);
      // The replay said nothing: every frame the host wrote was the transcript's, in its order.
      expect(stderr).toEqual([]);
    }, 30_000);
  }
});
