import { describe, expect, it } from 'vitest';
import { LarkBotAdapter, larkBotChannelModule } from '../src/index.js';

/* The lark-bot channel type's `create`: the adapter of one resolved entry, as the daemon builds it. */

const init = { index: 0, account: 'a', config: undefined, log: () => {}, stateDir: '/data/channels/lark-bot.a', acceptId: () => undefined, onState: () => {} };
const entry = (config: Record<string, unknown> = {}) => ({ type: 'lark-bot' as const, account: 'a', config: { appId: 'cli_x', appSecret: 's', domain: 'feishu' as const, ...config } });
const inner = (a: unknown) => a as { cfg: { appId: string; look: string }; stateDir: string | undefined };

describe('lark-bot channel module', () => {
  it('builds a LarkBotAdapter with the entry config, the chat look unless the entry picks one, and the state dir', async () => {
    const b = await larkBotChannelModule.create(entry(), init);
    expect(b.adapter).toBeInstanceOf(LarkBotAdapter);
    expect(b.adapter.id).toBe('lark-bot');
    expect(inner(b.adapter).cfg).toMatchObject({ appId: 'cli_x', look: 'chat' });
    expect(inner(b.adapter).stateDir).toBe('/data/channels/lark-bot.a');
    expect(inner((await larkBotChannelModule.create(entry({ look: 'console' }), init)).adapter).cfg.look).toBe('console');
  });

  it('declares its channel id, so no bridge or module may use it', () => {
    expect(larkBotChannelModule.ids).toEqual(['lark-bot']);
  });
});
