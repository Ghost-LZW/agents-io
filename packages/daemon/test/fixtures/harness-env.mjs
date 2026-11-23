import { FakeHarness } from '@agents-io/testkit';

const script = async (t) => t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });

/**
 * A module harness for what its factory and its opens get: `init.blobs`, and a launched
 * session's or task run's env as `config` declares it (`sessionEnv`; with `config.own` an
 * `ownProcess` whose adapters are recorded). Each factory call puts
 * `{ init, fake, owned: [{ o, fake, disposed }] }` at globalThis.__env[config.key].
 */
export function createHarness(init) {
  const c = init.config ?? {};
  const fake = new FakeHarness(script);
  const rec = { init, fake, owned: [] };
  (globalThis.__env ??= {})[c.key] = rec;
  const adapter = { id: 'env', probe: () => fake.probe(), open: (args) => fake.open(args) };
  if (c.sessionEnv !== undefined) adapter.sessionEnv = c.sessionEnv;
  if (c.own) {
    adapter.ownProcess = (o) => {
      const own = { o, fake: new FakeHarness(script), disposed: 0 };
      rec.owned.push(own);
      return { id: 'env-own', probe: () => own.fake.probe(), open: (args) => own.fake.open(args), dispose: async () => void own.disposed++ };
    };
  }
  return adapter;
}
