import { defaultLarkDeps } from '../sdk.js';
import type { LarkDeps } from '../types.js';
import { consoleHost, consoleLinks, scopesJson, TENANT_SCOPES, type Brand, type ScopeRequirement } from './requirements.js';

export type CheckStatus = 'ok' | 'fail' | 'unknown' | 'skipped';

export interface Check {
  id: 'credentials' | 'bot' | 'scopes' | 'events' | 'ws';
  status: CheckStatus;
  detail: string;
  /** Console deep link where the user can fix it by hand. */
  link?: string;
}

export interface VerifyReport {
  appId: string;
  brand: Brand;
  /** False when a check failed or a runtime scope is missing. `unknown` never counts as a pass or a fail. */
  ok: boolean;
  checks: Check[];
  /** Requirements not found among the granted scopes (empty when the readback was unknown). */
  missingScopes: ScopeRequirement[];
  /** Paste into the console's batch import box if addons were ignored at creation. */
  scopesJson: ReturnType<typeof scopesJson>;
  links: ReturnType<typeof consoleLinks>;
}

export interface VerifyDeps extends Partial<LarkDeps> {
  fetch?: typeof fetch;
}

export interface VerifyOptions {
  appId: string;
  appSecret: string;
  brand: Brand;
  /** Also start the WebSocket client and wait for a connection. */
  live?: boolean;
  timeoutMs?: number;
}

const NO_PERM = 99991672;

function msgOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/[A-Za-z0-9_-]{24,}/g, '***');
}

async function tenantToken(f: typeof fetch, o: VerifyOptions, signal: AbortSignal): Promise<Check> {
  try {
    const res = await f(`${consoleHost(o.brand)}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: o.appId, app_secret: o.appSecret }),
      signal,
    });
    const body = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string };
    if (body.code === 0 && body.tenant_access_token) return { id: 'credentials', status: 'ok', detail: 'tenant_access_token obtained' };
    return { id: 'credentials', status: 'fail', detail: `tenant token refused (code ${body.code ?? '?'}): ${body.msg ?? ''}`.trim() };
  } catch (e) {
    return { id: 'credentials', status: 'unknown', detail: `could not reach the platform: ${msgOf(e)}` };
  }
}

function grantedFrom(data: any): string[] {
  const raw: unknown[] = data?.app?.scopes ?? data?.application?.scopes ?? data?.scopes ?? [];
  const names = raw.map((s) => (typeof s === 'string' ? s : (s as { scope?: string })?.scope)).filter((s): s is string => !!s);
  return [...new Set(names)];
}

export async function verifyLarkBot(o: VerifyOptions, deps: VerifyDeps = {}): Promise<VerifyReport> {
  const links = consoleLinks(o.appId, o.brand);
  const f = deps.fetch ?? fetch;
  const lark: LarkDeps = { ...defaultLarkDeps, ...deps } as LarkDeps;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const checks: Check[] = [];
  let missing: ScopeRequirement[] = [];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const cred = await tenantToken(f, o, ac.signal);
    checks.push(cred);

    if (cred.status === 'ok') {
      const client = lark.createClient({ appId: o.appId, appSecret: o.appSecret, domain: o.brand });

      // bot capability: /bot/v3/info only answers for apps with the bot capability enabled
      try {
        const res = (await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })) as { code?: number; msg?: string; bot?: { open_id?: string } };
        if (res?.bot?.open_id && !res.code) checks.push({ id: 'bot', status: 'ok', detail: 'bot capability is on' });
        else checks.push({ id: 'bot', status: 'fail', detail: `bot info unavailable (code ${res?.code ?? '?'}): enable the Bot capability`, link: links.home });
      } catch (e) {
        checks.push({ id: 'bot', status: 'unknown', detail: `bot info request failed: ${msgOf(e)}` });
      }

      // granted scopes: Get application info (application v6) returns the effective scope names
      try {
        const res = (await client.request({
          method: 'GET',
          url: `/open-apis/application/v6/applications/${o.appId}`,
          params: { lang: 'zh_cn' },
        })) as { code?: number; msg?: string; data?: unknown };
        const granted = res?.code ? [] : grantedFrom(res?.data);
        if (res?.code === NO_PERM) {
          checks.push({ id: 'scopes', status: 'unknown', detail: 'cannot read granted scopes: the app lacks application:application:self_manage; check the list by hand', link: links.scopes });
        } else if (res?.code) {
          checks.push({ id: 'scopes', status: 'unknown', detail: `scope readback failed (code ${res.code}): ${res.msg ?? ''}`.trim(), link: links.scopes });
        } else if (granted.length === 0) {
          checks.push({ id: 'scopes', status: 'unknown', detail: 'scope readback returned no scopes; cannot tell what is granted', link: links.scopes });
        } else {
          const have = new Set(granted);
          missing = TENANT_SCOPES.filter((s) => !have.has(s.name));
          const blocking = missing.filter((s) => s.tier === 'runtime');
          checks.push({
            id: 'scopes',
            status: blocking.length ? 'fail' : 'ok',
            detail: missing.length ? `missing: ${missing.map((s) => `${s.name} [${s.tier}]`).join(', ')}` : 'all required scopes are granted',
            ...(missing.length ? { link: links.scopes } : {}),
          });
        }
      } catch (e) {
        checks.push({ id: 'scopes', status: 'unknown', detail: `scope readback failed: ${msgOf(e)}`, link: links.scopes });
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // The platform has no official API that lists a bot's event subscriptions.
  checks.push({
    id: 'events',
    status: 'unknown',
    detail: 'event subscriptions cannot be read through an official API; confirm im.message.receive_v1 and the card.action.trigger callback in the console, or run verify --live and send a message',
    link: links.events,
  });

  if (o.live) checks.push(await probeWs(o, lark, timeoutMs));
  else checks.push({ id: 'ws', status: 'skipped', detail: 'run with --live to probe the WebSocket connection' });

  const ok = !checks.some((c) => c.status === 'fail');
  return { appId: o.appId, brand: o.brand, ok, checks, missingScopes: missing, scopesJson: scopesJson(), links };
}

async function probeWs(o: VerifyOptions, lark: LarkDeps, timeoutMs: number): Promise<Check> {
  const params = { appId: o.appId, appSecret: o.appSecret, domain: o.brand };
  const ws = lark.createWs(params);
  try {
    await ws.start({ eventDispatcher: lark.createDispatcher(params) });
    if (!ws.getConnectionStatus) return { id: 'ws', status: 'unknown', detail: 'WS started without error but this client cannot report its state' };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = ws.getConnectionStatus().state;
      if (s === 'connected') return { id: 'ws', status: 'ok', detail: 'WebSocket connected' };
      if (s === 'failed') return { id: 'ws', status: 'fail', detail: 'WebSocket connection failed', link: consoleLinks(o.appId, o.brand).events };
      if (Date.now() >= deadline) return { id: 'ws', status: 'fail', detail: `no WebSocket connection within ${timeoutMs}ms (state: ${s})`, link: consoleLinks(o.appId, o.brand).events };
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (e) {
    return { id: 'ws', status: 'fail', detail: `WebSocket start failed: ${msgOf(e)}` };
  } finally {
    try {
      ws.close({ force: true });
    } catch {
      /* already closed */
    }
  }
}
