import { FakeHarness } from '@agents-io/testkit';

/**
 * A module harness declaring the static capabilities its `config` names (HarnessAdapter
 * `displayName`, `compact` (the command), `modes`, `ownerProfileSwitch`, `ephemeralOpen`).
 * Each factory call puts `{ fake, turns }` at globalThis.__caps[config.key]: every turn's inputs
 * (text, and whether it is a native command), in order. A turn answers `echo: <text>`.
 */
export function createHarness(init) {
  const c = init.config ?? {};
  const turns = [];
  const fake = new FakeHarness(async (t) => {
    const inputs = t.inputs.map((i) => ({ text: i.content.map((b) => (b.type === 'text' ? b.text : '')).join(''), native: i.channelContext.nativeCommand === true }));
    turns.push(inputs);
    t.emit({ t: 'text.snapshot', text: `echo: ${inputs.map((i) => i.text).join(' ')}`, final: true }, { audience: 'answer' });
  });
  (globalThis.__caps ??= {})[c.key] = { fake, turns };
  const adapter = { id: 'caps', probe: () => fake.probe(), open: (args) => fake.open(args) };
  for (const k of ['displayName', 'modes', 'ownerProfileSwitch', 'ephemeralOpen']) if (c[k] !== undefined) adapter[k] = c[k];
  if (c.compact !== undefined) adapter.compact = { command: c.compact };
  return adapter;
}
