import { Type } from '@sinclair/typebox';
import type { ChannelModule } from '@agents-io/protocol';
import { LarkBotAdapter } from './adapter.js';
import { CHANNEL_ID } from './inbound.js';
import { larkBotAdmin } from './provision-admin.js';

/*
 * The lark-bot channel type (`{ "type": "lark-bot", … }`): its config keys, the app each entry
 * runs, the rules across entries (decision 8), how its adapter is built and what it adds to the
 * console (bot provisioning, provision-admin.ts). The daemon registers it in its bundle.
 */

/** A lark-bot entry's config after env substitution, with its app resolved. */
export type LarkChannelConfig = Record<string, unknown> & { appId: string; appSecret: string; domain: 'feishu' | 'lark' };

/** A `lark-bot` entry's own keys, as written. */
export type LarkBotChannelEntry = { type: 'lark-bot'; config?: Record<string, unknown> };

/** A `lark-bot` entry's own keys, resolved: its config with the app. */
export type LarkBotChannelSettings = { type: 'lark-bot'; config: LarkChannelConfig };

/** The keys of an entry's `config` that hold its app's credentials. */
const CREDENTIALS = new Set(['appSecret', 'encryptKey', 'verificationToken']);

/** With several bots, accounts are plain names: they go into route and session keys, separated by ':'. */
const PLAIN_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The entry names its app itself (`config.appId` or `config.appSecret`), instead of reading LARK_APP_*. */
function hasExplicitApp(entry: LarkBotChannelEntry): boolean {
  const c = entry.config;
  return c?.appId !== undefined || c?.appSecret !== undefined;
}

export const larkBotChannelModule: ChannelModule<LarkBotChannelEntry, LarkBotChannelSettings> = {
  type: 'lark-bot',
  ids: [CHANNEL_ID],
  entry: {
    /**
     * Feishu/Lark bot, one app per entry. `config.appId` / `config.appSecret` / `config.domain`
     * (values or "env:NAME"; the whole config is env-substituted) name the app; an entry
     * without them reads LARK_APP_ID / LARK_APP_SECRET / LARK_DOMAIN (at most one such entry).
     */
    config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },

  // `config` is free-form, so the schema cannot mark its app's credentials.
  isCredential: (path) => path.length === 2 && path[0] === 'config' && CREDENTIALS.has(path[1]!),

  resolve(entry, ctx) {
    const where = `${ctx.where}.config`;
    const config = ctx.substitute(entry.config ?? {}, where) as Record<string, unknown>;
    let appId: unknown;
    let appSecret: unknown;
    let domain: unknown;
    if (hasExplicitApp(entry)) {
      if (config.appId === undefined || config.appSecret === undefined) ctx.fail(`${where}: give both appId and appSecret (or neither, to read LARK_APP_ID / LARK_APP_SECRET)`);
      ({ appId, appSecret } = config);
      domain = config.domain ?? 'feishu';
    } else {
      const need = (k: string) => ctx.env[k] || ctx.fail(`channel lark-bot needs ${k} (environment or .env.live), or config.appId / config.appSecret`);
      appId = need('LARK_APP_ID');
      appSecret = need('LARK_APP_SECRET');
      domain = config.domain ?? (ctx.env.LARK_DOMAIN || 'feishu');
    }
    if (typeof appId !== 'string' || !appId) ctx.fail(`${where}.appId must be a non-empty string`);
    if (typeof appSecret !== 'string' || !appSecret) ctx.fail(`${where}.appSecret must be a non-empty string`);
    if (domain !== 'feishu' && domain !== 'lark') ctx.fail(`${where}.domain (or LARK_DOMAIN) must be 'feishu' or 'lark'`);
    return { ...entry, config: { ...config, appId, appSecret, domain } as LarkChannelConfig };
  },

  // Decision 8: one app per entry (two entries of one app would split its events), at most one
  // entry reading LARK_APP_*, accounts unique and, with several bots, plain names.
  validateAll(bots, ctx) {
    const name = (x: (typeof bots)[number]) => `channels[${x.index}] (account ${JSON.stringify(x.resolved.account)})`;
    const fallback = bots.filter((x) => !hasExplicitApp(x.entry));
    if (fallback.length > 1) ctx.fail(`lark-bot channels ${fallback.map(name).join(' and ')} both read LARK_APP_ID; give each its own config.appId / config.appSecret`);
    const seen = new Map<string, (typeof bots)[number]>();
    const apps = new Map<string, (typeof bots)[number]>();
    for (const x of bots) {
      const prior = seen.get(x.resolved.account);
      if (prior) ctx.fail(`lark-bot channels ${name(prior)} and channels[${x.index}] have the same account; accounts must differ`);
      seen.set(x.resolved.account, x);
      const app = `${x.resolved.config.domain}:${x.resolved.config.appId}`;
      const same = apps.get(app);
      // One long connection per app: a second one would get some of its events (Feishu delivers each to one connection).
      if (same) ctx.fail(`lark-bot channels ${name(same)} and ${name(x)} are the same app ${x.resolved.config.appId}; run each app in one entry only (two connections split its events)`);
      apps.set(app, x);
    }
    if (bots.length > 1) {
      for (const x of bots) if (!PLAIN_ACCOUNT.test(x.resolved.account)) ctx.fail(`${name(x)}: with several lark-bot channels, accounts are letters, digits, '.', '_' and '-' (at most 64, not starting with '.', '_' or '-')`);
    } else if (bots[0]?.resolved.account.includes(':')) ctx.warn(`${name(bots[0])}: an account with ':' makes route and session keys ambiguous; use letters, digits, '.', '_' and '-'`);
  },

  create(entry, init) {
    return {
      adapter: new LarkBotAdapter(
        { ...entry.config, look: (entry.config.look ?? 'chat') as 'console' | 'chat' },
        // Open thinking bubbles are recorded here, so a restart closes the ones left spinning.
        { stateDir: init.stateDir },
      ),
    };
  },

  // Bot provisioning from the console: `console.larkBotCommand`, `POST /api/bots/lark`, `GET /api/bots/lark/:job`.
  admin: larkBotAdmin,
};
