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
  level: Type.Union([Type.Literal('debug'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')]),
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

export const ChannelHello = Type.Object({
  adapterId: Type.String(),
  caps: ChannelCaps,
  /** Optional methods this adapter implements beyond `send`. */
  methods: Type.Array(
    Type.Union([
      Type.Literal('edit'),
      Type.Literal('finalize'),
      Type.Literal('retract'),
      Type.Literal('speak'),
      Type.Literal('typing'),
      Type.Literal('reconcile'),
    ]),
  ),
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

/**
 * Splits a byte/text stream into JSON frames. Malformed lines are reported to
 * `onError` and skipped; they never break the stream.
 */
export class FrameDecoder {
  private buf = '';
  // One decoder for the whole stream, so multi-byte characters split across chunks survive.
  private readonly text = new TextDecoder();
  constructor(private readonly onError: (line: string, err: unknown) => void = () => {}) {}

  push(chunk: string | Uint8Array): unknown[] {
    this.buf += typeof chunk === 'string' ? chunk : this.text.decode(chunk, { stream: true });
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch (err) {
        this.onError(line, err);
      }
    }
    return out;
  }
}
