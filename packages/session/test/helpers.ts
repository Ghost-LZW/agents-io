import {
  AsyncQueue,
  FakeHarness,
  FakeHarnessSession,
  fakeHarnessCaps,
  type FakeTurnScript,
} from '@agents-io/testkit';
import type {
  Body,
  Decision,
  HarnessAdapter,
  HarnessCaps,
  HarnessEvent,
  HarnessOpenArgs,
  HarnessSession,
  InputRecord,
  Origin,
  ReplyRoute,
  RunSpec,
  SessionEvent,
  SteerResult,
} from '@agents-io/protocol';
import { Hub, Lane, MemorySessionLog, defaultPolicy, type EventDraft, type LaneOptions, type SessionPolicy } from '../src/index.js';

export const draft = (body: Body, extra: Partial<EventDraft> = {}): EventDraft => ({
  ts: 1,
  level: 'primary',
  audience: 'status',
  durability: 'durable',
  ...extra,
  body,
});

export const RUN = { harness: 'fake', model: 'm' };

export const route = (conversationId = 'c1', channel = 'fake'): ReplyRoute => ({ channel, account: 'default', conversationId });

export function origin(principal: string | null, labels: string[] = ['owner'], kind: Origin['kind'] = 'human'): Origin {
  return {
    kind,
    principal: principal === null ? null : { id: principal, labels },
    evidence: 'platform_signed',
    via: 'fake:default:c1',
    adapter: 'fake',
  };
}

let n = 0;
export function input(text: string, o: { principal?: string | null; labels?: string[]; route?: ReplyRoute | null; id?: string } = {}): InputRecord {
  return {
    inputId: o.id ?? `in${++n}`,
    origin: origin(o.principal === undefined ? 'fake:alice' : o.principal, o.labels),
    content: [{ type: 'text', text }],
    replyRoute: o.route === undefined ? route() : o.route,
    channelContext: {},
  };
}

/** Owners alice and bob; plan uses the fake harness. */
export function policy(extra: Partial<SessionPolicy> = {}): SessionPolicy {
  return { ...defaultPolicy({ owners: ['fake:alice', 'fake:bob'], run: RUN }), ...extra };
}

export function setup(o: Partial<LaneOptions> & { harness?: HarnessAdapter } = {}) {
  const log = new MemorySessionLog();
  const hub = new Hub(log);
  const raw: HarnessEvent[] = [];
  const lane = new Lane({
    sessionKey: 's1',
    harness: o.harness ?? new FakeHarness(),
    hub,
    policy: policy(),
    thinkingHeadline: null,
    ...o,
    onHarnessEvent: (e) => {
      raw.push(e);
      o.onHarnessEvent?.(e);
    },
  });
  const events = () => log.read('s1', 0);
  return { log, hub, lane, raw, events };
}

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

export const bodies = (evs: SessionEvent[], t?: string) => evs.map((e) => e.body).filter((b) => !t || b.t === t);

export function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { promise: p, open };
}

const iterators = new WeakMap<object, AsyncIterator<unknown>>();

/** Pull `count` items without closing the iterable (unlike breaking out of `for await`). */
export async function take<T>(it: AsyncIterable<T>, count: number, ms = 2000): Promise<T[]> {
  let iter = iterators.get(it) as AsyncIterator<T> | undefined;
  if (!iter) iterators.set(it, (iter = it[Symbol.asyncIterator]()));
  const out: T[] = [];
  while (out.length < count) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      iter.next(),
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`take: got ${out.length}/${count}`)), ms))),
    ]).finally(() => clearTimeout(timer));
    if (r.done) throw new Error(`take: iterable ended after ${out.length}/${count}`);
    out.push(r.value);
  }
  return out;
}

// ---- harnesses ------------------------------------------------------------

/** FakeHarness whose sessions accept steers into the active turn. */
export class SteerableHarness extends FakeHarness {
  constructor(
    private readonly turnScript: FakeTurnScript,
    private readonly caps: HarnessCaps = { ...fakeHarnessCaps, steer: 'native' },
  ) {
    super(turnScript);
  }
  override async probe() {
    return { version: '0.0.0', caps: this.caps };
  }
  override async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    const s = new SteerableSession(args, this.turnScript);
    this.sessions.push(s);
    return s;
  }
}

export class SteerableSession extends FakeHarnessSession {
  current: { turnId: string; inputs: InputRecord[] } | undefined;
  steerResult: SteerResult = 'steered';
  override async startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void> {
    // The base class reads `inputs` again when the turn ends, so steered inputs pushed here are reported consumed.
    this.current = { turnId, inputs };
    return super.startTurn(turnId, inputs, run);
  }
  // Optional params: testkit declares FakeHarnessSession.steer() with none.
  override async steer(inputs: InputRecord[] = [], expectedTurnId?: string): Promise<SteerResult> {
    if (this.steerResult !== 'steered') return this.steerResult;
    if (!this.current || this.current.turnId !== expectedTurnId) return 'stale';
    this.current.inputs.push(...inputs);
    return 'steered';
  }
}

/** A harness driven entirely by the test: it records calls and emits what the test pushes. */
export class ManualHarness implements HarnessAdapter {
  readonly id = 'manual';
  session: ManualSession | undefined;
  constructor(readonly caps: HarnessCaps = fakeHarnessCaps) {}
  async probe() {
    return { version: '0', caps: this.caps };
  }
  async open(args: HarnessOpenArgs) {
    this.session = new ManualSession(args);
    return this.session;
  }
}

export class ManualSession implements HarnessSession {
  readonly q = new AsyncQueue<HarnessEvent>();
  readonly events = this.q;
  readonly starts: { turnId: string; inputs: InputRecord[]; run?: RunSpec }[] = [];
  readonly responses: { requestId: string; decision: Decision }[] = [];
  readonly interrupts: string[] = [];
  constructor(readonly args: HarnessOpenArgs) {}
  nativeId() {
    return 'manual-1';
  }
  push(body: HarnessEvent['body'], extra: Partial<HarnessEvent> = {}) {
    this.q.push({ ts: Date.now(), level: 'primary', audience: 'status', durability: 'durable', ...extra, body });
  }
  async startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec) {
    this.starts.push({ turnId, inputs, ...(run ? { run } : {}) });
    this.push({ t: 'turn.started', turnId, inputIds: inputs.map((i) => i.inputId), replyRoute: inputs[0]?.replyRoute ?? null, run: run ?? this.args.run }, { turnId });
  }
  async steer(): Promise<SteerResult> {
    return 'unsupported';
  }
  async interrupt(turnId: string) {
    this.interrupts.push(turnId);
  }
  async respond(requestId: string, decision: Decision) {
    this.responses.push({ requestId, decision });
  }
  async close() {
    this.q.close();
  }
  /** Finish the current turn, reporting only `consumed` as consumed. */
  complete(turnId: string, consumed: string[], status: 'completed' | 'interrupted' | 'failed' = 'completed') {
    if (consumed.length) this.push({ t: 'input.consumed', inputIds: consumed, turnId }, { turnId });
    this.push({ t: 'turn.completed', turnId, status }, { turnId });
  }
}
