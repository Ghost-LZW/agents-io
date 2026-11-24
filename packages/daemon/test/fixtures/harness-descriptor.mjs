import { Type } from '@sinclair/typebox';
import { FakeHarness } from '@agents-io/testkit';

/**
 * A module harness exported as a HarnessModule descriptor instead of a factory: its `schema` checks
 * the entry's `config`; `create` puts its init at globalThis.__descriptor[config.key] and throws
 * when `config.throws` is set.
 */
export const createHarness = {
  kind: 'descriptor-fixture',
  schema: Type.Object({ key: Type.String(), throws: Type.Optional(Type.Boolean()) }),
  create(init) {
    if (init.launch.throws) throw new Error('no adapter today');
    const fake = new FakeHarness();
    (globalThis.__descriptor ??= {})[init.launch.key] = { init, fake };
    return { id: 'descriptor', probe: () => fake.probe(), open: (args) => fake.open(args), displayName: 'Described' };
  },
};
