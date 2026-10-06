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
  /** Minimum gap between two card patches of the same message. Default 1200 (set 0 to disable). */
  editMinIntervalMs?: number;
  /** Largest card JSON (UTF-8 bytes) the adapter will send before truncating body text. Default 28000. */
  maxCardBytes?: number;
  /** How long a message/event id is remembered to drop redeliveries. Default 600000 (10 min). */
  dedupWindowMs?: number;
  /** Lark requires the WS event ack within 3s; wait at most this long for `emit` before acking. Default 2500. */
  ackTimeoutMs?: number;
  /** Delay before re-creating the WS client after `start()` of the SDK client rejected. Default 5000. */
  reconnectDelayMs?: number;
  /** API error codes from `im.message.get` that mean the message no longer exists. */
  goneCodes?: number[];
}

export interface ResolvedConfig extends Required<Omit<LarkBotConfig, 'encryptKey' | 'verificationToken' | 'botOpenId'>> {
  encryptKey?: string;
  verificationToken?: string;
  botOpenId?: string;
}

export function resolveConfig(c: LarkBotConfig): ResolvedConfig {
  if (!c.appId || !c.appSecret) throw new Error('lark-bot: appId and appSecret are required');
  if (c.domain !== 'feishu' && c.domain !== 'lark') throw new Error(`lark-bot: domain must be 'feishu' or 'lark'`);
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
  };
}
