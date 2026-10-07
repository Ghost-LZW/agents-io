import { createHash } from 'node:crypto';
import { realpath, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  routeKey,
  type BlobStore,
  type ChannelAdapter,
  type ChannelCaps,
  type ContentBlock,
  type InboundEnvelope,
  type Origin,
  type Policy,
  type RenderedMessage,
  type ReplyRoute,
  type Tier,
  type TurnContext,
  type TurnProvenance,
  type Watch,
  type WatchDraft,
} from '@agents-io/protocol';
import type { DeliveryRecord, Hub, InboundRewrite, Outbox } from '@agents-io/session';
import {
  CHOICE_KEY,
  MENTIONS_KEY,
  OUTPUT_KEY,
  choiceActionId,
  mediaKind,
  mimeOf,
  parseChoiceActionId,
  type ChoiceData,
  type MentionsData,
} from './neutral.js';

/** Name of the `native` session event recording one output-tool message (see `OutputRecord`). */
export const OUTPUT_EVENT = 'agents-io.output';

/** What a token authenticates: one harness binding (run) of one session. */
export interface ToolBinding {
  sessionKey: string;
  generation: number;
  harnessId?: string;
}

/** Per-call facts from the MCP request. */
export interface CallMeta {
  /** The harness's own tool-call id (Claude Code `_meta["claudecode/toolUseId"]`, …): the idempotency key. */
  toolCallId?: string;
  /** JSON-RPC request id, the fallback key when the harness sends no call id. */
  requestId?: string | number;
}

/** A tool call the host refuses or cannot complete; the message is shown to the model. */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** `native` payload of an `agents-io.output` event. */
export interface OutputRecord {
  tool: string;
  operationId: string;
  route: ReplyRoute;
  msg: RenderedMessage;
  choice?: ChoiceData;
  /** Where the sending turn's inputs came from (decision 4: tagged, never blocked). */
  provenance?: TurnProvenance;
}

export interface ChoiceRecord extends ChoiceData {
  sessionKey: string;
  turnId: string;
  route: ReplyRoute;
  answered: boolean;
}

export interface HostToolsOptions {
  hub: Hub;
  outbox: Outbox;
  policy: Required<Pick<Policy, 'outbound'>>;
  /** The running turn of a session (`Lane.currentTurn()`), undefined when idle. */
  turn(sessionKey: string): TurnContext | undefined;
  /** The adapter that sends on a channel. */
  adapter(channel: string): ChannelAdapter | undefined;
  /** Where file bytes go; adapters read attachments back from the same store. */
  blobs: BlobStore;
  /** Working directory relative paths resolve against (the harness session's cwd). */
  cwd(sessionKey: string): string;
  /** Rendering tier of a route (default: the adapter's `caps.defaultTier`). */
  tier?(route: ReplyRoute): Tier | undefined;
  /** Route keys the owner preregistered (shown by get_channel_context). */
  routes?(): string[];
  /** Channels with no adapter whose ends read the event stream (default `['local']`). */
  eventOnlyChannels?: string[];
  /** Largest file send_file reads (default 30 MiB, Lark's upload limit). */
  maxFileBytes?: number;
  /** May this turn send this file? Default: inside the cwd, or anywhere for a `bypass` turn. */
  fileAccess?(args: { path: string; cwd: string; turn: TurnContext }): boolean | Promise<boolean>;
  /** Sender identity attached to sends (required by channels with `caps.declaresSender`). */
  as?(sessionKey: string): string | undefined;
  /** Watch control (dev-gateway `addWatch`/`removeWatch`/`listWatches`); absent = no watch tools. */
  watches?: WatchControl;
  /** Provenance of a session's turn (`Lane.provenance`), attached to every write the turn makes. */
  provenance?(sessionKey: string, turnId: string): TurnProvenance | undefined;
}

/** What the watch tools need from the host; `Policy.watch` is applied behind `add`. */
export interface WatchControl {
  add(by: Origin, draft: WatchDraft): Promise<{ ok: true; watch: Watch } | { ok: false; code: string; message: string }>;
  remove(by: Origin, id: string): Promise<{ ok: true; removed: boolean } | { ok: false; code: string; message: string }>;
  list(sessionKey: string): Watch[];
}

/** Declared identity of a session's agent: what its watches are created by. */
export const agentIdentity = (sessionKey: string) => `session:${sessionKey}`;

/** The origin a session's agent acts with: kind `agent`, no principal, declared = its session identity. */
export function agentOrigin(sessionKey: string): Origin {
  return { kind: 'agent', principal: null, evidence: 'none', declared: agentIdentity(sessionKey), via: `agent:${sessionKey}`, adapter: 'host-mcp' };
}

const WATCH_KINDS = ['dm', 'group', 'thread', 'meeting', 'mail', 'other'];
const WATCH_MODES = ['context', 'digest', 'trigger'];

/** Caps of an event-only end (the terminal): it prints whatever the stream says. */
const EVENT_ONLY_CAPS: ChannelCaps = {
  text: { maxChars: 100_000, markdown: 'full' },
  edit: false,
  buttons: false,
  media: { in: [], out: ['image', 'file', 'audio'] },
  voiceOut: 'none',
  threads: false,
  approvals: 'buttons',
  defaultTier: 'full',
  evidence: ['device_only'],
  declaresSender: false,
};

const MAX_OPTIONS = 10;
const NUMBERS = /^\s*#?\d+(?:\s*[,，、;\s]\s*#?\d+)*\s*$/;

const str = (v: unknown, what: string, opt = false): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (opt) return undefined;
    throw new ToolError(`${what} is required`);
  }
  if (typeof v !== 'string') throw new ToolError(`${what} must be a string`);
  return v;
};

/**
 * The output tools, independent of MCP. Every call resolves the session's running
 * turn, checks the destination against `Policy.outbound`, delivers through the
 * Outbox (operationId from the tool call id, so a retried call never sends twice)
 * and records what was sent as an `agents-io.output` event; the Outbox adds
 * `delivery.settled`. Channel specifics stay in the adapters: tools only build a
 * neutral `RenderedMessage` (text fallback + attachments/actions/channelData).
 */
export class HostTools {
  private readonly choices = new Map<string, ChoiceRecord>();
  private readonly eventOnly: Set<string>;

  constructor(private readonly o: HostToolsOptions) {
    this.eventOnly = new Set(o.eventOnlyChannels ?? ['local']);
  }

  /**
   * Provenance of the turn running in the binding's session, if any: what the host
   * sees with each write (output records, `onCall`). Since harnesses take their
   * environment per session, not per turn, this is how it reaches the host.
   */
  provenanceOf(b: ToolBinding): TurnProvenance | undefined {
    const turn = this.o.turn(b.sessionKey);
    return turn ? this.o.provenance?.(b.sessionKey, turn.turnId) : undefined;
  }

  /** Whether the watch tools are offered (the host passed `watches`). */
  get hasWatches(): boolean {
    return !!this.o.watches;
  }

  /** Run one tool. Returns the JSON text result; throws ToolError for anything the model should fix. */
  async call(b: ToolBinding, name: string, args: Record<string, unknown>, meta: CallMeta = {}): Promise<string> {
    if (name === 'watch_add' || name === 'watch_remove' || name === 'watch_list') return json(await this.watchTool(b, name, args));
    const turn = this.o.turn(b.sessionKey);
    if (!turn) throw new ToolError('no turn is running in this session: output tools only work while you are answering a message');
    const key = meta.toolCallId ?? `g${b.generation}:${turn.turnId}:rpc${meta.requestId ?? Math.random().toString(36).slice(2)}`;
    const operationId = `tool:${b.sessionKey}:${key}`;
    switch (name) {
      case 'get_channel_context':
        return json(this.channelContext(b, turn));
      case 'send_file':
        return json(await this.sendFile(b, turn, args, operationId));
      case 'ask_choice':
        return json(await this.askChoice(b, turn, args, operationId));
      case 'mention':
        return json(await this.mention(b, turn, args, operationId));
      case 'reply_to':
      case 'send_message':
        return json(await this.message(b, turn, name, args, operationId));
      default:
        throw new ToolError(`unknown tool ${name}`);
    }
  }

  // ---- context ----------------------------------------------------------------------------

  private caps(route: ReplyRoute): ChannelCaps {
    if (this.eventOnly.has(route.channel)) return EVENT_ONLY_CAPS;
    const a = this.o.adapter(route.channel);
    if (!a) throw new ToolError(`no channel adapter for ${route.channel}`);
    return a.caps(route.account);
  }

  private participants(turn: TurnContext): { principal?: string; userId?: string; name?: string; channel?: string }[] {
    const out = new Map<string, { principal?: string; userId?: string; name?: string; channel?: string }>();
    for (const i of turn.inputs) {
      const ch = i.origin.adapter;
      const pid = i.origin.principal?.id;
      const ctxId = i.channelContext.senderId;
      const userId = typeof ctxId === 'string' ? ctxId : pid?.startsWith(`${ch}:`) ? pid.slice(ch.length + 1) : undefined;
      const name = typeof i.channelContext.senderName === 'string' ? i.channelContext.senderName : undefined;
      const k = userId ?? pid ?? name;
      if (!k || out.has(k)) continue;
      out.set(k, { ...(pid ? { principal: pid } : {}), ...(userId ? { userId } : {}), ...(name ? { name } : {}), channel: ch });
    }
    return [...out.values()];
  }

  private channelContext(_b: ToolBinding, turn: TurnContext) {
    const r = turn.replyRoute;
    const first = turn.inputs[0]?.channelContext ?? {};
    const pre = this.o.routes?.() ?? [];
    if (!r) return { turnId: turn.turnId, replyRoute: null, note: 'this turn has no reply route', preregisteredRoutes: pre };
    const caps = this.caps(r);
    return {
      turnId: turn.turnId,
      route: routeKey(r),
      channel: r.channel,
      conversationKind: first.conversationKind ?? null,
      tier: this.o.tier?.(r) ?? caps.defaultTier,
      caps: {
        markdown: caps.text.markdown,
        maxChars: caps.text.maxChars,
        buttons: caps.buttons,
        editsMessages: caps.edit,
        threads: caps.threads,
        mediaOut: caps.media.out,
        approvals: caps.approvals,
      },
      participants: this.participants(turn),
      allowedDestinations: {
        current: routeKey(r),
        alsoThisTurn: turn.deliveries.map(routeKey),
        preregistered: pre,
        note: 'reply_to/send_message accept "current" or one of these route keys; anything else is denied by the host policy',
      },
      eventOnly: this.eventOnly.has(r.channel) || undefined,
    };
  }

  // ---- destinations -----------------------------------------------------------------------

  private knownRoutes(turn: TurnContext): ReplyRoute[] {
    return [turn.replyRoute, ...turn.deliveries, ...turn.inputs.map((i) => i.replyRoute)].filter((r): r is ReplyRoute => !!r);
  }

  /** "current" (or nothing) = the turn's reply route; otherwise a route key. */
  private parseRoute(turn: TurnContext, spec: string | undefined): ReplyRoute {
    if (spec === undefined || spec === 'current' || spec === 'reply') {
      if (!turn.replyRoute) throw new ToolError('this turn has no reply route; name a destination route key');
      return turn.replyRoute;
    }
    const known = this.knownRoutes(turn).find((r) => routeKey(r) === spec);
    if (known) return known;
    const parts = spec.split(':');
    if (parts.length < 3 || parts.some((p) => !p)) throw new ToolError(`route must be "current" or a route key channel:account:conversation[:thread], got ${JSON.stringify(spec)}`);
    const [channel, account, ...rest] = parts;
    return { channel: channel!, account: account!, conversationId: rest.join(':') };
  }

  private async allowed(b: ToolBinding, turn: TurnContext, tool: string, route: ReplyRoute): Promise<void> {
    const verdict = await this.o.policy.outbound({ from: turn, to: route });
    if (verdict === 'allow') return;
    const k = routeKey(route);
    const pre = this.o.routes?.() ?? [];
    this.o.hub.append(b.sessionKey, {
      ts: Date.now(),
      turnId: turn.turnId,
      level: 'detail',
      audience: 'status',
      durability: 'durable',
      visibility: 'operators',
      body: { t: 'notice', code: 'other', message: `${tool} to ${k} denied by outbound policy` },
    });
    const allowedList = [turn.replyRoute ? `this turn's reply route (${routeKey(turn.replyRoute)})` : undefined, pre.length ? `preregistered routes ${pre.join(', ')}` : undefined]
      .filter(Boolean)
      .join(' and ');
    throw new ToolError(`destination ${k} is not allowed by the host's outbound policy; allowed: ${allowedList || 'none'}. Do not retry with another destination unless the user asks for it.`);
  }

  private async deliver(b: ToolBinding, turn: TurnContext, tool: string, route: ReplyRoute, msg: RenderedMessage, operationId: string, choice?: ChoiceData): Promise<DeliveryRecord> {
    const prior = this.o.outbox.get(operationId);
    const body: RenderedMessage = { ...msg, channelData: { ...(msg.channelData as object | undefined), [OUTPUT_KEY]: { tool } } };
    if (!prior) {
      const provenance = this.o.provenance?.(b.sessionKey, turn.turnId);
      const rec: OutputRecord = { tool, operationId, route, msg: body, ...(choice ? { choice } : {}), ...(provenance ? { provenance } : {}) };
      this.o.hub.append(b.sessionKey, {
        ts: Date.now(),
        turnId: turn.turnId,
        level: 'primary',
        audience: 'answer',
        durability: 'durable',
        visibility: 'participants',
        body: { t: 'native', name: OUTPUT_EVENT },
        native: rec,
      });
    }
    let rec: DeliveryRecord;
    const d = { operationId, sessionKey: b.sessionKey, turnId: turn.turnId, route };
    if (this.eventOnly.has(route.channel)) {
      // The terminal and other stream ends render the output event themselves.
      rec = await this.o.outbox.deliver(d, async () => ({ providerMessageId: operationId }));
    } else {
      const adapter = this.o.adapter(route.channel);
      if (!adapter) throw new ToolError(`no channel adapter for ${route.channel}`);
      const as = this.o.as?.(b.sessionKey);
      rec = await this.o.outbox.send(adapter, { ...d, msg: body, ...(as !== undefined ? { as } : {}) });
    }
    if (rec.status !== 'delivered') throw new ToolError(`delivery to ${routeKey(route)} ${rec.status}${rec.error ? `: ${rec.error}` : ''}`);
    return rec;
  }

  private sent(rec: DeliveryRecord, extra: Record<string, unknown> = {}) {
    return { ok: true, delivered: routeKey(rec.route), operationId: rec.operationId, ...(rec.providerMessageId && rec.providerMessageId !== rec.operationId ? { messageId: rec.providerMessageId } : {}), ...extra };
  }

  // ---- tools ------------------------------------------------------------------------------

  private async sendFile(b: ToolBinding, turn: TurnContext, args: Record<string, unknown>, operationId: string) {
    const path = str(args.path, 'path', true);
    const blob = str(args.blob, 'blob', true);
    const caption = str(args.caption, 'caption', true);
    let name = str(args.name, 'name', true);
    if (!path === !blob) throw new ToolError('give exactly one of path (a file on disk) or blob (a blob ref such as sha256:…)');
    const route = this.parseRoute(turn, undefined);
    await this.allowed(b, turn, 'send_file', route);
    let ref: string;
    let mime: string;
    let size: number;
    if (path) {
      const cwd = this.o.cwd(b.sessionKey);
      const abs = isAbsolute(path) ? path : resolve(cwd, path);
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        throw new ToolError(`file not found: ${path} (relative paths resolve against ${cwd})`);
      }
      const st = await stat(real);
      if (!st.isFile()) throw new ToolError(`${path} is not a regular file`);
      const max = this.o.maxFileBytes ?? 30 * 1024 * 1024;
      if (st.size === 0) throw new ToolError(`${path} is empty`);
      if (st.size > max) throw new ToolError(`${path} is ${st.size} bytes; the limit is ${max}`);
      const access = this.o.fileAccess;
      const ok = access ? await access({ path: real, cwd, turn }) : turn.run.profile === 'bypass' || inside(real, await realpath(cwd).catch(() => cwd));
      if (!ok) throw new ToolError(`${path} is outside the working directory and this turn may not send it`);
      name ??= basename(real);
      mime = mimeOf(name);
      const bytes = new Uint8Array(await readFile(real));
      size = bytes.byteLength;
      ref = await this.o.blobs.put(bytes, { mime, name });
    } else {
      let got;
      try {
        got = await this.o.blobs.get(blob!);
      } catch {
        throw new ToolError(`unknown blob ${blob}`);
      }
      ref = blob!;
      mime = got.mime;
      name ??= got.name ?? 'file';
      size = got.bytes.byteLength;
    }
    const caps = this.caps(route);
    const kind = mediaKind(mime);
    const sendAs = caps.media.out.includes(kind) ? kind : caps.media.out.includes('file') ? 'file' : undefined;
    if (!sendAs) throw new ToolError(`${route.channel} cannot send files (caps.media.out is empty)`);
    // An image the channel can only send as a file goes as a generic file.
    const sendMime = sendAs === kind ? mime : 'application/octet-stream';
    const msg: RenderedMessage = { text: caption ?? '', attachments: [{ ref, mime: sendMime, name }] };
    const rec = await this.deliver(b, turn, 'send_file', route, msg, operationId);
    return this.sent(rec, { name, mime: sendMime, bytes: size, ref });
  }

  private async askChoice(b: ToolBinding, turn: TurnContext, args: Record<string, unknown>, operationId: string) {
    const question = str(args.question, 'question')!;
    const options = args.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS || options.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new ToolError(`options must be 2 to ${MAX_OPTIONS} non-empty strings`);
    }
    const multi = args.multi === true;
    const route = this.parseRoute(turn, undefined);
    await this.allowed(b, turn, 'ask_choice', route);
    const choiceId = `ch_${createHash('sha256').update(operationId).digest('hex').slice(0, 10)}`;
    const opts = (options as string[]).map((x) => x.trim());
    const caps = this.caps(route);
    const numbered = opts.map((x, i) => `${i + 1}. ${x}`).join('\n');
    const how = this.eventOnly.has(route.channel)
      ? `Answer with /choose ${choiceId} <number>${multi ? '[,<number>…]' : ''}`
      : multi
        ? 'Reply with the numbers of your choices, e.g. 1,3'
        : 'Reply with the number of your choice';
    const choice: ChoiceData = { choiceId, question, options: opts, multi };
    const msg: RenderedMessage = caps.buttons
      ? { text: question, actions: opts.map((label, i) => ({ id: choiceActionId(choiceId, i + 1), label })), channelData: { [CHOICE_KEY]: choice } }
      : { text: `${question}\n\n${numbered}\n\n${how}`, channelData: { [CHOICE_KEY]: choice } };
    const existing = this.choices.get(choiceId);
    this.choices.set(choiceId, existing ?? { ...choice, sessionKey: b.sessionKey, turnId: turn.turnId, route, answered: false });
    const rec = await this.deliver(b, turn, 'ask_choice', route, msg, operationId, choice);
    return this.sent(rec, {
      choiceId,
      note: 'The question is shown to the user now. Their answer is NOT returned here: it arrives as your next input, an [event choice] with this choiceId and the selected option(s) (or a plain-text reply). End your turn now with a short line saying you are waiting; do not call ask_choice again for the same question.',
    });
  }

  private async mention(b: ToolBinding, turn: TurnContext, args: Record<string, unknown>, operationId: string) {
    const ids = args.user_ids;
    const text = str(args.text, 'text')!;
    if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string' || !x)) throw new ToolError('user_ids must be a non-empty array of user id strings');
    const route = this.parseRoute(turn, undefined);
    await this.allowed(b, turn, 'mention', route);
    const people = this.participants(turn);
    const targets = (ids as string[]).map((raw) => {
      const id = raw.startsWith(`${route.channel}:`) ? raw.slice(route.channel.length + 1) : raw;
      const p = people.find((x) => x.userId === id || x.principal === raw);
      return { id, ...(p?.name ? { name: p.name } : {}) };
    });
    const data: MentionsData = { targets, text };
    const fallback = `${targets.map((t) => `@${t.name ?? t.id}`).join(' ')} ${text}`;
    const rec = await this.deliver(b, turn, 'mention', route, { text: fallback, channelData: { [MENTIONS_KEY]: data } }, operationId);
    return this.sent(rec, { mentioned: targets.map((t) => t.id) });
  }

  private async message(b: ToolBinding, turn: TurnContext, tool: 'reply_to' | 'send_message', args: Record<string, unknown>, operationId: string) {
    const text = str(args.text, 'text')!;
    const spec = str(args.route, 'route');
    let route = this.parseRoute(turn, spec);
    if (tool === 'send_message') {
      const { replyToMessageId: _r, ...rest } = route;
      route = rest;
    } else {
      const mid = str(args.message_id, 'message_id', true);
      if (mid) route = { ...route, replyToMessageId: mid };
    }
    await this.allowed(b, turn, tool, route);
    this.caps(route); // fails clearly when there is no adapter for the channel
    const rec = await this.deliver(b, turn, tool, route, { text }, operationId);
    return this.sent(rec);
  }

  // ---- watches ----------------------------------------------------------------------------

  private async watchTool(b: ToolBinding, name: 'watch_add' | 'watch_remove' | 'watch_list', args: Record<string, unknown>) {
    const w = this.o.watches;
    if (!w) throw new ToolError('watches are not available on this host');
    const by = agentOrigin(b.sessionKey);
    const me = agentIdentity(b.sessionKey);
    const view = (x: Watch) => ({ ...x, mine: x.createdBy === me });
    if (name === 'watch_list') return { ok: true, session: b.sessionKey, watches: w.list(b.sessionKey).map(view) };
    if (name === 'watch_remove') {
      const id = str(args.id, 'id')!;
      const existing = w.list(b.sessionKey).find((x) => x.id === id);
      if (existing && existing.createdBy !== me) throw new ToolError(`watch ${id} was created by ${existing.createdBy}; you may only remove watches you created`);
      const r = await w.remove(by, id);
      if (!r.ok) throw new ToolError(r.code === 'forbidden' ? `you may only remove watches you created (${r.message})` : r.message);
      return { ok: true, removed: r.removed, id };
    }
    // watch_add: the target is always the caller's own session.
    if (args.target !== undefined || args.sessionKey !== undefined) throw new ToolError('watch_add has no target: a watch always delivers to your own session; remove the target argument');
    const src = args.source as Record<string, unknown> | undefined;
    if (!src || typeof src !== 'object') throw new ToolError('source is required: { channel, account?, conversation?, conversationKind?, senders? }');
    const channel = str(src.channel, 'source.channel')!;
    const kind = str(src.conversationKind, 'source.conversationKind', true);
    if (kind && !WATCH_KINDS.includes(kind)) throw new ToolError(`source.conversationKind must be one of ${WATCH_KINDS.join(', ')}`);
    const mode = str(args.mode, 'mode')!;
    if (!WATCH_MODES.includes(mode)) throw new ToolError(`mode must be one of ${WATCH_MODES.join(', ')}`);
    const senders = Array.isArray(src.senders) ? (src.senders as unknown[]).map(String) : undefined;
    const keywords = Array.isArray(args.keywords) ? (args.keywords as unknown[]).map(String) : undefined;
    const mentions = Array.isArray(args.mentions) ? (args.mentions as unknown[]).map(String) : undefined;
    const every = typeof args.digest_every_minutes === 'number' ? args.digest_every_minutes : undefined;
    const maxItems = typeof args.digest_max_items === 'number' ? args.digest_max_items : undefined;
    if (mode === 'digest' && every === undefined) throw new ToolError('digest mode needs digest_every_minutes');
    const expiresIn = typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
    const id = str(args.id, 'id', true);
    const note = str(args.note, 'note', true);
    const account = str(src.account, 'source.account', true);
    const conversation = str(src.conversation, 'source.conversation', true);
    const draft: WatchDraft = {
      ...(id ? { id } : {}),
      source: { channel, ...(account ? { account } : {}), ...(conversation ? { conversation } : {}), ...(kind ? { conversationKind: kind as never } : {}), ...(senders?.length ? { senders } : {}) },
      ...(keywords?.length || mentions?.length ? { filter: { ...(keywords?.length ? { keywords } : {}), ...(mentions?.length ? { mentions } : {}) } } : {}),
      target: { sessionKey: b.sessionKey },
      mode: mode as WatchDraft['mode'],
      ...(mode === 'digest' ? { digest: { everyMs: Math.round(every! * 60_000), ...(maxItems ? { maxItems } : {}) } } : {}),
      ...(expiresIn ? { expiresAt: Date.now() + Math.round(expiresIn * 60_000) } : {}),
      ...(note ? { note } : {}),
    };
    const r = await w.add(by, draft);
    if (!r.ok) {
      const what = [channel, account, conversation ?? kind].filter(Boolean).join(':');
      if (r.code === 'forbidden' && /not allowed to watch/.test(r.message))
        throw new ToolError(`the source ${what} is not on the owner's watch allowlist, so you cannot watch it; ask the owner to add it (policy.watchAllowlist) or to create the watch themselves`);
      throw new ToolError(r.message);
    }
    return { ok: true, watch: view(r.watch) };
  }

  // ---- answers coming back ----------------------------------------------------------------

  /** A choice this gateway asked (memory first, then the session logs: survives a restart). */
  choice(choiceId: string): ChoiceRecord | undefined {
    const hit = this.choices.get(choiceId);
    if (hit) return hit;
    const log = this.o.hub.log;
    for (const sk of log.sessions()) {
      for (const e of log.read(sk, 0)) {
        if (e.body.t !== 'native' || e.body.name !== OUTPUT_EVENT) continue;
        const r = e.native as OutputRecord | undefined;
        if (r?.choice?.choiceId !== choiceId) continue;
        const rec: ChoiceRecord = { ...r.choice, sessionKey: sk, turnId: e.turnId ?? '', route: r.route, answered: false };
        this.choices.set(choiceId, rec);
        return rec;
      }
    }
    return undefined;
  }

  /** The `choice` event block for an answer. Numbers are 1-based. Throws ToolError for a bad answer. */
  choiceAnswer(choiceId: string, numbers: number[], via: 'button' | 'reply' | 'command'): { sessionKey: string; content: ContentBlock[] } {
    const c = this.choice(choiceId);
    if (!c) throw new ToolError(`unknown choice ${choiceId}`);
    const picked = [...new Set(numbers)];
    if (!picked.length || picked.some((n) => !Number.isInteger(n) || n < 1 || n > c.options.length)) {
      throw new ToolError(`choose between 1 and ${c.options.length}`);
    }
    if (!c.multi && picked.length > 1) throw new ToolError('this question takes one answer');
    const stale = c.answered;
    c.answered = true;
    return {
      sessionKey: c.sessionKey,
      content: [
        {
          type: 'event',
          name: 'choice',
          data: {
            choiceId,
            question: c.question,
            selected: picked.map((n) => ({ n, label: c.options[n - 1]! })),
            multi: c.multi,
            via,
            ...(stale ? { alreadyAnswered: true } : {}),
          },
        },
      ],
    };
  }

  /**
   * `IngressOptions.rewrite`: a click on an ask_choice button, or a plain numbered
   * reply on the route where a choice is still open, becomes a `choice` event for
   * the session that asked.
   */
  rewriteInbound({ env }: { env: InboundEnvelope; origin: Origin; sessionKey: string }): InboundRewrite | undefined {
    const c0 = env.content[0];
    if (env.content.length === 1 && c0?.type === 'event' && c0.name === 'action' && typeof c0.data.actionId === 'string') {
      const a = parseChoiceActionId(c0.data.actionId);
      if (!a) return undefined;
      let numbers: number[];
      if (a.n === 'form') {
        const fv = c0.data.formValue as Record<string, unknown> | undefined;
        const raw = fv ? Object.values(fv).flat() : [];
        numbers = raw.map((x) => Number(x)).filter((n) => Number.isFinite(n));
      } else numbers = [a.n];
      try {
        return this.choiceAnswer(a.choiceId, numbers, 'button');
      } catch (e) {
        return { content: [{ type: 'text', text: `[choice click ignored: ${(e as Error).message}]` }] };
      }
    }
    if (!env.replyRoute || !env.content.length || env.content.some((c) => c.type !== 'text' && !(c.type === 'quote'))) return undefined;
    const text = env.content
      .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .split('\n')
      .filter((l) => l.trim() && !/^subject:/i.test(l.trim()))
      .join(' ');
    if (!NUMBERS.test(text)) return undefined;
    const here = routeKey(env.replyRoute);
    const open = [...this.choices.values()].filter((c) => !c.answered && routeKey(c.route) === here).at(-1);
    if (!open) return undefined;
    const numbers = text.match(/\d+/g)!.map(Number);
    try {
      return this.choiceAnswer(open.choiceId, numbers, 'reply');
    } catch {
      return undefined; // not a valid answer: leave the text as it is
    }
  }

  /** Local clients: enrich a `choice` event (`{choiceId, selected: [n…]}`) into the full answer. */
  normalizeLocal(content: ContentBlock[]): ContentBlock[] {
    return content.flatMap((c) => {
      if (c.type !== 'event' || c.name !== 'choice' || typeof c.data.choiceId !== 'string') return [c];
      const sel = Array.isArray(c.data.selected) ? c.data.selected : [c.data.selected];
      const numbers = sel.map((x) => (typeof x === 'object' && x ? Number((x as { n?: unknown }).n) : Number(x)));
      return this.choiceAnswer(c.data.choiceId, numbers, 'command').content;
    });
  }
}

function inside(p: string, dir: string): boolean {
  const r = relative(dir, p);
  // `..notes` is a name inside `dir`; only `..` itself or a `../` prefix leaves it.
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

function json(v: unknown): string {
  return JSON.stringify(v);
}
