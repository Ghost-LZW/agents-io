import { describe, expect, it } from 'vitest';
import { runChannelConformance } from '@agents-io/testkit';
import { LarkBotAdapter } from '../src/index.js';
import { FakeLark, messageEvent } from './fake-lark.js';

describe('channel conformance', () => {
  it('passes runChannelConformance against a fake platform #CN-1', async () => {
    const lark = new FakeLark();
    const adapter = new LarkBotAdapter(
      { appId: 'cli_x', appSecret: 's', domain: 'feishu', editMinIntervalMs: 0 },
      { deps: lark.deps },
    );
    const report = await runChannelConformance({
      adapter,
      account: 'acct',
      route: { channel: 'lark-bot', account: 'acct', conversationId: 'oc_chat' },
      triggerInbound: async () => {
        await new Promise((r) => setTimeout(r, 10)); // adapter registers handlers during start()
        await lark.fire('im.message.receive_v1', messageEvent());
      },
      platformMessages: async () => lark.messages.map((m) => m.id),
    });
    expect(report.failed).toEqual([]);
    expect(report.passed).toEqual(
      expect.arrayContaining(['caps.schema', 'inbound.schema', 'outbound.idempotent', 'outbound.platform_once', 'outbound.edit']),
    );
  });
});
