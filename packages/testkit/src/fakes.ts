import {
  PROTOCOL_VERSION,
  type ChannelAdapter,
  type ChannelCaps,
  type ChannelContext,
  type ContentBlock,
  type Decision,
  type HarnessAdapter,
  type HarnessCaps,
  type HarnessEvent,
  type HarnessOpenArgs,
  type HarnessSession,
  type InboundEnvelope,
  type InputRecord,
  type RenderedMessage,
  type ReplyRoute,
  type RunSpec,
  type SendOp,
  type SteerResult,
} from '@agents-io/protocol';

/** An unbounded async queue usable as an AsyncIterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export const defaultChannelCaps: ChannelCaps = {
  text: { maxChars: 4000, markdown: 'basic' },
  edit: true,
  buttons: true,
  media: { in: ['image', 'file'], out: ['image', 'file'] },
  voiceOut: 'none',
  threads: true,
  approvals: 'buttons',
  defaultTier: 'card',
  evidence: ['platform_signed'],
  declaresSender: true,
};

export interface SentRecord {
  route: ReplyRoute;
  msg: RenderedMessage;
  op: SendOp;
  providerMessageId: string;
  edits: RenderedMessage[];
  finalized: boolean;
}

/** In-memory channel: tests inject inbound messages and inspect what was sent. */
export class FakeChannel implements ChannelAdapter {
  readonly sent: SentRecord[] = [];
  private ctx: ChannelContext | undefined;
  private byOp = new Map<string, SentRecord>();
  private seq = 0;

  constructor(
    readonly id = 'fake',
    private readonly capsValue: ChannelCaps = defaultChannelCaps,
  ) {}

  caps(): ChannelCaps {
    return this.capsValue;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.ctx = ctx;
    await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
    this.ctx = undefined;
  }

  /** Simulate a platform message. Sent messages carrying `op.as` echo back with `declared` when `echo` is true. */
  async inject(partial: Partial<InboundEnvelope> & { text?: string }): Promise<{ accepted: boolean; inputId?: string }> {
    if (!this.ctx) throw new Error('FakeChannel not started');
    return this.ctx.emit(fakeEnvelope({ channel: this.id, account: this.ctx.account, ...partial }));
  }

  async send(route: ReplyRoute, msg: RenderedMessage, op: SendOp) {
    const prior = this.byOp.get(op.operationId);
    if (prior) return { providerMessageId: prior.providerMessageId };
    const rec: SentRecord = { route, msg, op, providerMessageId: `m${++this.seq}`, edits: [], finalized: false };
    this.sent.push(rec);
    this.byOp.set(op.operationId, rec);
    return { providerMessageId: rec.providerMessageId };
  }

  async edit(_route: ReplyRoute, id: string, msg: RenderedMessage) {
    this.find(id).edits.push(msg);
  }

  async finalize(_route: ReplyRoute, id: string, msg: RenderedMessage) {
    const rec = this.find(id);
    rec.edits.push(msg);
    rec.finalized = true;
  }

  private find(id: string): SentRecord {
    const rec = this.sent.find((s) => s.providerMessageId === id);
    if (!rec) throw new Error(`unknown message ${id}`);
    return rec;
  }
}

let envSeq = 0;
export function fakeEnvelope(p: Partial<InboundEnvelope> & { text?: string } = {}): InboundEnvelope {
  const { text, ...rest } = p;
  const channel = rest.channel ?? 'fake';
  const account = rest.account ?? 'default';
  const conversation = rest.conversation ?? { id: 'c1', kind: 'dm' as const };
  const content: ContentBlock[] = rest.content ?? [{ type: 'text', text: text ?? 'hello' }];
  return {
    v: PROTOCOL_VERSION,
    id: rest.id ?? `env-${++envSeq}`,
    channel,
    account,
    conversation,
    sender: rest.sender ?? { channelUserId: 'u1', evidence: 'platform_signed' },
    content,
    replyRoute:
      rest.replyRoute === undefined ? { channel, account, conversationId: conversation.id } : rest.replyRoute,
    ...rest,
  };
}

// ---- Harness --------------------------------------------------------------

export interface FakeTurnApi {
  turnId: string;
  inputs: InputRecord[];
  emit(body: HarnessEvent['body'], extra?: Partial<Omit<HarnessEvent, 'body'>>): void;
  /** Resolves when the host answers `requestId`. */
  waitDecision(requestId: string): Promise<Decision>;
  signal: AbortSignal;
}

/** A turn script: emit events, then return. `turn.started` / `turn.completed` are emitted for you. */
export type FakeTurnScript = (t: FakeTurnApi) => Promise<void>;

export const fakeHarnessCaps: HarnessCaps = {
  steer: 'none',
  interrupt: true,
  approvals: true,
  questions: true,
  tokenDeltas: true,
  cancelQueued: false,
  injectWithoutTurn: false,
  resume: false,
  switchModelMidSession: true,
  switchProfileMidSession: true,
};

/** Scripted harness for testing the session layer. */
export class FakeHarness implements HarnessAdapter {
  readonly sessions: FakeHarnessSession[] = [];
  constructor(
    private readonly script: FakeTurnScript = async (t) => {
      const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
      t.emit({ t: 'text.snapshot', text: `echo: ${text}`, final: true }, { audience: 'answer' });
    },
    readonly id = 'fake',
  ) {}

  async probe() {
    return { version: '0.0.0', caps: fakeHarnessCaps };
  }

  async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    const s = new FakeHarnessSession(args, this.script);
    this.sessions.push(s);
    return s;
  }
}

export class FakeHarnessSession implements HarnessSession {
  readonly queue = new AsyncQueue<HarnessEvent>();
  readonly events: AsyncIterable<HarnessEvent> = this.queue;
  private pending = new Map<string, (d: Decision) => void>();
  private active: { turnId: string; ctl: AbortController } | undefined;

  constructor(
    readonly args: HarnessOpenArgs,
    private readonly script: FakeTurnScript,
  ) {}

  nativeId() {
    return `native-${this.args.sessionKey}`;
  }

  private push(body: HarnessEvent['body'], extra: Partial<Omit<HarnessEvent, 'body'>> = {}) {
    this.queue.push({
      ts: Date.now(),
      level: 'primary',
      audience: 'status',
      durability: 'durable',
      ...extra,
      body,
    });
  }

  async startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void> {
    if (this.active) throw new Error('turn already active');
    const ctl = new AbortController();
    this.active = { turnId, ctl };
    this.push({ t: 'turn.started', turnId, inputIds: inputs.map((i) => i.inputId), replyRoute: inputs[0]?.replyRoute ?? null, run: run ?? this.args.run }, { turnId });
    void (async () => {
      let status: 'completed' | 'interrupted' | 'failed' = 'completed';
      try {
        await this.script({
          turnId,
          inputs,
          signal: ctl.signal,
          emit: (body, extra) => {
            if (!ctl.signal.aborted) this.push(body, { turnId, ...extra });
          },
          waitDecision: (requestId) =>
            new Promise<Decision>((resolve, reject) => {
              this.pending.set(requestId, resolve);
              ctl.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
            }),
        });
      } catch {
        status = ctl.signal.aborted ? 'interrupted' : 'failed';
      }
      if (ctl.signal.aborted) status = 'interrupted';
      this.push({ t: 'input.consumed', inputIds: inputs.map((i) => i.inputId), turnId }, { turnId });
      this.push({ t: 'turn.completed', turnId, status }, { turnId });
      this.active = undefined;
    })();
  }

  async steer(_inputs: InputRecord[], _expectedTurnId: string): Promise<SteerResult> {
    return 'unsupported';
  }

  async interrupt(turnId: string): Promise<void> {
    if (this.active?.turnId === turnId) this.active.ctl.abort();
  }

  async respond(requestId: string, decision: Decision): Promise<void> {
    const r = this.pending.get(requestId);
    this.pending.delete(requestId);
    r?.(decision);
  }

  async close(): Promise<void> {
    this.active?.ctl.abort();
    this.queue.close();
  }
}
