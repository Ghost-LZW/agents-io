/**
 * What the lark-bot adapter needs from the platform app, derived from what `src/`
 * actually calls. Provision the app with create-lark-bot and request these;
 * `test/requirements.test.ts` fails if the adapter registers an event or callback
 * that is not listed here.
 */

export interface ScopeRequirement {
  name: string;
  /** What breaks without it. */
  why: string;
  /**
   * `runtime`: the adapter cannot do its job without it.
   * `optional`: a feature degrades (stated in `why`).
   */
  tier: 'runtime' | 'optional';
}

export const TENANT_SCOPES: readonly ScopeRequirement[] = [
  { name: 'im:message:send_as_bot', tier: 'runtime', why: 'message.create / message.reply as the bot' },
  { name: 'im:message', tier: 'runtime', why: 'patch/update/get of messages the bot sent (streaming edits, reconcile)' },
  { name: 'im:message.p2p_msg:readonly', tier: 'runtime', why: 'receive direct messages (im.message.receive_v1)' },
  { name: 'im:message.group_at_msg:readonly', tier: 'runtime', why: 'receive group messages that @ the bot' },
  { name: 'im:message.group_msg', tier: 'optional', why: 'receive group messages that do not @ the bot (observe-only); without it the bot only sees @mentions' },
  { name: 'im:resource', tier: 'optional', why: 'hosts resolve lark-file: attachment refs through the message-resource API' },
  {
    name: 'cardkit:card:write',
    tier: 'optional',
    why: 'process cards as CardKit entities (create, streaming typewriter answer, element updates, card.update); without it they fall back to message patch (no typewriter, whole-card updates every editMinIntervalMs)',
  },
];

/**
 * The native thinking bubble (`POST/PUT /open-apis/im/v1/message_cot`, `process: 'auto' | 'cot'`)
 * has no scope of its own that we could verify: it is sent as the bot like any message, so it
 * rides on `im:message:send_as_bot`. When the platform refuses it, the adapter remembers that per
 * chat (per app for permission codes) and `auto` shows the process in card panels instead.
 */
export const COT_SCOPE_NOTE = 'message_cot uses im:message:send_as_bot; no separate scope verified';

/** Event subscriptions (app identity). The adapter's WS dispatcher registers exactly these. */
export const APP_EVENTS: readonly string[] = ['im.message.receive_v1'];

/** Callbacks (card interactions). */
export const APP_CALLBACKS: readonly string[] = ['card.action.trigger'];

/** Every key the adapter may pass to `dispatcher.register`. */
export const REGISTERABLE_HANDLERS: readonly string[] = [...APP_EVENTS, ...APP_CALLBACKS];

export const tenantScopeNames = (tiers?: ScopeRequirement['tier'][]): string[] =>
  TENANT_SCOPES.filter((s) => !tiers || tiers.includes(s.tier)).map((s) => s.name);

/** Shape of the platform's "batch import/export scopes" box. */
export function scopesJson(tiers?: ScopeRequirement['tier'][]): { scopes: { tenant: string[]; user: string[] } } {
  return { scopes: { tenant: tenantScopeNames(tiers), user: [] } };
}
