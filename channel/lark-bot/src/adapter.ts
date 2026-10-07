import type {
  BlobStore,
  ChannelAdapter,
  ChannelCaps,
  ChannelContext,
  InboundEnvelope,
  ProgressView,
  RenderedMessage,
  ReplyRoute,
  SendOp,
  SendResult,
} from '@agents-io/protocol';
import { CardKitCard, LarkApiError, errCode } from './cardkit.js';
import { resolveConfig, type LarkBotConfig, type ResolvedConfig } from './config.js';
import { CotBubble } from './cot.js';
import { InboundEnricher } from './enrich.js';
import { CHANNEL_ID, mapCardAction, mapMessageEvent } from './inbound.js';
import {
  EL,
  PANEL_ORDER,
  actionElement,
  actionElementId,
  buildModel,
  fitProcessCard,
  footerElement,
  panelElement,
  processCard,
  splitMarkdown,
  statusElement,
  type PanelKey,
  type ProcessModel,
} from './process-card.js';
import {
  CHOICE_KEY,
  MENTIONS_KEY,
  choiceFormCard,
  larkFileType,
  mentionMessage,
  neutral,
  type ChoiceData,
  type MentionsData,
  cardMessage,
  fitCard,
  isLarkCard,
  needsCard,
  outcomeCard,
  splitText,
  textMessage,
  uuidFor,
  type OutMessage,
} from './render.js';
import { defaultLarkDeps } from './sdk.js';
import { DedupWindow, MemoryDeclaredSenderStore, type DeclaredSenderStore } from './store.js';
import type { LarkClientLike, LarkConnectionParams, LarkDeps, RawCardActionEvent, RawMessageEvent } from './types.js';

export { LarkApiError };

export interface LarkBotOptions {
  /** Replace SDK construction (tests, custom HTTP agents). */
  deps?: LarkDeps;
  /** Where declared senders are recorded. Default: bounded in-memory. */
  store?: DeclaredSenderStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Where degradations are reported before `start()` supplies the host's logger. */
  log?: ChannelContext['log'];
  /** Blob store outbound attachments are read from (default: `ChannelContext.blobs` from `start`). */
  blobs?: BlobStore;
}

type MsgKind = 'card' | 'text' | 'post' | 'cardkit';

/**
 * How a process card is updated, best first: `stream` = CardKit streaming mode with per-element
 * updates (typewriter answer), `update` = CardKit full card replacement, `patch` = an ordinary
 * interactive message replaced through `im.message.patch`.
 */
export type CardLevel = 'stream' | 'update' | 'patch';
const LEVEL_RANK: Record<CardLevel, number> = { stream: 0, update: 1, patch: 2 };

interface ProcState {
  route: ReplyRoute;
  level: CardLevel;
  card?: CardKitCard;
  cot?: CotBubble;
  /** `cot` never shows thinking/tools on the card; `auto` does once the bubble failed. */
  mode: 'cot' | 'auto' | 'panels';
  /** Streaming level: what each element last received. */
  sent: Map<string, string>;
  panels: Set<PanelKey>;
  actions: string[];
  lastAuxAt: number;
  /** Full-card levels: the card JSON last sent. */
  lastCard?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const BOUND = 2000;
/** Emits retried by the adapter after the event was already acked. */
const EMIT_RETRIES = 5;
/** Lark codes for a missing scope / app permission: remembered for the whole app, not one chat. */
const PERMISSION_CODES = new Set([99991672, 99991679, 99991663]);

function bounded<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > BOUND) {
    const oldest = m.keys().next();
    if (!oldest.done) m.delete(oldest.value);
  }
}

const isPermissionError = (e: unknown) =>
  e instanceof LarkApiError && ((e.code !== undefined && PERMISSION_CODES.has(e.code)) || (e.code === undefined && /\b(403|404)\b/.test(e.message)));

/**
 * Channel adapter for the official Feishu/Lark bot platform: events arrive over the SDK's
 * WebSocket long connection (no public URL needed), messages go out through the REST API.
 * Messages that carry `progress` are rendered as a native process card (and, per `process`,
 * Feishu's thinking bubble); see `config.ts`.
 */
export class LarkBotAdapter implements ChannelAdapter {
  readonly id = CHANNEL_ID;
  private readonly cfg: ResolvedConfig;
  private readonly deps: LarkDeps;
  private readonly store: DeclaredSenderStore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly dedup: DedupWindow;
  private clientInst: LarkClientLike | undefined;
  private botOpenId: string | undefined;
  private account = 'default';
  private logFn: ChannelContext['log'] | undefined;

  private readonly sends = new Map<string, Promise<SendResult>>();
  private readonly kinds = new Map<string, MsgKind>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastPatchAt = new Map<string, number>();
  private readonly lastSeq = new Map<string, number>();
  private readonly procs = new Map<string, ProcState>();
  /**
   * operationId → the process state (bubble) and CardKit card of a send not yet confirmed. A retry
   * reuses them: Lark's uuid dedup returns the message first sent, which shows that card, and
   * the bubble is already open.
   */
  private readonly pendingProcs = new Map<string, { st: ProcState; card?: CardKitCard; level?: CardLevel; shown?: ProcessModel }>();
  /** `app` or `chat:<id>` → lowest card level that still works there, until a time. */
  private readonly cardFloor = new Map<string, { level: CardLevel; until: number }>();
  /** `app` or `chat:<id>` → thinking bubble off until a time. */
  private readonly cotOff = new Map<string, number>();
  private readonly cotTasks = new Set<Promise<void>>();
  private blobs: BlobStore | undefined;
  /** union_id / user_id → open_id, learned from inbound events (at tags need an open_id). */
  private readonly openIds = new Map<string, string>();
  /** blob ref → uploaded Lark key, so a retried send does not upload again. */
  private readonly uploads = new Map<string, { ref: string; mime: string }>();
  private readonly enricher: InboundEnricher;
  /** chat id → enrichment of its previous message, so messages reach the host in order. */
  private readonly inboundTails = new Map<string, Promise<void>>();

  constructor(config: LarkBotConfig, opts: LarkBotOptions = {}) {
    this.cfg = resolveConfig(config);
    this.deps = opts.deps ?? defaultLarkDeps;
    this.store = opts.store ?? new MemoryDeclaredSenderStore();
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.dedup = new DedupWindow(this.cfg.dedupWindowMs, 10_000, this.now);
    this.botOpenId = this.cfg.botOpenId;
    this.logFn = opts.log;
    this.blobs = opts.blobs;
    this.enricher = new InboundEnricher({ client: () => this.client, store: this.store, cfg: this.cfg, now: this.now, log: (l, m) => this.log(l, m) });
  }

  caps(_account?: string): ChannelCaps {
    return {
      text: { maxChars: this.cfg.maxChars, markdown: 'basic' },
      edit: true,
      // Process cards stream the answer natively; the host may edit as often as this.
      ...(this.cfg.process !== 'off' ? { nativeStream: { minIntervalMs: this.cfg.streamTextIntervalMs, maxBytes: this.cfg.maxCardKitBytes } } : {}),
      buttons: true,
      media: { in: ['image', 'file', 'audio'], out: ['image', 'file', 'audio'] },
      voiceOut: 'none',
      threads: true,
      approvals: 'buttons',
      defaultTier: 'card',
      evidence: ['platform_signed'],
      declaresSender: true,
    };
  }

  private params(): LarkConnectionParams {
    return {
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      domain: this.cfg.domain,
      ...(this.cfg.encryptKey ? { encryptKey: this.cfg.encryptKey } : {}),
      ...(this.cfg.verificationToken ? { verificationToken: this.cfg.verificationToken } : {}),
    };
  }

  private get client(): LarkClientLike {
    return (this.clientInst ??= this.deps.createClient(this.params()));
  }

  private log(level: 'debug' | 'info' | 'warn', msg: string): void {
    this.logFn?.(level, msg);
  }

  // ---- inbound ----------------------------------------------------------------------------

  async start(ctx: ChannelContext): Promise<void> {
    this.account = ctx.account;
    this.logFn = ctx.log;
    this.blobs ??= ctx.blobs;
    if (!this.botOpenId) await this.discoverBot(ctx);

    const dispatcher = this.deps.createDispatcher(this.params());
    dispatcher.register({
      'im.message.receive_v1': (data: RawMessageEvent) => this.onMessage(ctx, data),
      'card.action.trigger': (data: RawCardActionEvent) => this.onCardAction(ctx, data),
    });

    while (!ctx.signal.aborted) {
      const ws = this.deps.createWs(this.params());
      const aborted = new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
      try {
        await ws.start({ eventDispatcher: dispatcher });
        ctx.log('info', 'lark ws connected');
        await aborted;
        ws.close();
        return;
      } catch (err) {
        try {
          ws.close({ force: true });
        } catch {
          /* already closed */
        }
        ctx.log('warn', `lark ws start failed, retrying: ${String(err)}`);
        await Promise.race([this.sleep(this.cfg.reconnectDelayMs), aborted]);
      }
    }
  }

  private async discoverBot(ctx: ChannelContext): Promise<void> {
    try {
      const res = (await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })) as { bot?: { open_id?: string } };
      this.botOpenId = res?.bot?.open_id;
      if (!this.botOpenId) ctx.log('warn', 'lark bot open_id not returned; @mention detection disabled (group messages are observe-only)');
    } catch (err) {
      ctx.log('warn', `lark bot discovery failed; set config.botOpenId to enable @mention detection: ${String(err)}`);
    }
  }

  /**
   * Wait for the host to take the message, but never past Lark's ack deadline. A failure
   * before the deadline rejects (the SDK answers 500, Lark redelivers, the dedup key is
   * dropped for it); once the deadline acked the event Lark will not redeliver, so the
   * adapter keeps the dedup key and retries the emit itself.
   */
  private async deliver(ctx: ChannelContext, key: string, emit: () => Promise<unknown>): Promise<void> {
    let acked = false;
    const attempt = (n: number): Promise<unknown> =>
      emit().catch(async (err) => {
        if (!acked) throw err;
        if (n >= EMIT_RETRIES || ctx.signal.aborted) {
          this.dedup.delete(key);
          ctx.log('error', `emit failed for ${key}, giving up: ${String(err)}`);
          throw err;
        }
        ctx.log('warn', `emit failed for ${key} after ack, retrying: ${String(err)}`);
        await this.sleep(Math.min(30_000, 1000 * 2 ** n));
        return attempt(n + 1);
      });
    const p = attempt(0);
    p.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'late'>((resolve) => (timer = setTimeout(() => ((acked = true), resolve('late')), this.cfg.ackTimeoutMs)));
    try {
      const res = await Promise.race([p.then(() => 'done' as const, (err: unknown) => ({ err })), deadline]);
      if (typeof res === 'object') {
        this.dedup.delete(key); // let the platform's redelivery retry it
        ctx.log('error', `emit failed for ${key}: ${String(res.err)}`);
        throw res.err;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async onMessage(ctx: ChannelContext, ev: RawMessageEvent): Promise<void> {
    const mid = ev?.message?.message_id;
    if (!mid) return;
    const key = `msg:${mid}`;
    if (this.dedup.has(key)) {
      ctx.log('debug', `dropping redelivered ${key}`);
      return;
    }
    this.dedup.add(key);
    this.learnIds(ev);
    const fromBot = ev.sender?.sender_type === 'app' || (!!this.botOpenId && ev.sender?.sender_id?.open_id === this.botOpenId);
    let declared: string | undefined;
    try {
      declared = fromBot ? await this.store.get(mid) : undefined;
    } catch (err) {
      this.dedup.delete(key); // not acked: the redelivery must be processed
      throw err;
    }
    const env = mapMessageEvent(ev, { account: ctx.account, botOpenId: this.botOpenId, declared });
    if (!env) {
      this.dedup.delete(key);
      return;
    }
    await this.deliver(ctx, key, () => this.enrichThenEmit(ctx, ev.message.chat_id, env));
  }

  /**
   * Media download, quoted text and sender name need the network, so they run inside the
   * thunk `deliver` waits on: the event is acked by `ackTimeoutMs` even while they continue.
   * Per chat they are chained, so a slow download never lets a later message overtake it.
   */
  private enrichThenEmit(ctx: ChannelContext, chatId: string, env: InboundEnvelope): Promise<unknown> {
    const prev = this.inboundTails.get(chatId) ?? Promise.resolve();
    const ready = prev.then(() => this.enricher.enrich(env, ctx.blobs)).catch(() => env);
    const tail = ready.then(() => undefined);
    this.inboundTails.set(chatId, tail);
    void tail.then(() => {
      if (this.inboundTails.get(chatId) === tail) this.inboundTails.delete(chatId);
    });
    return ready.then((e) => ctx.emit(e));
  }

  /** Remember open_ids behind the union/user ids we hand out, for outbound at tags. */
  private learnIds(ev: RawMessageEvent): void {
    const ids = [ev.sender?.sender_id, ...(ev.message?.mentions ?? []).map((m) => m.id)];
    for (const id of ids) {
      if (!id?.open_id) continue;
      if (id.union_id) bounded(this.openIds, id.union_id, id.open_id);
      if (id.user_id) bounded(this.openIds, id.user_id, id.open_id);
    }
  }

  private openIdOf(id: string): string | undefined {
    if (id.startsWith('ou_')) return id;
    return this.openIds.get(id);
  }

  /**
   * Host blobs among the attachments are uploaded (image.create / file.create) and
   * replaced by `lark-file:upload/<key>` refs, which `attachmentParts` sends.
   */
  private async uploadAttachments(msg: RenderedMessage): Promise<RenderedMessage> {
    const atts = msg.attachments ?? [];
    if (!atts.some((a) => !a.ref.startsWith('lark-file:'))) return msg;
    const out: NonNullable<RenderedMessage['attachments']> = [];
    for (const a of atts) {
      if (a.ref.startsWith('lark-file:')) {
        out.push(a);
        continue;
      }
      const done = this.uploads.get(a.ref);
      if (done) {
        out.push({ ...a, ...done });
        continue;
      }
      if (!this.blobs) throw new LarkApiError('upload', undefined, `no blob store to read ${a.ref} from`);
      const blob = await this.blobs.get(a.ref);
      const name = a.name ?? blob.name ?? 'file';
      const bytes = Buffer.from(blob.bytes);
      const im = this.client.im.v1;
      const image = a.mime.startsWith('image/') && a.mime !== 'image/svg+xml' && bytes.byteLength <= 10 * 1024 * 1024;
      let up: { ref: string; mime: string };
      if (image) {
        if (!im.image) throw new LarkApiError('image.create', undefined, 'client has no im.v1.image');
        const r = await this.api('image.create', async () => (await im.image!.create({ data: { image_type: 'message', image: bytes } })) ?? {});
        const key = r.image_key ?? r.data?.image_key;
        if (!key) throw new LarkApiError('image.create', undefined, 'no image_key returned');
        up = { ref: `lark-file:upload/${key}`, mime: a.mime };
      } else {
        if (!im.file) throw new LarkApiError('file.create', undefined, 'client has no im.v1.file');
        const fileType = larkFileType(name, a.mime);
        const r = await this.api('file.create', async () => (await im.file!.create({ data: { file_type: fileType, file_name: name, file: bytes } })) ?? {});
        const key = r.file_key ?? r.data?.file_key;
        if (!key) throw new LarkApiError('file.create', undefined, 'no file_key returned');
        // Only opus uploads can go out as an audio message; everything else is a file message.
        up = { ref: `lark-file:upload/${key}`, mime: fileType === 'opus' ? 'audio/opus' : 'application/octet-stream' };
      }
      bounded(this.uploads, a.ref, up);
      out.push({ ...a, ...up });
    }
    return { ...msg, attachments: out };
  }

  private async onCardAction(ctx: ChannelContext, ev: RawCardActionEvent): Promise<Record<string, never>> {
    const key = `card:${ev?.event_id ?? ev?.token ?? ''}`;
    if (key !== 'card:') {
      if (this.dedup.has(key)) return {};
      this.dedup.add(key);
    }
    const env = mapCardAction(ev, { account: ctx.account });
    if (env) await this.deliver(ctx, key, () => ctx.emit(env));
    return {};
  }

  // ---- outbound ---------------------------------------------------------------------------

  private async api<T extends { code?: number; msg?: string }>(op: string, call: () => Promise<T>): Promise<T> {
    let res: T;
    try {
      res = await call();
    } catch (err) {
      throw new LarkApiError(op, errCode(err), err instanceof Error ? err.message : String(err));
    }
    if (res?.code) throw new LarkApiError(op, res.code, res.msg ?? 'unknown error');
    return res;
  }

  private async sendOne(route: ReplyRoute, out: OutMessage, uuid: string): Promise<string | undefined> {
    const msg = this.client.im.v1.message;
    const res = route.replyToMessageId
      ? await this.api('message.reply', () =>
          msg.reply({
            data: { content: out.content, msg_type: out.msg_type, reply_in_thread: !!route.threadId, uuid },
            path: { message_id: route.replyToMessageId! },
          }),
        )
      : await this.api('message.create', () =>
          msg.create({
            data: { receive_id: route.conversationId, msg_type: out.msg_type, content: out.content, uuid },
            params: { receive_id_type: 'chat_id' },
          }),
        );
    return res.data?.message_id;
  }

  private attachmentParts(msg: RenderedMessage): { out: OutMessage; kind: MsgKind }[] {
    const parts: { out: OutMessage; kind: MsgKind }[] = [];
    for (const a of msg.attachments ?? []) {
      const m = /^lark-file:[^/]+\/(.+)$/.exec(a.ref);
      if (!m) continue; // blobs the host holds must be uploaded by the host; only Lark keys can be forwarded
      const key = m[1]!;
      const isImage = a.mime.startsWith('image/');
      const isAudio = a.mime.startsWith('audio/');
      parts.push(
        isImage
          ? { out: { msg_type: 'image', content: JSON.stringify({ image_key: key }) }, kind: 'text' }
          : { out: { msg_type: isAudio ? 'audio' : 'file', content: JSON.stringify({ file_key: key }) }, kind: 'text' },
      );
    }
    return parts;
  }

  /** Render one RenderedMessage into the ordered platform messages; the primary one is the editable body. */
  private plan(msg: RenderedMessage): { parts: { out: OutMessage; kind: MsgKind }[]; primary: number } {
    const parts: { out: OutMessage; kind: MsgKind }[] = [];
    const mentions = neutral<MentionsData>(msg, MENTIONS_KEY);
    const choice = neutral<ChoiceData>(msg, CHOICE_KEY);
    if (!msg.text.trim() && msg.attachments?.length && !needsCard(msg) && !isLarkCard(msg.channelData)) {
      // A bare file: no empty text message in front of it.
      const files = this.attachmentParts(msg);
      return { parts: files, primary: 0 };
    } else if (choice?.multi && msg.actions?.length) {
      parts.push({ out: cardMessage(choiceFormCard(choice)), kind: 'card' });
    } else if (mentions && !needsCard(msg)) {
      parts.push({ out: mentionMessage(mentions, (id) => this.openIdOf(id)), kind: 'text' });
    } else if (isLarkCard(msg.channelData)) {
      parts.push({ out: cardMessage(msg.channelData), kind: 'card' });
    } else if (needsCard(msg)) {
      const hasBody = (msg.sections ?? []).some((s) => s.kind === 'body');
      const chunks = hasBody ? [msg.text] : splitText(msg.text, this.cfg.maxChars);
      chunks.slice(0, -1).forEach((c) => parts.push({ out: textMessage(c), kind: 'text' }));
      const last = chunks[chunks.length - 1] ?? '';
      parts.push({ out: cardMessage(fitCard(msg, hasBody ? '' : last, this.cfg.maxCardBytes)), kind: 'card' });
    } else {
      for (const c of splitText(msg.text, this.cfg.maxChars)) {
        const out = textMessage(c);
        parts.push({ out, kind: out.msg_type === 'post' ? 'post' : 'text' });
      }
    }
    const primary = parts.length - 1;
    parts.push(...this.attachmentParts(msg));
    return { parts, primary };
  }

  send(route: ReplyRoute, msg: RenderedMessage, op: SendOp): Promise<SendResult> {
    const prior = this.sends.get(op.operationId);
    if (prior) return prior;
    const run = this.useProcess(msg) ? this.sendProcess(route, msg, op) : this.doSend(route, msg, op);
    this.sends.set(op.operationId, run);
    if (this.sends.size > BOUND) {
      const oldest = this.sends.keys().next();
      if (!oldest.done) this.sends.delete(oldest.value);
    }
    run.catch(() => this.sends.delete(op.operationId)); // a failed op may be retried with the same uuids
    return run;
  }

  private async doSend(route: ReplyRoute, input: RenderedMessage, op: SendOp): Promise<SendResult> {
    const msg = await this.uploadAttachments(input);
    const { parts, primary } = this.plan(msg);
    let providerMessageId: string | undefined;
    for (const [i, p] of parts.entries()) {
      // Same operationId -> same uuid per part, so Lark itself drops a duplicate within its dedup window.
      const id = await this.sendOne(route, p.out, uuidFor(this.account, op.operationId, i));
      if (id && op.as) await this.store.set(id, op.as);
      if (i === primary) {
        providerMessageId = id;
        if (id) bounded(this.kinds, id, p.kind);
      }
    }
    return providerMessageId ? { providerMessageId } : {};
  }

  /** Serialise edits per message and keep `gap` ms between two of them. */
  private serial<T>(id: string, fn: () => Promise<T>, gap = this.cfg.editMinIntervalMs): Promise<T> {
    const prev = this.tails.get(id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const wait = (this.lastPatchAt.get(id) ?? -Infinity) + gap - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await fn();
      } finally {
        bounded(this.lastPatchAt, id, this.now());
      }
    });
    bounded(this.tails, id, run.then(() => undefined, () => undefined));
    return run;
  }

  private async patch(id: string, msg: RenderedMessage): Promise<void> {
    const kind = this.kinds.get(id) ?? 'card';
    const api = this.client.im.v1.message;
    if (kind === 'card' || kind === 'cardkit') {
      const card = isLarkCard(msg.channelData) ? msg.channelData : fitCard(msg, msg.text, this.cfg.maxCardBytes);
      await this.api('message.patch', () => api.patch({ data: { content: JSON.stringify(card) }, path: { message_id: id } }));
    } else {
      const out = textMessage(splitText(msg.text, this.cfg.maxChars)[0] ?? '');
      await this.api('message.update', () =>
        api.update({ data: { msg_type: out.msg_type, content: out.content }, path: { message_id: id } }),
      );
    }
  }

  /** Streaming updates: the target must have been sent as a card (`sections`/`actions`/`link`/`channelData`/`progress`). */
  async edit(route: ReplyRoute, providerMessageId: string, msg: RenderedMessage, op: SendOp & { sequence: number }): Promise<void> {
    const proc = this.isProcessMessage(providerMessageId, msg);
    const gap = this.procs.get(providerMessageId)?.level === 'stream' ? this.cfg.streamTextIntervalMs : this.cfg.editMinIntervalMs;
    await this.serial(
      providerMessageId,
      async () => {
        const last = this.lastSeq.get(providerMessageId);
        if (last !== undefined && op.sequence <= last) return; // stale or duplicate edit
        bounded(this.lastSeq, providerMessageId, op.sequence);
        if (proc) await this.editProcess(route, providerMessageId, msg, false);
        else await this.patch(providerMessageId, msg);
      },
      gap,
    );
  }

  async finalize(route: ReplyRoute, providerMessageId: string, msg: RenderedMessage): Promise<void> {
    const proc = this.isProcessMessage(providerMessageId, msg);
    await this.serial(providerMessageId, () => (proc ? this.editProcess(route, providerMessageId, msg, true) : this.patch(providerMessageId, msg)));
    this.forget(providerMessageId);
  }

  async retract(_route: ReplyRoute, providerMessageId: string, outcome: string): Promise<void> {
    await this.serial(providerMessageId, async () => {
      const st = this.procs.get(providerMessageId);
      if (st?.card && st.level !== 'patch') {
        if (st.level === 'stream') await st.card.settings({ config: { streaming_mode: false } }).catch(() => undefined);
        await st.card.update(outcomeCard(outcome));
      } else if ((this.kinds.get(providerMessageId) ?? 'card') !== 'text' && this.kinds.get(providerMessageId) !== 'post') {
        await this.api('message.patch', () =>
          this.client.im.v1.message.patch({
            data: { content: JSON.stringify(outcomeCard(outcome)) },
            path: { message_id: providerMessageId },
          }),
        );
      } else await this.patch(providerMessageId, { text: outcome });
    });
    this.forget(providerMessageId);
  }

  private forget(id: string): void {
    this.tails.delete(id);
    this.lastPatchAt.delete(id);
    this.lastSeq.delete(id);
    this.procs.delete(id);
  }

  async reconcile(_route: ReplyRoute, providerMessageId: string): Promise<'alive' | 'gone'> {
    try {
      const res = await this.api('message.get', () => this.client.im.v1.message.get({ path: { message_id: providerMessageId } }));
      const item = res.data?.items?.[0];
      return !item || item.deleted ? 'gone' : 'alive';
    } catch (err) {
      if (err instanceof LarkApiError && err.code !== undefined && this.cfg.goneCodes.includes(err.code)) return 'gone';
      throw err;
    }
  }

  /** The sender declared for a message this adapter sent, if the store knows it. */
  declaredSenderOf(providerMessageId: string): Promise<string | undefined> | string | undefined {
    return this.store.get(providerMessageId);
  }

  /** Resolves once every thinking bubble request in flight has settled (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.cotTasks.size) await Promise.all([...this.cotTasks]);
  }

  // ---- process cards ----------------------------------------------------------------------

  private useProcess(msg: RenderedMessage): boolean {
    return this.cfg.process !== 'off' && !!msg.progress && !isLarkCard(msg.channelData);
  }

  private isProcessMessage(id: string, msg: RenderedMessage): boolean {
    if (this.procs.has(id)) return true;
    const kind = this.kinds.get(id);
    return this.useProcess(msg) && kind !== 'text' && kind !== 'post';
  }

  private floorOf(route: ReplyRoute): CardLevel {
    let level: CardLevel = this.client.cardkit ? 'stream' : 'patch';
    const now = this.now();
    for (const key of ['app', `chat:${route.conversationId}`]) {
      const f = this.cardFloor.get(key);
      if (!f) continue;
      if (f.until <= now) this.cardFloor.delete(key);
      else if (LEVEL_RANK[f.level] > LEVEL_RANK[level]) level = f.level;
    }
    return level;
  }

  private cotAllowed(route: ReplyRoute): boolean {
    const now = this.now();
    for (const key of ['app', `chat:${route.conversationId}`]) {
      const until = this.cotOff.get(key);
      if (until === undefined) continue;
      if (until <= now) this.cotOff.delete(key);
      else return false;
    }
    return true;
  }

  /** Remember that `failed` did not work for this chat (or the whole app, for permission errors). */
  private degrade(route: ReplyRoute, failed: CardLevel | 'cot', err: unknown): void {
    const key = isPermissionError(err) ? 'app' : `chat:${route.conversationId}`;
    const until = this.now() + this.cfg.degradeTtlMs;
    this.log('warn', `lark ${failed === 'cot' ? 'thinking bubble' : `${failed} card`} failed for ${key}, degrading: ${String((err as Error)?.message ?? err)}`);
    if (failed === 'cot') {
      bounded(this.cotOff, key, until);
      return;
    }
    const next: CardLevel = failed === 'stream' ? 'update' : 'patch';
    const prior = this.cardFloor.get(key);
    if (!prior || prior.until <= this.now() || LEVEL_RANK[next] >= LEVEL_RANK[prior.level]) bounded(this.cardFloor, key, { level: next, until });
  }

  private newState(route: ReplyRoute, progress: ProgressView, level: CardLevel): ProcState {
    const mode = this.cfg.process === 'off' ? 'panels' : this.cfg.process;
    const st: ProcState = { route, level, mode, sent: new Map(), panels: new Set(), actions: [], lastAuxAt: this.now() };
    if (mode !== 'panels' && this.cotAllowed(route)) {
      st.cot = new CotBubble({
        client: this.client,
        route,
        turnId: progress.turnId,
        locale: this.cfg.locale,
        timeoutMs: this.cfg.processRequestTimeoutMs,
        now: this.now,
        log: (m) => this.log('warn', m),
        onCreateFailed: (err) => this.degrade(route, 'cot', err),
      });
    }
    return st;
  }

  private feedCot(st: ProcState, p: ProgressView, final: boolean): void {
    if (!st.cot) return;
    if (!final) return st.cot.push(p);
    const task = st.cot.finish(p).finally(() => this.cotTasks.delete(task));
    this.cotTasks.add(task);
  }

  private model(msg: RenderedMessage, p: ProgressView, st: ProcState): ProcessModel {
    const base = {
      locale: this.cfg.locale,
      style: this.cfg.style,
      processElsewhere: st.mode === 'cot' || (!!st.cot && !st.cot.failed),
      maxEntries: this.cfg.processMaxEntries,
      panelMaxChars: this.cfg.processPanelMaxChars,
      now: this.now(),
    };
    const budget = st.level === 'patch' ? this.cfg.maxCardBytes : this.cfg.maxCardKitBytes;
    // Answer budget = card budget minus everything else on the card.
    const rest = Buffer.byteLength(JSON.stringify(processCard(buildModel({ ...msg, text: '' }, { ...p, answer: '' }, { ...base, answerBytes: 1 }), { streaming: true })));
    return buildModel(msg, p, { ...base, answerBytes: Math.max(1000, budget - rest - 1000) });
  }

  private static progressFor(msg: RenderedMessage, final: boolean): ProgressView {
    return msg.progress ?? { turnId: '', status: final ? 'completed' : 'running', steps: [], answer: msg.text, answerFinal: final };
  }

  private async sendProcess(route: ReplyRoute, msg: RenderedMessage, op: SendOp): Promise<SendResult> {
    const p = msg.progress!;
    const uuid = uuidFor(this.account, op.operationId, 0);
    const prior = this.pendingProcs.get(op.operationId);
    let level = prior?.level ?? this.floorOf(route);
    const st = prior?.st ?? this.newState(route, p, level);
    const pending = prior ?? { st };
    if (!prior) {
      bounded(this.pendingProcs, op.operationId, pending);
      // The bubble goes first so it sits above the reply card; if it fails the card shows the process.
      if (st.cot) await st.cot.open();
    }
    this.feedCot(st, p, false);
    let id: string | undefined;
    while (id === undefined) {
      if (level === 'patch') {
        st.level = 'patch';
        pending.level = 'patch';
        const card = fitProcessCard(this.model(msg, p, st), this.cfg.maxCardBytes);
        st.lastCard = JSON.stringify(card);
        id = await this.sendOne(route, cardMessage(card), uuid);
        if (id) bounded(this.kinds, id, 'card');
        break;
      }
      st.level = level;
      let card: CardKitCard;
      try {
        // A card already sent under this uuid (reply lost in transit) is the one the message shows.
        if (pending.card && pending.level === level) card = pending.card;
        else {
          const shown = this.model(msg, p, st);
          card = await CardKitCard.create(this.client.cardkit!.v1, processCard(shown, { streaming: level === 'stream' }), {
            timeoutMs: this.cfg.processRequestTimeoutMs,
            sleep: this.sleep,
          });
          Object.assign(pending, { card, level, shown });
        }
      } catch (err) {
        this.degrade(route, level, err);
        level = level === 'stream' ? 'update' : 'patch';
        continue;
      }
      try {
        id = await this.sendOne(route, { msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: card.cardId } }) }, uuid);
      } catch (err) {
        // Only an explicit rejection is safe to retry as another message under the same uuid.
        if (!(err instanceof LarkApiError) || err.code === undefined) throw err;
        this.degrade(route, 'update', err);
        level = 'patch';
        continue;
      }
      st.card = card;
      if (id) bounded(this.kinds, id, 'cardkit');
    }
    if (!id) {
      this.pendingProcs.delete(op.operationId);
      return {};
    }
    if (op.as) await this.store.set(id, op.as);
    bounded(this.procs, id, st);
    // A reused card shows what it was created with, so the first edit sends the differences from that.
    this.initSent(st, (st.card && st.card === pending.card && pending.shown) || this.model(msg, p, st));
    for (const [i, part] of this.attachmentParts(msg).entries()) await this.sendOne(route, part.out, uuidFor(this.account, op.operationId, i + 1));
    this.pendingProcs.delete(op.operationId);
    return { providerMessageId: id };
  }

  /** What a freshly created card already shows, so the first edit only sends differences. */
  private initSent(st: ProcState, m: ProcessModel): void {
    st.sent.set(EL.status, m.banner);
    st.sent.set(EL.answer, m.answer);
    st.sent.set(EL.footer, m.footer);
    for (const panel of m.panels) {
      st.panels.add(panel.key);
      st.sent.set(EL.panelBody(panel.key), panel.body);
    }
    st.actions = m.actions.map((a) => a.id);
  }

  /** A process message this process did not send (restart): patch it, or take over its CardKit card. */
  private async recover(route: ReplyRoute, id: string, msg: RenderedMessage, p: ProgressView): Promise<ProcState> {
    const st = this.newState(route, p, 'patch');
    st.cot = undefined; // the bubble of a turn we lost track of cannot be resumed
    const card = JSON.stringify(fitProcessCard(this.model(msg, p, st), this.cfg.maxCardBytes));
    try {
      await this.api('message.patch', () => this.client.im.v1.message.patch({ data: { content: card }, path: { message_id: id } }));
      st.lastCard = card;
    } catch (err) {
      const kit = this.client.cardkit?.v1;
      if (!kit || !(err instanceof LarkApiError) || err.code === undefined) throw err;
      const res = await this.api('cardkit.card.idConvert', () => kit.card.idConvert({ data: { message_id: id } }));
      if (!res.data?.card_id) throw err;
      st.card = CardKitCard.adopt(kit, res.data.card_id, { timeoutMs: this.cfg.processRequestTimeoutMs, sleep: this.sleep });
      st.level = 'update';
    }
    bounded(this.procs, id, st);
    return st;
  }

  private async editProcess(route: ReplyRoute, id: string, msg: RenderedMessage, final: boolean): Promise<void> {
    const p = LarkBotAdapter.progressFor(msg, final);
    const st = this.procs.get(id) ?? (await this.recover(route, id, msg, p));
    this.feedCot(st, p, final);
    const m = this.model(msg, p, st);
    if (st.level === 'stream') {
      try {
        await this.applyStream(st, m, final);
      } catch (err) {
        this.degrade(route, 'stream', err);
        st.level = 'update';
      }
    }
    if (st.level === 'update') await this.applyFull(id, st, m, final);
    else if (st.level === 'patch') await this.patchProcess(id, st, m);
    if (final && m.overflow.length) {
      // The answer did not fit the card: the rest follows as plain cards, each within the message limit.
      const pages = m.overflow.flatMap((page) => splitMarkdown(page, this.cfg.maxCardBytes - 2000));
      for (const [i, page] of pages.entries()) {
        await this.sendOne(route, cardMessage({ schema: '2.0', config: { width_mode: 'fill' }, body: { elements: [{ tag: 'markdown', content: page }] } }), uuidFor(this.account, `${id}:more`, i));
      }
    }
  }

  private async applyStream(st: ProcState, m: ProcessModel, final: boolean): Promise<void> {
    const card = st.card!;
    if (final) {
      // Close streaming before the final layout replaces the card (no buttons, final header).
      await card.settings({ config: { streaming_mode: false, summary: { content: m.summary } } });
      await card.update(processCard(m));
      return;
    }
    for (const [i, key] of PANEL_ORDER.entries()) {
      const panel = m.panels.find((x) => x.key === key);
      if (!panel || st.panels.has(key)) continue;
      const before = PANEL_ORDER.slice(0, i).reverse().find((k) => st.panels.has(k));
      await card.createElements([panelElement(panel)], { type: 'insert_after', target: before ? EL.panel(before) : EL.status });
      st.panels.add(key);
      st.sent.set(EL.panelBody(key), panel.body);
    }
    if (st.sent.get(EL.answer) !== m.answer) {
      await card.content(EL.answer, m.answer);
      st.sent.set(EL.answer, m.answer);
    }
    const want = m.actions.map((a) => a.id);
    for (const gone of st.actions.filter((a) => !want.includes(a))) {
      await card.deleteElement(actionElementId(gone));
      st.actions = st.actions.filter((a) => a !== gone);
    }
    for (const a of m.actions.filter((x) => !st.actions.includes(x.id))) {
      await card.createElements([actionElement(a)], { type: 'insert_before', target: EL.footer });
      st.actions.push(a.id);
    }
    const statusChanged = st.sent.get(EL.status) !== m.banner;
    if (!statusChanged && this.now() - st.lastAuxAt < this.cfg.streamAuxIntervalMs) return;
    st.lastAuxAt = this.now();
    if (statusChanged) {
      await card.updateElement(EL.status, statusElement(m));
      st.sent.set(EL.status, m.banner);
    }
    for (const panel of m.panels) {
      if (st.sent.get(EL.panelBody(panel.key)) === panel.body) continue;
      await card.content(EL.panelBody(panel.key), panel.body);
      st.sent.set(EL.panelBody(panel.key), panel.body);
    }
    if (st.sent.get(EL.footer) !== m.footer) {
      await card.updateElement(EL.footer, footerElement(m));
      st.sent.set(EL.footer, m.footer);
    }
  }

  private async applyFull(id: string, st: ProcState, m: ProcessModel, final: boolean): Promise<void> {
    const card = processCard(m);
    const json = JSON.stringify(card);
    if (json === st.lastCard && !final) return;
    try {
      await st.card!.update(card);
      st.lastCard = json;
    } catch (err) {
      // Last resort: a message patch (works for cards sent as JSON; the platform decides for CardKit ones).
      this.degrade(st.route, 'update', err);
      st.level = 'patch';
      try {
        await this.patchProcess(id, st, m);
      } catch {
        throw err;
      }
    }
  }

  private async patchProcess(id: string, st: ProcState, m: ProcessModel): Promise<void> {
    const json = JSON.stringify(fitProcessCard(m, this.cfg.maxCardBytes));
    if (json === st.lastCard) return;
    await this.api('message.patch', () => this.client.im.v1.message.patch({ data: { content: json }, path: { message_id: id } }));
    st.lastCard = json;
  }
}
