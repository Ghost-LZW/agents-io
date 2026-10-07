import * as lark from '@larksuiteoapi/node-sdk';
import type { LarkCardKitApi, LarkClientLike, LarkContactUserApi, LarkMessageApi, LarkMessageResourceApi, LarkConnectionParams, LarkDeps, LarkDispatcherLike, LarkWsLike } from './types.js';

/** Compile-time check that the narrow CardKit view matches the installed SDK's `cardkit.v1`. */
type Assert<T extends true> = T;
export type CardKitMatchesSdk = Assert<lark.Client['cardkit']['v1'] extends LarkCardKitApi ? true : false>;
/** Same for message get, message resources and contact users (inbound enrichment). */
export type MessageGetMatchesSdk = Assert<lark.Client['im']['v1']['message']['get'] extends (p: Parameters<LarkMessageApi['get']>[0]) => Promise<unknown> ? true : false>;
export type MessageResourceMatchesSdk = Assert<lark.Client['im']['v1']['messageResource'] extends LarkMessageResourceApi ? true : false>;
export type ContactUserMatchesSdk = Assert<lark.Client['contact']['v3']['user'] extends LarkContactUserApi ? true : false>;

const domainOf =(d: 'feishu' | 'lark') => (d === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu);

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
