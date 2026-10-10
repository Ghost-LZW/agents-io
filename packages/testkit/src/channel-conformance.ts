import {
  ChannelCaps,
  InboundEnvelope,
  errors,
  type ChannelAdapter,
  type ReplyRoute,
  type RenderedMessage,
} from '@agents-io/protocol';

export interface ChannelConformanceDriver {
  adapter: ChannelAdapter;
  account: string;
  config?: unknown;
  /** Make the (fake or sandbox) platform deliver one inbound message to the adapter. */
  triggerInbound?(): Promise<void>;
  /** A route the adapter can send to. Required to test outbound. */
  route?: ReplyRoute;
  /** Read back what the platform received, for idempotency checks. Return platform message ids. */
  platformMessages?(): Promise<string[]>;
  timeoutMs?: number;
}

export interface ConformanceReport {
  passed: string[];
  failed: { check: string; message: string }[];
}

/**
 * Runs the checks every channel adapter must pass. Platform-specific behaviour is
 * driven through `driver`; checks that need a missing driver hook are skipped,
 * and listed as skipped in `passed` with a `(skipped)` suffix.
 */
export async function runChannelConformance(driver: ChannelConformanceDriver): Promise<ConformanceReport> {
  const report: ConformanceReport = { passed: [], failed: [] };
  const ok = (c: string) => report.passed.push(c);
  const fail = (c: string, m: string) => report.failed.push({ check: c, message: m });
  const { adapter } = driver;
  const timeout = driver.timeoutMs ?? 5000;

  const capsErr = errors(ChannelCaps, adapter.caps(driver.account));
  capsErr.length ? fail('caps.schema', capsErr.join('; ')) : ok('caps.schema');

  const emitted: unknown[] = [];
  let resolveFirst: () => void = () => {};
  const first = new Promise<void>((r) => (resolveFirst = r));
  const ctl = new AbortController();
  const logs: string[] = [];
  const started = adapter
    .start({
      account: driver.account,
      config: driver.config,
      signal: ctl.signal,
      emit: async (env) => {
        emitted.push(env);
        resolveFirst();
        return { accepted: true, inputId: `in-${emitted.length}` };
      },
      log: (level, msg) => logs.push(`${level}: ${msg}`),
    })
    .catch((err: unknown) => fail('start.no_throw', String(err)));

  try {
    if (driver.triggerInbound) {
      await driver.triggerInbound();
      const got = await Promise.race([first.then(() => true), sleep(timeout).then(() => false)]);
      if (!got) fail('inbound.emit', `no envelope within ${timeout}ms`);
      else {
        ok('inbound.emit');
        const env = emitted[0];
        const errs = errors(InboundEnvelope, env);
        errs.length ? fail('inbound.schema', errs.join('; ')) : ok('inbound.schema');
        const e = env as InboundEnvelope;
        e.channel === adapter.id ? ok('inbound.channel_id') : fail('inbound.channel_id', `channel ${e.channel} != adapter ${adapter.id}`);
        e.account === driver.account ? ok('inbound.account') : fail('inbound.account', `account ${e.account} != ${driver.account}`);
        // The daemon caps anything else to `none` (channel-stamping): claim only what caps say.
        const ev = adapter.caps(driver.account).evidence;
        e.sender?.evidence === 'none' || ev.includes(e.sender?.evidence) ? ok('inbound.evidence_in_caps') : fail('inbound.evidence_in_caps', `evidence ${e.sender?.evidence} not in caps.evidence [${ev.join(', ')}]`);
      }
    } else ok('inbound (skipped)');

    if (driver.route) {
      const msg: RenderedMessage = { text: 'conformance: hello' };
      const op = { operationId: 'conformance-op-1', as: 'conformance/agent' };
      const a = await adapter.send(driver.route, msg, op);
      const b = await adapter.send(driver.route, msg, op);
      ok('outbound.send');
      if (a.providerMessageId && b.providerMessageId && a.providerMessageId !== b.providerMessageId)
        fail('outbound.idempotent', `same operationId produced ${a.providerMessageId} and ${b.providerMessageId}`);
      else ok('outbound.idempotent');
      if (driver.platformMessages) {
        const ids = await driver.platformMessages();
        ids.length === 1 ? ok('outbound.platform_once') : fail('outbound.platform_once', `platform received ${ids.length} messages`);
      }
      if (adapter.caps(driver.account).edit) {
        if (!adapter.edit) fail('outbound.edit', 'caps.edit is true but edit() is missing');
        else if (a.providerMessageId) {
          await adapter.edit(driver.route, a.providerMessageId, { text: 'conformance: edited' }, { operationId: 'conformance-op-2', sequence: 1 });
          ok('outbound.edit');
        }
      }
    } else ok('outbound (skipped)');
  } catch (err) {
    fail('unexpected', err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    ctl.abort();
    await Promise.race([started, sleep(timeout)]);
  }
  return report;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
