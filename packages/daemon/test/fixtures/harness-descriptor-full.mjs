import { FakeHarness } from '@agents-io/testkit';

/**
 * A module harness exported as a HarnessModule descriptor with `declares` and `cli`. Its adapter
 * declares only `displayName` ("Own") and what `config.members` adds; the descriptor declares
 * Plan mode, the owner's profile switch, a compaction command and a display name its adapter's
 * own wins over. `cli` adds `acme-hello`, which records its argv at globalThis.__acmeCli and
 * answers 7. The other exports are wrong in one way each.
 */
const create = (init) => {
  const fake = new FakeHarness(async (t) => t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' }));
  const adapter = { id: 'full', probe: () => fake.probe(), open: (args) => fake.open(args), displayName: 'Own' };
  Object.assign(adapter, init.launch?.members ?? {});
  return adapter;
};

const hello = async ({ argv }) => {
  globalThis.__acmeCli = [...argv];
  return 7;
};

export const createHarness = {
  kind: 'acme-full',
  declares: { displayName: 'Declared', modes: ['plan'], ownerProfileSwitch: true, compact: { command: '/squash' } },
  cli: { 'acme-hello': hello },
  create,
};

/** Its declarations, but `modes` of the wrong type. */
export const badModes = { ...createHarness, declares: { modes: 'plan' } };

/** A declaration that is none. */
export const unknownDeclaration = { ...createHarness, declares: { detach: true } };

/** Declares 'own-process', which its adapter (without ownProcess) cannot. */
export const ownProcess = { ...createHarness, cli: undefined, declares: { sessionEnv: 'own-process' } };

/** A command name the CLI cannot have. */
export const badCliName = { ...createHarness, cli: { Hello: hello } };

/** A command that is not a function. */
export const cliNotFn = { ...createHarness, cli: { 'acme-hello': 'echo' } };

/** A built-in kind's command (Claude Code's tui-bridge). */
export const builtinCli = { ...createHarness, cli: { 'tui-bridge': hello } };

/** The same command name as createHarness, another function. */
export const otherHello = { ...createHarness, cli: { 'acme-hello': async () => 0 } };
