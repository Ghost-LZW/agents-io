/**
 * How a turn's process (`RenderedMessage.progress`) is shown:
 * - `panels`: one CardKit reply card with collapsible thinking / tools / plan panels.
 * - `cot`: Feishu's native thinking bubble (`message_cot`) for thinking and tool calls; the
 *   reply card carries only status, plan and answer. When the bubble fails, the process is not shown.
 * - `auto`: like `cot` while the bubble API works for the chat, otherwise `panels`.
 * - `off`: ignore `progress`; render the flat text/sections card as before.
 */
export type ProcessMode = 'auto' | 'cot' | 'panels' | 'off';

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
  /** Language of the labels the adapter adds (status, panel titles). Default `zh` on feishu, `en` on lark. */
  locale?: 'zh' | 'en';
  /** Entries shown per panel (most recent). Default 8. */
  processMaxEntries?: number;
  /** Characters per panel body. Default 3000. */
  processPanelMaxChars?: number;
  /** Minimum gap between answer (typewriter) updates of a streaming card. Default 600. */
  streamTextIntervalMs?: number;
  /** Minimum gap between status/panel/footer updates of a streaming card (status changes skip it). Default 1500. */
  streamAuxIntervalMs?: number;
  /** Largest CardKit card JSON (UTF-8 bytes); a longer answer continues in follow-up messages. Default 100000. */
  maxCardKitBytes?: number;
  /** How long a failed CardKit level or thinking bubble is remembered per chat (per app for permission errors). Default 1800000 (30 min). */
  degradeTtlMs?: number;
  /** Timeout of each CardKit / thinking-bubble request. Default 15000. */
  processRequestTimeoutMs?: number;
}

export interface ResolvedConfig extends Required<Omit<LarkBotConfig, 'encryptKey' | 'verificationToken' | 'botOpenId'>> {
  encryptKey?: string;
  verificationToken?: string;
  botOpenId?: string;
}

const PROCESS_MODES: readonly ProcessMode[] = ['auto', 'cot', 'panels', 'off'];

export function resolveConfig(c: LarkBotConfig): ResolvedConfig {
  if (!c.appId || !c.appSecret) throw new Error('lark-bot: appId and appSecret are required');
  if (c.domain !== 'feishu' && c.domain !== 'lark') throw new Error(`lark-bot: domain must be 'feishu' or 'lark'`);
  if (c.process !== undefined && !PROCESS_MODES.includes(c.process)) {
    throw new Error(`lark-bot: process must be one of ${PROCESS_MODES.join(', ')}`);
  }
  return {
    ...c,
    maxChars: c.maxChars ?? 4000,
    editMinIntervalMs: c.editMinIntervalMs ?? 1200,
    maxCardBytes: c.maxCardBytes ?? 28_000,
    dedupWindowMs: c.dedupWindowMs ?? 600_000,
    ackTimeoutMs: c.ackTimeoutMs ?? 2500,
    reconnectDelayMs: c.reconnectDelayMs ?? 5000,
    // 230011 / 231003: message recalled / deleted (documented Lark im error codes).
    goneCodes: c.goneCodes ?? [230011, 231003],
    process: c.process ?? 'auto',
    locale: c.locale ?? (c.domain === 'feishu' ? 'zh' : 'en'),
    processMaxEntries: c.processMaxEntries ?? 8,
    processPanelMaxChars: c.processPanelMaxChars ?? 3000,
    streamTextIntervalMs: c.streamTextIntervalMs ?? 600,
    streamAuxIntervalMs: c.streamAuxIntervalMs ?? 1500,
    maxCardKitBytes: c.maxCardKitBytes ?? 100_000,
    degradeTtlMs: c.degradeTtlMs ?? 1_800_000,
    processRequestTimeoutMs: c.processRequestTimeoutMs ?? 15_000,
  };
}
