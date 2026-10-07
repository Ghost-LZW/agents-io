import { Type, type Static } from '@sinclair/typebox';
import { Evidence, ReplyRoute } from './common.js';
import { InboundEnvelope } from './inbound.js';
import { ItemSummary, Tier } from './events.js';

const MediaKind = Type.Union([Type.Literal('image'), Type.Literal('file'), Type.Literal('audio')]);

export const ChannelCaps = Type.Object({
  text: Type.Object({
    maxChars: Type.Number(),
    markdown: Type.Union([Type.Literal('none'), Type.Literal('basic'), Type.Literal('full')]),
  }),
  /** Can edit a sent message in place (needed for streaming cards). */
  edit: Type.Boolean(),
  /** Platform-native streaming; limits are configuration, never hard-coded. */
  nativeStream: Type.Optional(
    Type.Object({ minIntervalMs: Type.Number(), maxBytes: Type.Number(), ttlMs: Type.Optional(Type.Number()) }),
  ),
  buttons: Type.Boolean(),
  /** Media kinds the adapter can receive (`in`) and send (`out`). */
  media: Type.Object({ in: Type.Array(MediaKind), out: Type.Array(MediaKind) }),
  voiceOut: Type.Union([Type.Literal('none'), Type.Literal('tts'), Type.Literal('stream')]),
  threads: Type.Boolean(),
  approvals: Type.Union([Type.Literal('buttons'), Type.Literal('link'), Type.Literal('none')]),
  defaultTier: Tier,
  /** Identity evidence this adapter can supply. */
  evidence: Type.Array(Evidence),
  /** Can attach a sender identity (`SendOp.as`) to outbound messages and recover it on echo. */
  declaresSender: Type.Boolean(),
});
export type ChannelCaps = Static<typeof ChannelCaps>;

/** One entry of a turn's visible process, in the order it happened. */
export const ProgressStep = Type.Union([
  /** Model thinking (reasoning stream); `done` once the block closed. */
  Type.Object({ kind: Type.Literal('reasoning'), id: Type.String(), text: Type.String(), done: Type.Boolean() }),
  /** Interim assistant text between tool calls (commentary), not the final answer. */
  Type.Object({ kind: Type.Literal('narration'), id: Type.String(), text: Type.String() }),
  Type.Object({
    kind: Type.Literal('tool'),
    itemId: Type.String(),
    type: ItemSummary.properties.type,
    title: Type.String(),
    status: ItemSummary.properties.status,
    inputSummary: Type.Optional(Type.String()),
    resultPreview: Type.Optional(Type.String()),
    isError: Type.Optional(Type.Boolean()),
    parentItemId: Type.Optional(Type.String()),
  }),
]);
export type ProgressStep = Static<typeof ProgressStep>;

/**
 * Structured view of one turn for ends that render process natively (a CoT
 * bubble, collapsible panels). Ends that cannot, use the flat text/sections.
 * Always cumulative: each update replaces the previous view.
 */
export const ProgressView = Type.Object({
  turnId: Type.String(),
  status: Type.Union([
    Type.Literal('running'),
    Type.Literal('requires_action'),
    Type.Literal('completed'),
    Type.Literal('interrupted'),
    Type.Literal('failed'),
    Type.Literal('ambiguous'),
  ]),
  headline: Type.Optional(Type.String()),
  steps: Type.Array(ProgressStep),
  plan: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String(),
        status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')]),
      }),
    ),
  ),
  /** Answer text so far; final when `answerFinal`. */
  answer: Type.String(),
  answerFinal: Type.Boolean(),
  startedAt: Type.Optional(Type.Number()),
  endedAt: Type.Optional(Type.Number()),
});
export type ProgressView = Static<typeof ProgressView>;

/** Channel-neutral message. Adapters render it into their native format. */
export const RenderedMessage = Type.Object({
  text: Type.String(),
  sections: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.Union([Type.Literal('body'), Type.Literal('details'), Type.Literal('status'), Type.Literal('footer')]),
        text: Type.String(),
        collapsed: Type.Optional(Type.Boolean()),
      }),
    ),
  ),
  /** Clicks come back as inbound `event` content with name `action` and data `{ actionId, messageId }`. */
  actions: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        label: Type.String(),
        style: Type.Optional(Type.Union([Type.Literal('primary'), Type.Literal('danger')])),
      }),
    ),
  ),
  attachments: Type.Optional(
    Type.Array(Type.Object({ ref: Type.String(), mime: Type.String(), name: Type.Optional(Type.String()) })),
  ),
  link: Type.Optional(Type.Object({ label: Type.String(), url: Type.String() })),
  /** Plain spoken form for voice ends. */
  spokenText: Type.Optional(Type.String()),
  /** Structured process of the turn this message renders, for native process UIs. */
  progress: Type.Optional(ProgressView),
  /** Escape hatch for native rich content (e.g. a full card JSON). */
  channelData: Type.Optional(Type.Unknown()),
});
export type RenderedMessage = Static<typeof RenderedMessage>;

export const SendOp = Type.Object({
  /** Idempotency key: the same operationId must never produce two platform messages. */
  operationId: Type.String(),
  /** Sender identity to attach (e.g. `runner:x/run:y`). Required when caps.declaresSender. */
  as: Type.Optional(Type.String()),
});
export type SendOp = Static<typeof SendOp>;

export const SendResult = Type.Object({
  /** The editable message (the last part when the adapter split a long message). */
  providerMessageId: Type.Optional(Type.String()),
  /** All platform messages produced, in order, when split. */
  providerMessageIds: Type.Optional(Type.Array(Type.String())),
});
export type SendResult = Static<typeof SendResult>;

/** Host-provided blob storage, so adapters never inline large payloads. */
export interface BlobStore {
  put(bytes: Uint8Array, meta: { mime: string; name?: string }): Promise<string>;
  get(ref: string): Promise<{ bytes: Uint8Array; mime: string; name?: string }>;
}

export interface ChannelContext {
  account: string;
  config: unknown;
  signal: AbortSignal;
  /** Absent when the host has no blob store; adapters then emit platform refs only. */
  blobs?: BlobStore;
  /** Hand one inbound message to the host. Resolves once the host has durably accepted it. */
  emit(env: InboundEnvelope): Promise<{ accepted: boolean; inputId?: string }>;
  log(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown): void;
}

/**
 * A channel adapter. In-process adapters implement this interface; out-of-process
 * adapters speak the equivalent JSONL frames (see wire.ts).
 */
export interface ChannelAdapter {
  readonly id: string;
  caps(account: string): ChannelCaps;
  /** Runs until ctx.signal aborts. Must reconnect on its own and never throw for transient errors. */
  start(ctx: ChannelContext): Promise<void>;
  send(route: ReplyRoute, msg: RenderedMessage, op: SendOp): Promise<SendResult>;
  edit?(route: ReplyRoute, providerMessageId: string, msg: RenderedMessage, op: SendOp & { sequence: number }): Promise<void>;
  finalize?(route: ReplyRoute, providerMessageId: string, msg: RenderedMessage): Promise<void>;
  retract?(route: ReplyRoute, providerMessageId: string, outcome: string): Promise<void>;
  speak?(route: ReplyRoute, utterance: { text: string; interruptible: boolean }): Promise<void>;
  typing?(route: ReplyRoute, on: boolean): Promise<void>;
  /** After restart: is a previously sent (streaming) message still editable? */
  reconcile?(route: ReplyRoute, providerMessageId: string): Promise<'alive' | 'gone'>;
}
