import * as lark from '@larksuiteoapi/node-sdk';
import type { LarkClientLike, LarkConnectionParams, LarkDeps, LarkDispatcherLike, LarkWsLike } from './types.js';

const domainOf = (d: 'feishu' | 'lark') => (d === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu);

/** Production wiring: official `@larksuiteoapi/node-sdk` Client, WSClient and EventDispatcher. */
export const defaultLarkDeps: LarkDeps = {
  createClient: (p: LarkConnectionParams): LarkClientLike =>
    new lark.Client({ appId: p.appId, appSecret: p.appSecret, domain: domainOf(p.domain) }) as unknown as LarkClientLike,
  createWs: (p: LarkConnectionParams): LarkWsLike =>
    new lark.WSClient({
      appId: p.appId,
      appSecret: p.appSecret,
      domain: domainOf(p.domain),
      loggerLevel: lark.LoggerLevel.warn,
    }) as unknown as LarkWsLike,
  createDispatcher: (p: LarkConnectionParams): LarkDispatcherLike =>
    new lark.EventDispatcher({
      ...(p.encryptKey ? { encryptKey: p.encryptKey } : {}),
      ...(p.verificationToken ? { verificationToken: p.verificationToken } : {}),
    }) as unknown as LarkDispatcherLike,
};
