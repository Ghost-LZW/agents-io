import { describe, expect, it } from 'vitest';
import { LarkBotAdapter } from '../src/index.js';

const { LARK_APP_ID, LARK_APP_SECRET, LARK_TEST_CHAT_ID, LARK_DOMAIN } = process.env;
const live = LARK_APP_ID && LARK_APP_SECRET && LARK_TEST_CHAT_ID;

describe.skipIf(!live)('live smoke (real Feishu/Lark)', () => {
  it('sends a card, patches it and reconciles', async () => {
    const adapter = new LarkBotAdapter({
      appId: LARK_APP_ID!,
      appSecret: LARK_APP_SECRET!,
      domain: LARK_DOMAIN === 'lark' ? 'lark' : 'feishu',
      editMinIntervalMs: 1200,
    });
    const route = { channel: 'lark-bot', account: 'live', conversationId: LARK_TEST_CHAT_ID! };
    const op = { operationId: `smoke-${Date.now()}` };
    const { providerMessageId: id } = await adapter.send(route, { text: 'agents-io smoke', sections: [{ kind: 'status', text: 'starting' }] }, op);
    expect(id).toBeTruthy();
    await adapter.edit(route, id!, { text: 'agents-io smoke', sections: [{ kind: 'body', text: 'edited' }] }, { operationId: `${op.operationId}-e`, sequence: 1 });
    expect(await adapter.reconcile(route, id!)).toBe('alive');
    await adapter.finalize(route, id!, { text: 'done', sections: [{ kind: 'body', text: 'done' }] });
  }, 30_000);
});
