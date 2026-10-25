import type { ChannelAdapter, InboundEnvelope, ReplyRoute, TestFault, TestFaultResult } from '@agents-io/protocol';
import type { LogFn } from './gateway.js';

/*
 * Test hooks (HOSTS §4.3, INVARIANTS SE-6): the two transport primitives fault injection
 * needs, `test.replay` (a platform redelivering a message) and `test.fault drop-response`
 * (a send whose response is lost). Off unless the daemon process was started with
 * AIO_TEST_HOOKS=1 (never from the config file, so a deployment's config cannot turn
 * them on); then reachable only over the host protocol (the host token), and every use
 * is logged at warn. Everything here is in memory and gone on restart.
 */

/** The environment variable that turns the test hooks on; only the exact value `1` does. */
export const TEST_HOOKS_ENV = 'AIO_TEST_HOOKS';

/** Test hooks are on in this environment (`AIO_TEST_HOOKS=1` exactly). */
export function testHooksFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env[TEST_HOOKS_ENV] === '1';
}

/** A channel message kept for `test.replay`: as the channel emitted it, before stamping. */
export interface KeptEnvelope {
  env: InboundEnvelope;
  at: number;
}

export interface TestHooksOptions {
  log: LogFn;
  /** How many accepted envelopes are kept (oldest go first; default 256). */
  maxKept?: number;
  /** How long one is kept (default 2 h). */
  keepMs?: number;
  now?: () => number;
}

export const MAX_REPLAY_TIMES = 10;
export const MAX_DROP_NEXT = 100;

type Fault = TestFaultResult['faults'][number];

export class TestHooks {
  private readonly kept = new Map<string, KeptEnvelope>();
  private faults: Fault[] = [];
  /** Adapters whose `send` is wrapped already (one adapter may serve several accounts). */
  private readonly wrapped = new WeakSet<ChannelAdapter>();
  private readonly now: () => number;

  constructor(private readonly o: TestHooksOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Keep a channel message the gateway accepted (first time only) under the input id it became. */
  keep(inputId: string, env: InboundEnvelope): void {
    const now = this.now();
    this.prune(now);
    this.kept.delete(inputId);
    this.kept.set(inputId, { env, at: now });
    const max = this.o.maxKept ?? 256;
    while (this.kept.size > max) this.kept.delete(this.kept.keys().next().value!);
  }

  /** The kept message that became `inputId`, if it is still kept. */
  find(inputId: string): KeptEnvelope | undefined {
    this.prune(this.now());
    return this.kept.get(inputId);
  }

  private prune(now: number): void {
    const keep = this.o.keepMs ?? 2 * 3_600_000;
    for (const [id, k] of this.kept) {
      if (now - k.at <= keep) break;
      this.kept.delete(id);
    }
  }

  /** Apply a `test.fault` action; the error message when the frame is not valid. */
  fault(f: Pick<TestFault, 'action' | 'channel' | 'account' | 'conversation' | 'next'>): { ok: true; value: TestFaultResult } | { ok: false; message: string } {
    if (f.action === 'clear') {
      if (this.faults.length) this.o.log('warn', `test hook: fault injections cleared (${this.faults.map(faultView).join('; ')})`);
      this.faults = [];
    } else if (f.action === 'drop-response') {
      if (!f.channel) return { ok: false, message: 'drop-response needs a channel' };
      const next = f.next ?? 1;
      if (!Number.isInteger(next) || next < 1 || next > MAX_DROP_NEXT) return { ok: false, message: `next must be an integer from 1 to ${MAX_DROP_NEXT}` };
      const fault: Fault = {
        kind: 'drop-response',
        channel: f.channel,
        ...(f.account ? { account: f.account } : {}),
        ...(f.conversation ? { conversation: f.conversation } : {}),
        remaining: next,
        at: this.now(),
      };
      this.faults.push(fault);
      this.o.log('warn', `test hook: the next ${next} send(s) through ${faultView(fault)} go out and their responses are dropped (settled unknown on the attempt timeout)`);
    }
    return { ok: true, value: { faults: this.faults.map((x) => ({ ...x })) } };
  }

  /** Take one drop for a send to `route` (the first matching injection), if any. */
  takeDrop(route: Pick<ReplyRoute, 'channel' | 'account' | 'conversationId'>): Fault | undefined {
    const i = this.faults.findIndex(
      (x) =>
        x.channel === route.channel &&
        (x.account === undefined || x.account === route.account) &&
        (x.conversation === undefined || x.conversation === route.conversationId),
    );
    if (i < 0) return undefined;
    const f = this.faults[i]!;
    f.remaining -= 1;
    if (f.remaining <= 0) this.faults.splice(i, 1);
    return f;
  }

  /**
   * Wrap `adapter.send` so a matching `drop-response` injection applies: the platform call
   * goes out as usual, then its response is thrown away and the attempt never answers (the
   * outbox times it out as `unknown`, DL-1). Without an injection the send is unchanged.
   */
  wrap(adapter: ChannelAdapter): void {
    if (this.wrapped.has(adapter)) return;
    if (Object.isFrozen(adapter)) {
      this.o.log('warn', `test hook: channel ${adapter.id}'s adapter is frozen; drop-response cannot apply to it`);
      return;
    }
    const send = adapter.send.bind(adapter);
    adapter.send = async (route, msg, op) => {
      const drop = this.takeDrop(route);
      if (!drop) return send(route, msg, op);
      const sent = await send(route, msg, op).then(
        (r) => `sent${r?.providerMessageId ? ` (${r.providerMessageId})` : ''}`,
        (e: Error) => `failed (${e.message})`,
      );
      this.o.log('warn', `test hook: ${op.operationId} to ${route.channel}/${route.account}: ${sent}; response dropped, the attempt is left to time out`);
      return new Promise<never>(() => undefined);
    };
    this.wrapped.add(adapter);
  }
}

function faultView(f: Fault): string {
  return `${f.channel}${f.account ? `/${f.account}` : ''}${f.conversation ? ` conversation ${f.conversation}` : ''} (${f.remaining} left)`;
}
