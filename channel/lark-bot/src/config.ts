/**
 * How a turn's process (`RenderedMessage.progress`) is shown:
 * - `panels`: one CardKit reply card with collapsible thinking / tools / plan panels.
 * - `cot`: Feishu's native thinking bubble (`message_cot`) for thinking and tool calls; the
 *   reply card carries only status, plan and answer. When the bubble fails, the process is not shown.
 * - `auto`: like `cot` while the bubble API works for the chat, otherwise `panels`.
 * - `off`: no process; the flat text/sections card, which says only 「处理中…」 while the turn runs
 *   (`progress` tells running from ended) and carries the final answer when it ends; a turn with
 *   none (`progress.finalAnswer` unset: failed, interrupted…) ends saying only how it ended.
 */
export type ProcessMode = 'auto' | 'cot' | 'panels' | 'off';

/**
 * What surrounds the answer on a reply card:
 * - `console`: a coloured status header, a status line and an elapsed / tool-count footer.
 * - `chat`: the answer alone, like a person's reply; a status line only while an approval
 *   waits or when the turn failed, was interrupted or has an unknown outcome. Buttons stay.
 */
export type ReplyLook = 'console' | 'chat';

export interface LarkBotConfig {
  appId: string;
  appSecret: string;
  /** `feishu` = open.feishu.cn, `lark` = open.larksuite.com. */
  domain: 'feishu' | 'lark';
  /** Only needed if the app has event encryption enabled. */
  encryptKey?: string;
  verificationToken?: string;
  /**
   * The bot's own open_id, used to detect @mentions of the bot and the bot's own echoes.
   * When omitted it is discovered at start via `GET /open-apis/bot/v3/info`.
   */
  botOpenId?: string;
  /** Advertised `caps.text.maxChars`; longer text is split into several messages. Default 4000. */
  maxChars?: number;
  /** Minimum gap between two card patches (or CardKit full updates) of the same message. Default 1200 (set 0 to disable). */
  editMinIntervalMs?: number;
  /** Largest card JSON (UTF-8 bytes) the adapter sends through message create/patch before truncating. Default 28000. */
  maxCardBytes?: number;
  /** How long a message/event id is remembered to drop redeliveries. Default 600000 (10 min). */
  dedupWindowMs?: number;
  /** Lark requires the WS event ack within 3s; wait at most this long for `emit` before acking. Default 2500. */
  ackTimeoutMs?: number;
  /** Delay before re-creating the WS client after `start()` of the SDK client rejected. Default 5000. */
  reconnectDelayMs?: number;
  /** API error codes from `im.message.get` that mean the message no longer exists. */
  goneCodes?: number[];

  /** Native process rendering. Default `auto`. */
  process?: ProcessMode;
  /**
   * `process` per kind of chat. A chat's kind is learnt from its messages; a chat not heard from yet
   * (a send before any message from it, a restart) could be either, so it gets the strictest mode
   * configured (`unknownChatProcess`): `off` when any of `process`, `processByChat.dm` and
   * `processByChat.group` is `off` — `{ group: "off" }` never shows a process in a group whose kind
   * is not learnt yet, whatever `process` says.
   */
  processByChat?: { dm?: ProcessMode; group?: ProcessMode };
  /**
   * Who sees a process in a DM (fail closed): when set, a DM shows its process (by `processByChat.dm`
   * / `process`) only when the person in it is listed — by any of the ids Lark gives them (union_id,
   * open_id or user_id, as their messages carry). Everyone else's DM, a DM whose person is not
   * known (not heard from since the start), and a chat whose kind is not known yet get `off` (a flat
   * card that says only that it is working while the turn runs: no text so far, no plan). Groups
   * are not affected. `[]`: no DM shows a process. Unset: as before (every DM by its mode).
   * The process shows the agent's thinking, its tools' titles and inputs and their result previews.
   */
  processDmUsers?: string[];
  /** Default `console`. */
  look?: ReplyLook;
  /**
   * When the thinking bubble opens: `turn` = with the reply card, above it; `tool` = at the turn's
   * first tool call, so a turn that only thinks and answers shows no bubble (one opened after the
   * card sits below it). Default `turn`.
   */
  cotOn?: 'turn' | 'tool';
  /**
   * Reactions that acknowledge inbound messages (`ChannelAdapter.acknowledge`; the daemon's channel
   * entry turns acknowledgements on with `ack`). Emoji types from Lark's reaction list.
   * Default `OnIt` / `DONE` / `CrossMark`.
   */
  ackEmoji?: { working?: string; done?: string; failed?: string };
  /** Language of the labels the adapter adds (status, panel titles). Default `zh` on feishu, `en` on lark. */
  locale?: 'zh' | 'en';
  /** Decoration the adapter adds to cards: `emoji` (status icons, panel icons) or `plain`. Default `emoji`. */
  style?: 'emoji' | 'plain';
  /** Entries shown per panel (most recent). Default 8. */
  processMaxEntries?: number;
  /** Characters per panel body. Default 3000. */
  processPanelMaxChars?: number;
  /** Minimum gap between answer (typewriter) updates of a streaming card. Default 1200. */
  streamTextIntervalMs?: number;
  /** Minimum gap between status/panel/footer updates of a streaming card (status changes skip it). Default 1500. */
  streamAuxIntervalMs?: number;
  /** Largest CardKit card JSON (UTF-8 bytes); a longer answer continues in follow-up messages. Default 28000. */
  maxCardKitBytes?: number;
  /** How long a failed CardKit level or thinking bubble is remembered per chat (per app for permission errors). Default 1800000 (30 min). */
  degradeTtlMs?: number;
  /** Timeout of each CardKit / thinking-bubble request. Default 15000. */
  processRequestTimeoutMs?: number;

  // Inbound enrichment. Media are downloaded into the host's blob store (`ChannelContext.blobs`)
  // only when it has one; the event is acked within `ackTimeoutMs` regardless (enrichment
  // continues after the ack, in message order per chat).
  /** Largest attachment downloaded (bytes); larger ones keep their `lark-file:` ref. Default 20 MiB. */
  mediaMaxBytes?: number;
  /** Time budget of one attachment download. Default 30000. */
  mediaTimeoutMs?: number;
  /** Fetch the text of a replied-to message for its quote block (`im.v1.message.get`). Default true. */
  fetchQuotes?: boolean;
  /** Longest quote text kept. Default 500. */
  quoteMaxChars?: number;
  /** Resolve sender display names (`contact.v3.user.get`, needs contact:user.base:readonly). Default true. */
  resolveSenderNames?: boolean;
  /** How long a resolved name is cached. Default 21600000 (6 h). */
  senderNameTtlMs?: number;
  /** Timeout of each message.get / message.list / contact lookup. Default 5000. */
  lookupTimeoutMs?: number;
  /**
   * Earlier messages handed to the agent as context when the bot is @-ed (`ChannelAdapter.history`,
   * docs/CHANNELS.md §1c): up to `thread` messages of the thread (topic) the @ is in, and, in a
   * group chat whose session has had no turn yet, up to `chat` most recent messages of the chat.
   * The gateway drops those the session already has. `false` (or 0) turns one or both off;
   * `true` = the defaults. Default `{ thread: 50, chat: 20 }`, at most 200 each. Needs
   * im:message (or im:message:readonly) and, in groups, im:message.group_msg; without them
   * there is no history (one warning).
   */
  historyOnMention?: boolean | { thread?: number | false; chat?: number | false };
  /**
   * People's emoji reactions on messages this bot sent reach the host as `observe` inputs: an
   * `event` block `reaction` (`{ emoji, action: "added" | "removed", messageId, text }`) from the
   * person, on the conversation the message is in (docs/CHANNELS.md §2). Reactions by apps (this
   * bot's own acknowledgements among them) and on anyone else's messages are ignored. Needs the
   * events `im.message.reaction.created_v1` / `deleted_v1` (im:message.reactions:read or
   * im:message:readonly), `im.v1.message.get` (im:message) and, for a chat no message of which
   * arrived since the start, `im.v1.chat.get` (im:chat:readonly). Default true.
   */
  reactions?: boolean;
}

/** `historyOnMention` defaults. */
export const HISTORY_DEFAULTS = { thread: 50, chat: 20 } as const;
const HISTORY_MAX = 200;

export interface ResolvedConfig extends Required<Omit<LarkBotConfig, 'encryptKey' | 'verificationToken' | 'botOpenId' | 'ackEmoji' | 'historyOnMention' | 'processDmUsers'>> {
  ackEmoji: { working: string; done: string; failed: string };
  /** Unset: every DM by its mode. */
  processDmUsers?: ReadonlySet<string>;
  /** 0 = off. */
  historyOnMention: { thread: number; chat: number };
  encryptKey?: string;
  verificationToken?: string;
  botOpenId?: string;
}

const PROCESS_MODES: readonly ProcessMode[] = ['auto', 'cot', 'panels', 'off'];

/**
 * The process modes, strictest first: `off` shows none; `panels` folds it into the reply card and
 * `cot` shows only the bubble (nothing when it fails), no extra message for `panels`; `auto` may
 * show either.
 */
export const PROCESS_STRICTEST_FIRST: readonly ProcessMode[] = ['off', 'panels', 'cot', 'auto'];

/**
 * The mode of a chat whose kind is not known yet: the strictest of `process` and the modes of
 * `processByChat` (each kind's falling back to `process`) — `off` when any of them is.
 */
export function unknownChatProcess(c: Pick<ResolvedConfig, 'process' | 'processByChat'>): ProcessMode {
  const modes = [c.process, c.processByChat.dm ?? c.process, c.processByChat.group ?? c.process];
  return PROCESS_STRICTEST_FIRST.find((m) => modes.includes(m)) ?? c.process;
}

export function resolveConfig(c: LarkBotConfig): ResolvedConfig {
  if (!c.appId || !c.appSecret) throw new Error('lark-bot: appId and appSecret are required');
  if (c.domain !== 'feishu' && c.domain !== 'lark') throw new Error(`lark-bot: domain must be 'feishu' or 'lark'`);
  if (c.style !== undefined && c.style !== 'emoji' && c.style !== 'plain') throw new Error('lark-bot: style must be emoji or plain');
  for (const [key, mode] of [['process', c.process], ['processByChat.dm', c.processByChat?.dm], ['processByChat.group', c.processByChat?.group]] as const) {
    if (mode !== undefined && !PROCESS_MODES.includes(mode)) throw new Error(`lark-bot: ${key} must be one of ${PROCESS_MODES.join(', ')}`);
  }
  if (c.look !== undefined && c.look !== 'console' && c.look !== 'chat') throw new Error('lark-bot: look must be console or chat');
  if (c.cotOn !== undefined && c.cotOn !== 'turn' && c.cotOn !== 'tool') throw new Error('lark-bot: cotOn must be turn or tool');
  if (c.reactions !== undefined && typeof c.reactions !== 'boolean') throw new Error('lark-bot: reactions must be true or false');
  if (c.processDmUsers !== undefined && (!Array.isArray(c.processDmUsers) || c.processDmUsers.some((id) => typeof id !== 'string' || !id.trim())))
    throw new Error('lark-bot: processDmUsers must be a list of Lark user ids (union_id, open_id or user_id)');
  const historyOnMention = resolveHistory(c.historyOnMention);
  const { processDmUsers, ...rest } = c;
  return {
    ...rest,
    ...(processDmUsers !== undefined ? { processDmUsers: new Set(processDmUsers.map((id) => id.trim())) } : {}),
    maxChars: c.maxChars ?? 4000,
    editMinIntervalMs: c.editMinIntervalMs ?? 1200,
    maxCardBytes: c.maxCardBytes ?? 28_000,
    dedupWindowMs: c.dedupWindowMs ?? 600_000,
    ackTimeoutMs: c.ackTimeoutMs ?? 2500,
    reconnectDelayMs: c.reconnectDelayMs ?? 5000,
    // 230011 / 231003: message recalled / deleted (documented Lark im error codes).
    goneCodes: c.goneCodes ?? [230011, 231003],
    process: c.process ?? 'auto',
    processByChat: c.processByChat ?? {},
    look: c.look ?? 'console',
    cotOn: c.cotOn ?? 'turn',
    ackEmoji: { working: 'OnIt', done: 'DONE', failed: 'CrossMark', ...c.ackEmoji },
    locale: c.locale ?? (c.domain === 'feishu' ? 'zh' : 'en'),
    style: c.style ?? 'emoji',
    processMaxEntries: c.processMaxEntries ?? 8,
    processPanelMaxChars: c.processPanelMaxChars ?? 3000,
    streamTextIntervalMs: c.streamTextIntervalMs ?? 1200,
    streamAuxIntervalMs: c.streamAuxIntervalMs ?? 1500,
    maxCardKitBytes: c.maxCardKitBytes ?? 28_000,
    degradeTtlMs: c.degradeTtlMs ?? 1_800_000,
    processRequestTimeoutMs: c.processRequestTimeoutMs ?? 15_000,
    mediaMaxBytes: c.mediaMaxBytes ?? 20 * 1024 * 1024,
    mediaTimeoutMs: c.mediaTimeoutMs ?? 30_000,
    fetchQuotes: c.fetchQuotes ?? true,
    quoteMaxChars: c.quoteMaxChars ?? 500,
    resolveSenderNames: c.resolveSenderNames ?? true,
    senderNameTtlMs: c.senderNameTtlMs ?? 21_600_000,
    lookupTimeoutMs: c.lookupTimeoutMs ?? 5000,
    historyOnMention,
    reactions: c.reactions ?? true,
  };
}

function resolveHistory(h: LarkBotConfig['historyOnMention']): ResolvedConfig['historyOnMention'] {
  if (h === undefined || h === true) return { ...HISTORY_DEFAULTS };
  if (h === false) return { thread: 0, chat: 0 };
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error('lark-bot: historyOnMention must be true, false or { thread?, chat? }');
  const out = { ...HISTORY_DEFAULTS } as { thread: number; chat: number };
  for (const k of Object.keys(h)) {
    if (k !== 'thread' && k !== 'chat') throw new Error(`lark-bot: historyOnMention has no ${JSON.stringify(k)} (thread, chat)`);
    const v = (h as Record<string, unknown>)[k];
    if (v === false) out[k] = 0;
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= HISTORY_MAX) out[k] = v;
    else throw new Error(`lark-bot: historyOnMention.${k} must be an integer from 0 to ${HISTORY_MAX}, or false`);
  }
  return out;
}
