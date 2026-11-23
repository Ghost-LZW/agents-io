import { FakeHarness } from '@agents-io/testkit';

/**
 * A module harness whose adapter has, besides id, probe and open, the members `config.members`
 * names, each as it is (any JSON value; `{ "$set": [...] }` is a Set of those values), right or
 * wrong for a HarnessAdapter.
 */
export function createHarness(init) {
  const fake = new FakeHarness();
  const adapter = { id: 'declares', probe: () => fake.probe(), open: (args) => fake.open(args) };
  for (const [k, v] of Object.entries(init.config?.members ?? {})) adapter[k] = v !== null && typeof v === 'object' && Array.isArray(v.$set) ? new Set(v.$set) : v;
  return adapter;
}
