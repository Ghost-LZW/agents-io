import type { HarnessAdapter, HarnessEvent, HarnessOpenArgs, InputRecord } from '@agents-io/protocol';
import type { ConformanceReport } from './channel-conformance.js';

export interface HarnessConformanceDriver {
  adapter: HarnessAdapter;
  /** Open args for the session under test; `env` is set by the check. */
  open: Omit<HarnessOpenArgs, 'env'>;
  /** What the adapter's last spawn got: the child environment and the argv it was started with. */
  lastSpawn(): { env: Record<string, string | undefined>; argv: string[] };
  /** Starts a turn with this input after open (some adapters only spawn or emit then). Optional. */
  turn?: { turnId: string; inputs: InputRecord[] };
  /** Let the fake platform finish whatever was started, so the event stream can end. Optional. */
  settle?(): Promise<void>;
  timeoutMs?: number;
}

/**
 * POSITIONING 6.2: a per-session `env` reaches the child process environment and nothing
 * else. Opens a session with a unique secret value in `env`, then asserts the value is in
 * the child env, and absent from argv and from every serialized event.
 */
export async function runHarnessEnvConformance(driver: HarnessConformanceDriver): Promise<ConformanceReport> {
  const report: ConformanceReport = { passed: [], failed: [] };
  const ok = (c: string) => report.passed.push(c);
  const fail = (c: string, m: string) => report.failed.push({ check: c, message: m });
  const key = 'AGENTS_IO_CONFORMANCE_KEY';
  const secret = `secret-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  let session;
  try {
    session = await driver.adapter.open({ ...driver.open, env: { [key]: secret } });
  } catch (err) {
    fail('env.open', String(err));
    return report;
  }
  const events: HarnessEvent[] = [];
  const drain = (async () => {
    for await (const e of session.events) events.push(e);
  })().catch(() => {});

  try {
    if (driver.turn) await session.startTurn(driver.turn.turnId, driver.turn.inputs);
    await driver.settle?.();
  } catch (err) {
    fail('env.turn', String(err));
  }
  await session.close('conformance').catch(() => {});
  await Promise.race([drain, new Promise((r) => setTimeout(r, driver.timeoutMs ?? 5000))]);

  const spawn = driver.lastSpawn();
  spawn.env[key] === secret ? ok('env.in_child_env') : fail('env.in_child_env', `${key} missing or changed in the child env`);
  spawn.argv.some((a) => a.includes(secret)) ? fail('env.not_in_argv', 'value found in argv') : ok('env.not_in_argv');
  events.some((e) => JSON.stringify(e).includes(secret)) ? fail('env.not_in_events', 'value found in an emitted event') : ok('env.not_in_events');
  return report;
}
