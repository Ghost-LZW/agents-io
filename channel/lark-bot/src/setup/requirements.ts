/**
 * Single source of truth for what the lark-bot adapter needs from the platform app.
 * Derived from what `src/` actually calls; `test/setup.test.ts` fails if the adapter
 * registers an event or callback that is not listed here.
 */

export interface ScopeRequirement {
  name: string;
  /** What breaks without it. */
  why: string;
  /**
   * `runtime`: the adapter cannot do its job without it.
   * `optional`: a feature degrades (stated in `why`).
   * `setup`: only the setup tooling (owner resolution, verify) uses it, never the running adapter.
   */
  tier: 'runtime' | 'optional' | 'setup';
}

export const TENANT_SCOPES: readonly ScopeRequirement[] = [
  { name: 'im:message:send_as_bot', tier: 'runtime', why: 'message.create / message.reply as the bot' },
  { name: 'im:message', tier: 'runtime', why: 'patch/update/get of messages the bot sent (streaming edits, reconcile)' },
  { name: 'im:message.p2p_msg:readonly', tier: 'runtime', why: 'receive direct messages (im.message.receive_v1)' },
  { name: 'im:message.group_at_msg:readonly', tier: 'runtime', why: 'receive group messages that @ the bot' },
  { name: 'im:message.group_msg', tier: 'optional', why: 'receive group messages that do not @ the bot (observe-only); without it the bot only sees @mentions' },
  { name: 'im:resource', tier: 'optional', why: 'hosts resolve lark-file: attachment refs through the message-resource API' },
  { name: 'contact:user.base:readonly', tier: 'setup', why: 'resolve the scanner open_id to a union_id when creating the bot' },
  { name: 'application:application:self_manage', tier: 'setup', why: 'verify can read back which scopes the app was granted' },
];

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

/** Addons for the SDK device flow (additive; ignored by the platform unless gray-scale is on). */
export function larkAddons(): {
  preset: boolean;
  scopes: { tenant: string[] };
  events: { items: { tenant: string[] } };
  callbacks: { items: string[] };
} {
  return {
    preset: true,
    scopes: { tenant: tenantScopeNames() },
    events: { items: { tenant: [...APP_EVENTS] } },
    callbacks: { items: [...APP_CALLBACKS] },
  };
}

export type Brand = 'feishu' | 'lark';

export const consoleHost = (brand: Brand): string => (brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn');

export const consoleLinks = (appId: string, brand: Brand) => {
  const home = `${consoleHost(brand)}/app/${appId}`;
  return { home, scopes: `${home}/auth`, events: `${home}/dev-config/event-sub`, versions: `${home}/version` };
};
