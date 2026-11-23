import { FakeHarness } from '@agents-io/testkit';

/** Binds native session `n1`. A turn on "long …" runs until interrupted; any other ends at once. */
async function script(t) {
  t.emit({ t: 'session.bound', nativeId: 'n1' });
  const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
  if (text.startsWith('long')) await new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  t.emit({ t: 'text.snapshot', text: `echo: ${text}`, final: true }, { audience: 'answer' });
}

/**
 * A module harness with the lifecycle members its `config` asks for (`detach`, `dispose`,
 * `adopts`). Each factory call (each daemon start) appends `{ fake, calls }` to
 * globalThis.__lifecycle[config.key].
 */
export function createHarness(init) {
  const c = init.config ?? {};
  const fake = new FakeHarness(script);
  const rec = { fake, calls: [] };
  ((globalThis.__lifecycle ??= {})[c.key] ??= []).push(rec);
  const adapter = { id: 'lifecycle', probe: () => fake.probe(), open: (args) => fake.open(args) };
  if (c.detach) adapter.detach = async () => void rec.calls.push('detach');
  if (c.dispose) adapter.dispose = async () => void rec.calls.push('dispose');
  if (c.adopts) adapter.adopts = true;
  return adapter;
}
