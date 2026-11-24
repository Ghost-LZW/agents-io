import { HARNESS_DECLARATION_KEYS, HarnessCaps, HarnessDeclares, STEER_RESULTS, errors, type HarnessAdapter, type HarnessEvent, type HarnessOpenArgs, type HarnessSession, type InputRecord } from '@agents-io/protocol';
import type { ConformanceReport } from './channel-conformance.js';
import { checkEventStream } from './event-stream.js';

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

export interface HarnessSuiteDriver {
  /** The adapter under test: in-process, or a bridged program (`@agents-io/harness-jsonl-bridge` `spawnHarness`). */
  adapter: HarnessAdapter;
  /** Open args for the session under test. */
  open: HarnessOpenArgs;
  /** A turn the harness completes by itself. Default: one text input. */
  turn?: { turnId: string; inputs: InputRecord[] };
  /** A turn that runs until interrupted, to check `interrupt`. Optional: skipped without it. */
  longTurn?: { turnId: string; inputs: InputRecord[] };
  timeoutMs?: number;
}


/** A text input of the conformance suite. */
export function conformanceInput(inputId: string, text: string): InputRecord {
  return { inputId, origin: { kind: 'human', principal: null, evidence: 'none', via: 'conformance', adapter: 'conformance' }, content: [{ type: 'text', text }], replyRoute: null, channelContext: {} };
}

/**
 * The checks every harness adapter must pass, in process or bridged alike (INVARIANTS HC-1):
 * `probe` answers a version and caps of the schema; the static declarations are of the types
 * `HarnessDeclares` says (and `'own-process'` comes with `ownProcess`, `'takeover'` with
 * `takeover`); the optional members are functions; a turn runs to `turn.completed`; the event
 * stream passes `checkEventStream`; `steer` answers a `SteerResult`; `interrupt` ends a running
 * turn as interrupted (with `longTurn`); `close` ends the event stream. Checks that need a missing
 * driver hook are listed in `passed` with a `(skipped)` suffix.
 */
export async function runHarnessConformance(driver: HarnessSuiteDriver): Promise<ConformanceReport> {
  const report: ConformanceReport = { passed: [], failed: [] };
  const ok = (c: string) => report.passed.push(c);
  const fail = (c: string, m: string) => report.failed.push({ check: c, message: m });
  const { adapter } = driver;
  const timeout = driver.timeoutMs ?? 5000;

  try {
    const p = await adapter.probe();
    const errs = [...(typeof p.version === 'string' ? [] : ['/version: not a string']), ...errors(HarnessCaps, p.caps)];
    errs.length ? fail('probe.schema', errs.join('; ')) : ok('probe.schema');
  } catch (err) {
    fail('probe.schema', String(err));
    return report;
  }

  const a = adapter as unknown as Record<string, unknown>;
  const declared = Object.fromEntries(HARNESS_DECLARATION_KEYS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
  const declErrs = errors(HarnessDeclares, declared);
  if (a.sessionEnv === 'own-process' && typeof a.ownProcess !== 'function') declErrs.push("/sessionEnv: 'own-process' needs ownProcess");
  if (a.attach === 'takeover' && typeof a.takeover !== 'function') declErrs.push("/attach: 'takeover' needs takeover");
  declErrs.length ? fail('declares.schema', declErrs.join('; ')) : ok('declares.schema');
  const notFn = ['detach', 'dispose', 'ownProcess', 'nativeClient', 'takeover'].filter((k) => a[k] !== undefined && typeof a[k] !== 'function');
  notFn.length ? fail('methods.functions', `not functions: ${notFn.join(', ')}`) : ok('methods.functions');

  let session: HarnessSession;
  try {
    session = await adapter.open(driver.open);
    ok('open');
  } catch (err) {
    fail('open', String(err));
    return report;
  }
  const events: HarnessEvent[] = [];
  const waiters: (() => void)[] = [];
  const drained = (async () => {
    for await (const e of session.events) {
      events.push(e);
      waiters.splice(0).forEach((w) => w());
    }
  })().catch((err: unknown) => fail('events.iterate', String(err)));
  const seen = async (pred: (e: HarnessEvent) => boolean): Promise<boolean> => {
    const deadline = Date.now() + timeout;
    while (!events.some(pred)) {
      if (Date.now() > deadline) return false;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 25);
      });
    }
    return true;
  };
  const turnInputs: Record<string, string[]> = {};

  try {
    const turn = driver.turn ?? { turnId: 'conformance-t1', inputs: [conformanceInput('conformance-i1', 'conformance: hello')] };
    turnInputs[turn.turnId] = turn.inputs.map((i) => i.inputId);
    await session.startTurn(turn.turnId, turn.inputs, driver.open.run);
    (await seen((e) => e.body.t === 'turn.completed' && e.body.turnId === turn.turnId)) ? ok('turn.completes') : fail('turn.completes', `no turn.completed for ${turn.turnId} within ${timeout}ms`);

    const steered = await session.steer([conformanceInput('conformance-steer', 'late')], 'conformance-no-such-turn');
    STEER_RESULTS.includes(steered) ? ok('steer.result') : fail('steer.result', `steer answered ${JSON.stringify(steered)}`);

    if (driver.longTurn) {
      const long = driver.longTurn;
      turnInputs[long.turnId] = long.inputs.map((i) => i.inputId);
      await session.startTurn(long.turnId, long.inputs, driver.open.run);
      if (!(await seen((e) => e.body.t === 'turn.started' && e.body.turnId === long.turnId))) fail('interrupt.ends_turn', `no turn.started for ${long.turnId}`);
      else {
        await session.interrupt(long.turnId);
        const done = await seen((e) => e.body.t === 'turn.completed' && e.body.turnId === long.turnId);
        const status = events.map((e) => e.body).find((b) => b.t === 'turn.completed' && b.turnId === long.turnId);
        !done ? fail('interrupt.ends_turn', `${long.turnId} did not end after interrupt`) : (status as { status?: string }).status === 'interrupted' ? ok('interrupt.ends_turn') : fail('interrupt.ends_turn', `${long.turnId} ended ${(status as { status?: string }).status}`);
      }
    } else ok('interrupt.ends_turn (skipped)');
  } catch (err) {
    fail('unexpected', err instanceof Error ? (err.stack ?? err.message) : String(err));
  }

  await session.close('conformance').catch((err: unknown) => fail('close', String(err)));
  const ended = await Promise.race([drained.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), timeout))]);
  ended ? ok('close.ends_stream') : fail('close.ends_stream', `events did not end within ${timeout}ms of close`);

  const violations = checkEventStream(events, { turnInputs });
  violations.length ? fail('stream.conforms', violations.map((v) => `#${v.index} [${v.rule}] ${v.message}`).join('; ')) : ok('stream.conforms');
  return report;
}
