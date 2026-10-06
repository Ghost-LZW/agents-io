import * as lark from '@larksuiteoapi/node-sdk';
import { larkAddons, type Brand } from './requirements.js';

export const DEFAULT_APP_NAME = 'agents-io · {user}';
const LARK_ACCOUNTS_HOST = 'accounts.larksuite.com';

export interface QRInfo {
  url: string;
  expireIn: number;
}

export interface RegisterAppResultLike {
  client_id: string;
  client_secret: string;
  user_info?: { open_id?: string; tenant_brand?: Brand };
}

export interface RegisterAppOptionsLike {
  domain?: string;
  source?: string;
  signal?: AbortSignal;
  onQRCodeReady: (info: QRInfo) => void;
  onStatusChange?: (info: { status: string; interval?: number }) => void;
  appPreset?: { name?: string; desc?: string };
  addons?: ReturnType<typeof larkAddons>;
  appId?: string;
  createOnly?: boolean;
}

export type RegisterAppFn = (o: RegisterAppOptionsLike) => Promise<RegisterAppResultLike>;

export interface CreateDeps {
  registerApp?: RegisterAppFn;
}

export interface CreateOptions {
  name?: string;
  /** Which platform's accounts host to start the flow on. The scanner's real tenant brand wins in the result. */
  brand?: Brand;
  signal?: AbortSignal;
  onQRCode: (info: QRInfo) => void;
  onStatus?: (info: { status: string; interval?: number }) => void;
}

export interface LarkBotCredentials {
  appId: string;
  appSecret: string;
  brand: Brand;
  /** The scanner's open_id, scoped to the new app. Only a candidate: resolve it with `resolveOwner`. */
  ownerOpenId?: string;
}

export type CreateFailure = 'aborted' | 'expired' | 'denied' | 'network' | 'unknown';

export class LarkSetupError extends Error {
  constructor(
    readonly reason: CreateFailure,
    message: string,
  ) {
    super(message);
    this.name = 'LarkSetupError';
  }
}

function redact(s: string): string {
  return s.replace(/[A-Za-z0-9_-]{24,}/g, '***');
}

function classify(err: unknown): LarkSetupError {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e?.code === 'string' ? e.code : '';
  const msg = redact(typeof e?.message === 'string' ? e.message : String(err));
  if (code === 'abort') return new LarkSetupError('aborted', 'cancelled before the QR code was confirmed');
  if (code === 'expired_token') return new LarkSetupError('expired', 'the QR code expired; run create again');
  if (code === 'access_denied') return new LarkSetupError('denied', 'authorization was denied in the browser');
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i.test(msg)) return new LarkSetupError('network', `network error: ${msg}`);
  return new LarkSetupError('unknown', msg);
}

const defaultRegister: RegisterAppFn = (o) => lark.registerApp(o as Parameters<typeof lark.registerApp>[0]) as Promise<RegisterAppResultLike>;

async function run(
  opts: CreateOptions & { appId?: string; createOnly?: boolean },
  deps: CreateDeps,
): Promise<LarkBotCredentials> {
  const register = deps.registerApp ?? defaultRegister;
  let res: RegisterAppResultLike;
  try {
    res = await register({
      source: 'agents-io',
      ...(opts.brand === 'lark' ? { domain: LARK_ACCOUNTS_HOST } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onQRCodeReady: opts.onQRCode,
      ...(opts.onStatus ? { onStatusChange: opts.onStatus } : {}),
      appPreset: { name: opts.name ?? DEFAULT_APP_NAME },
      addons: larkAddons(),
      ...(opts.appId ? { appId: opts.appId } : {}),
      ...(opts.createOnly ? { createOnly: true } : {}),
    });
  } catch (err) {
    throw classify(err);
  }
  if (!res?.client_id || !res?.client_secret) throw new LarkSetupError('unknown', 'platform returned no app credentials');
  const openId = res.user_info?.open_id;
  return {
    appId: res.client_id,
    appSecret: res.client_secret,
    brand: res.user_info?.tenant_brand === 'lark' ? 'lark' : res.user_info?.tenant_brand === 'feishu' ? 'feishu' : (opts.brand ?? 'feishu'),
    ...(openId?.startsWith('ou_') ? { ownerOpenId: openId } : {}),
  };
}

/**
 * Create a new bot app through the official OAuth device flow: the user scans the QR code,
 * confirms on the platform page, and receives app credentials. Never logs or throws the secret.
 */
export function createLarkBot(opts: CreateOptions, deps: CreateDeps = {}): Promise<LarkBotCredentials> {
  return run({ ...opts, createOnly: true }, deps);
}

/** Re-run the flow against an existing app so the user re-authorizes the scope/event diff. */
export function updateLarkBot(opts: CreateOptions & { appId: string }, deps: CreateDeps = {}): Promise<LarkBotCredentials> {
  return run(opts, deps);
}
