import { Type, type Static } from '@sinclair/typebox';
import { ReplyRoute, V } from './common.js';
import { InboundEnvelope, InputRecord } from './inbound.js';
import { ChannelCaps, RenderedMessage, SendOp } from './channel.js';
import { HarnessCaps, RunSpec } from './run.js';
import { Decision } from './requests.js';
import { HarnessEvent } from './events.js';

/*
 * Out-of-process adapters speak newline-delimited JSON over stdio (or any byte
 * stream). One JSON object per line. Requests carry `id`; the peer answers with a
 * `result` frame carrying the same `id`. Unknown frame types must be ignored, and
 * unknown fields preserved, so either side can be newer.
 */

const Req = <K extends string>(type: K) => ({ v: V, type: Type.Literal(type), id: Type.String() });

export const ResultFrame = Type.Object({
  v: V,
  type: Type.Literal('result'),
  id: Type.String(),
  ok: Type.Boolean(),
  value: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String(), retryable: Type.Optional(Type.Boolean()) })),
});
export type ResultFrame = Static<typeof ResultFrame>;

export const LogFrame = Type.Object({
  v: V,
  type: Type.Literal('log'),
  /**
   * `fatal`: the adapter has given up (e.g. start failed). The host treats it as the peer
   * being dead: it kills the process/connection and restarts it with backoff.
   */
  level: Type.Union([Type.Literal('debug'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error'), Type.Literal('fatal')]),
  msg: Type.String(),
  data: Type.Optional(Type.Unknown()),
});

// ---- Channel bridge -------------------------------------------------------

/** Host → channel adapter process. */
export const ChannelHostFrame = Type.Union([
  Type.Object({ ...Req('hello'), account: Type.String(), config: Type.Optional(Type.Unknown()) }),
  Type.Object({ ...Req('send'), route: ReplyRoute, msg: RenderedMessage, op: SendOp }),
  Type.Object({
    ...Req('edit'),
    route: ReplyRoute,
    providerMessageId: Type.String(),
    msg: RenderedMessage,
    op: Type.Composite([SendOp, Type.Object({ sequence: Type.Number() })]),
  }),
  Type.Object({ ...Req('finalize'), route: ReplyRoute, providerMessageId: Type.String(), msg: RenderedMessage }),
  Type.Object({ ...Req('retract'), route: ReplyRoute, providerMessageId: Type.String(), outcome: Type.String() }),
  Type.Object({
    ...Req('speak'),
    route: ReplyRoute,
    utterance: Type.Object({ text: Type.String(), interruptible: Type.Boolean() }),
  }),
  Type.Object({ ...Req('typing'), route: ReplyRoute, on: Type.Boolean() }),
  Type.Object({ ...Req('reconcile'), route: ReplyRoute, providerMessageId: Type.String() }),
  /** Answer to an `inbound` frame. */
  ResultFrame,
  Type.Object({ v: V, type: Type.Literal('shutdown') }),
]);
export type ChannelHostFrame = Static<typeof ChannelHostFrame>;

/** Channel adapter process → host. */
export const ChannelAdapterFrame = Type.Union([
  /** Answer to `hello`: value is `{ adapterId, caps, methods }`. Sent as a result frame. */
  ResultFrame,
  /** One inbound message; the host answers with a result `{ accepted, inputId? }`. */
  Type.Object({ ...Req('inbound'), envelope: InboundEnvelope }),
  LogFrame,
]);
export type ChannelAdapterFrame = Static<typeof ChannelAdapterFrame>;

/** Caps are fixed per connection; a restarted adapter process may announce new ones in its next hello. */
export const ChannelHello = Type.Object({
  adapterId: Type.String(),
  caps: ChannelCaps,
  /**
   * Optional methods this adapter implements beyond `send`: edit, finalize, retract, speak,
   * typing, reconcile. Open-ended so a newer adapter can name methods an older host ignores.
   */
  methods: Type.Array(Type.String()),
});
export type ChannelHello = Static<typeof ChannelHello>;

// ---- Harness bridge -------------------------------------------------------

/** Host → harness adapter process. */
export const HarnessHostFrame = Type.Union([
  Type.Object({ ...Req('probe') }),
  Type.Object({
    ...Req('open'),
    sessionKey: Type.String(),
    generation: Type.Number(),
    cwd: Type.String(),
    resume: Type.Optional(Type.String()),
    run: RunSpec,
    mcp: Type.Optional(Type.Object({ url: Type.String(), token: Type.String() })),
    options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** Extra child-process environment for this session (`HarnessOpenArgs.env`). */
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
  Type.Object({
    ...Req('startTurn'),
    sessionKey: Type.String(),
    turnId: Type.String(),
    inputs: Type.Array(InputRecord),
    run: Type.Optional(RunSpec),
  }),
  Type.Object({ ...Req('steer'), sessionKey: Type.String(), inputs: Type.Array(InputRecord), expectedTurnId: Type.String() }),
  Type.Object({ ...Req('cancelQueued'), sessionKey: Type.String(), inputIds: Type.Array(Type.String()) }),
  Type.Object({ ...Req('interrupt'), sessionKey: Type.String(), turnId: Type.String() }),
  Type.Object({ ...Req('respond'), sessionKey: Type.String(), requestId: Type.String(), decision: Decision }),
  Type.Object({ ...Req('close'), sessionKey: Type.String(), reason: Type.String() }),
  Type.Object({ v: V, type: Type.Literal('shutdown') }),
]);
export type HarnessHostFrame = Static<typeof HarnessHostFrame>;

/** Harness adapter process → host. */
export const HarnessAdapterFrame = Type.Union([
  ResultFrame,
  Type.Object({
    v: V,
    type: Type.Literal('event'),
    sessionKey: Type.String(),
    generation: Type.Number(),
    event: HarnessEvent,
  }),
  Type.Object({ v: V, type: Type.Literal('nativeId'), sessionKey: Type.String(), nativeId: Type.String() }),
  LogFrame,
]);
export type HarnessAdapterFrame = Static<typeof HarnessAdapterFrame>;

export const ProbeResult = Type.Object({ version: Type.String(), caps: HarnessCaps });

/** Frame types each side may send. Anything else must be ignored by the receiver. */
export const CHANNEL_HOST_FRAME_TYPES = ['hello', 'send', 'edit', 'finalize', 'retract', 'speak', 'typing', 'reconcile', 'result', 'shutdown'] as const;
export const CHANNEL_ADAPTER_FRAME_TYPES = ['result', 'inbound', 'log'] as const;
export const HARNESS_HOST_FRAME_TYPES = ['probe', 'open', 'startTurn', 'steer', 'cancelQueued', 'interrupt', 'respond', 'close', 'shutdown'] as const;
export const HARNESS_ADAPTER_FRAME_TYPES = ['result', 'event', 'nativeId', 'log'] as const;

/**
 * Error thrown by adapter methods. `code` and `retryable` travel through
 * `ResultFrame.error` unchanged when the adapter runs out of process.
 */
export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

// ---- JSONL codec ----------------------------------------------------------

export function encodeFrame(frame: unknown): string {
  const line = JSON.stringify(frame);
  if (line.includes('\n')) throw new Error('frame serialization produced a newline');
  return line + '\n';
}

export interface FrameDecoderOptions {
  /** Longest line accepted, in UTF-16 code units. Longer lines are dropped and reported. Default 32Mi. */
  maxLineLength?: number;
}

/**
 * Splits a byte/text stream into JSON frames. Malformed and oversized lines are
 * reported to `onError` and skipped; they never break the stream.
 */
export class FrameDecoder {
  private buf = '';
  /** Where to resume looking for a newline in `buf`; everything before it has none. */
  private scanned = 0;
  /** Inside an oversized line: discard input until its newline. */
  private skipping = false;
  private readonly max: number;
  // One decoder for the whole stream, so multi-byte characters split across chunks survive.
  private readonly text = new TextDecoder();
  constructor(
    private readonly onError: (line: string, err: unknown) => void = () => {},
    opts: FrameDecoderOptions = {},
  ) {
    this.max = opts.maxLineLength ?? 32 * 1024 * 1024;
  }

  push(chunk: string | Uint8Array): unknown[] {
    this.buf += typeof chunk === 'string' ? chunk : this.text.decode(chunk, { stream: true });
    const out: unknown[] = [];
    let start = 0;
    let nl: number;
    while ((nl = this.buf.indexOf('\n', Math.max(start, this.scanned))) >= 0) {
      this.scanned = 0;
      if (this.skipping) this.skipping = false;
      else if (nl - start > this.max) this.tooLong(this.buf.slice(start, start + 200));
      else this.parse(this.buf.slice(start, nl).trim(), out);
      start = nl + 1;
    }
    this.buf = this.buf.slice(start);
    if (this.skipping) this.buf = '';
    else if (this.buf.length > this.max) {
      this.tooLong(this.buf.slice(0, 200));
      this.skipping = true;
      this.buf = '';
    }
    this.scanned = this.buf.length;
    return out;
  }

  private parse(line: string, out: unknown[]): void {
    if (!line) return;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      this.onError(line, err);
    }
  }

  private tooLong(head: string): void {
    this.onError(head, new Error(`line exceeds ${this.max} characters; dropped`));
  }
}
