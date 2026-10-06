import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelContext,
  RenderedMessage,
  ReplyRoute,
  SendOp,
  SendResult,
} from '@agents-io/protocol';
import { resolveConfig, type LarkBotConfig, type ResolvedConfig } from './config.js';
import { CHANNEL_ID, mapCardAction, mapMessageEvent } from './inbound.js';
import {
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
import type { LarkApiResponse, LarkClientLike, LarkConnectionParams, LarkDeps, RawCardActionEvent, RawMessageEvent } from './types.js';

export class LarkApiError extends Error {
  constructor(
    readonly op: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`lark ${op} failed${code !== undefined ? ` (code ${code})` : ''}: ${message}`);
    this.name = 'LarkApiError';
  }
}

export interface LarkBotOptions {
  /** Replace SDK construction (tests, custom HTTP agents). */
  deps?: LarkDeps;
  /** Where declared senders are recorded. Default: bounded in-memory. */
  store?: DeclaredSenderStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type MsgKind = 'card' | 'text' | 'post';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const BOUND = 2000;

function bounded<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > BOUND) {
    const oldest = m.keys().next();
    if (!oldest.done) m.delete(oldest.value);
  }
}

function errCode(e: unknown): number | undefined {
  const x = e as { code?: unknown; response?: { data?: { code?: unknown } } };
  const c = x?.response?.data?.code ?? x?.code;
  return typeof c === 'number' ? c : undefined;
}

/**
 * Channel adapter for the official Feishu/Lark bot platform: events arrive over the SDK's
 * WebSocket long connection (no public URL needed), messages go out through the REST API.
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

  private readonly sends = new Map<string, Promise<SendResult>>();
  private readonly kinds = new Map<string, MsgKind>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastPatchAt = new Map<string, number>();
  private readonly lastSeq = new Map<string, number>();

  constructor(config: LarkBotConfig, opts: LarkBotOptions = {}) {
    this.cfg = resolveConfig(config);
    this.deps = opts.deps ?? defaultLarkDeps;
    this.store = opts.store ?? new MemoryDeclaredSenderStore();
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.dedup = new DedupWindow(this.cfg.dedupWindowMs, 10_000, this.now);
    this.botOpenId = this.cfg.botOpenId;
  }

  caps(_account?: string): ChannelCaps {
    return {
      text: { maxChars: this.cfg.maxChars, markdown: 'basic' },
      edit: true,
      buttons: true,
      media: ['image', 'file', 'audio'],
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

  // ---- inbound ----------------------------------------------------------------------------

  async start(ctx: ChannelContext): Promise<void> {
    this.account = ctx.account;
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

  /** Wait for the host to take the message, but never past Lark's ack deadline. */
  private async deliver(ctx: ChannelContext, key: string, emit: () => Promise<unknown>): Promise<void> {
    const p = emit();
    p.catch((err) => {
      this.dedup.delete(key); // let the platform's redelivery retry it
      ctx.log('error', `emit failed for ${key}: ${String(err)}`);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, this.cfg.ackTimeoutMs)));
    try {
      await Promise.race([p.catch(() => undefined), deadline]);
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
    const fromBot = ev.sender?.sender_type === 'app' || (!!this.botOpenId && ev.sender?.sender_id?.open_id === this.botOpenId);
    const declared = fromBot ? await this.store.get(mid) : undefined;
    const env = mapMessageEvent(ev, { account: ctx.account, botOpenId: this.botOpenId, declared });
    if (!env) {
      this.dedup.delete(key);
      return;
    }
    await this.deliver(ctx, key, () => ctx.emit(env));
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

  private async api<T extends LarkApiResponse>(op: string, call: () => Promise<T>): Promise<T> {
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

  /** Render one RenderedMessage into the ordered platform messages; the primary one is the editable body. */
  private plan(msg: RenderedMessage): { parts: { out: OutMessage; kind: MsgKind }[]; primary: number } {
    const parts: { out: OutMessage; kind: MsgKind }[] = [];
    if (isLarkCard(msg.channelData)) {
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
    return { parts, primary };
  }

  send(route: ReplyRoute, msg: RenderedMessage, op: SendOp): Promise<SendResult> {
    const prior = this.sends.get(op.operationId);
    if (prior) return prior;
    const run = this.doSend(route, msg, op);
    this.sends.set(op.operationId, run);
    if (this.sends.size > BOUND) {
      const oldest = this.sends.keys().next();
      if (!oldest.done) this.sends.delete(oldest.value);
    }
    run.catch(() => this.sends.delete(op.operationId)); // a failed op may be retried with the same uuids
    return run;
  }

  private async doSend(route: ReplyRoute, msg: RenderedMessage, op: SendOp): Promise<SendResult> {
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

  /** Serialise edits per message and keep `editMinIntervalMs` between patches. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const wait = (this.lastPatchAt.get(id) ?? -Infinity) + this.cfg.editMinIntervalMs - this.now();
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
    if (kind === 'card') {
      const card = isLarkCard(msg.channelData) ? msg.channelData : fitCard(msg, msg.text, this.cfg.maxCardBytes);
      await this.api('message.patch', () => api.patch({ data: { content: JSON.stringify(card) }, path: { message_id: id } }));
    } else {
      const out = textMessage(splitText(msg.text, this.cfg.maxChars)[0] ?? '');
      await this.api('message.update', () =>
        api.update({ data: { msg_type: out.msg_type, content: out.content }, path: { message_id: id } }),
      );
    }
  }

  /** Streaming updates: the target must have been sent as a card (`sections`/`actions`/`link`/`channelData`). */
  async edit(_route: ReplyRoute, providerMessageId: string, msg: RenderedMessage, op: SendOp & { sequence: number }): Promise<void> {
    await this.serial(providerMessageId, async () => {
      const last = this.lastSeq.get(providerMessageId);
      if (last !== undefined && op.sequence <= last) return; // stale or duplicate edit
      bounded(this.lastSeq, providerMessageId, op.sequence);
      await this.patch(providerMessageId, msg);
    });
  }

  async finalize(_route: ReplyRoute, providerMessageId: string, msg: RenderedMessage): Promise<void> {
    await this.serial(providerMessageId, () => this.patch(providerMessageId, msg));
    this.forget(providerMessageId);
  }

  async retract(_route: ReplyRoute, providerMessageId: string, outcome: string): Promise<void> {
    await this.serial(providerMessageId, async () => {
      if ((this.kinds.get(providerMessageId) ?? 'card') === 'card') {
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
}
