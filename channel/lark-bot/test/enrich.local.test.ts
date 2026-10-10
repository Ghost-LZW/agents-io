import { describe, expect, it } from 'vitest';
import { LarkBotAdapter, type LarkBotConfig } from '../src/index.js';
import { dispositionName, sniffMime } from '../src/enrich.js';
import { messageText } from '../src/inbound.js';
import { FakeLark, messageEvent, startAdapter, tick } from './fake-lark.js';

/* Feature-path tests of inbound enrichment with no promise behind them (decision 14: local tier). */

const cfg = { appId: 'cli_x', appSecret: 's', domain: 'feishu' as const, editMinIntervalMs: 0 };

async function setup(opts: Parameters<typeof startAdapter>[1] = {}, config: Partial<LarkBotConfig> = {}) {
  const lark = new FakeLark();
  const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps });
  const run = startAdapter(adapter, opts);
  await tick();
  return { lark, adapter, ...run };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('inbound enrichment', () => {
  it('keeps lark-file refs when there is no blob store', async () => {
    const { lark, envs, ctl, done } = await setup();
    lark.resources.set('om_a/k1', { bytes: PNG });
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_a', type: 'image', content: { image_key: 'k1' } }));
    expect(envs[0]!.content).toEqual([{ type: 'image', ref: 'lark-file:om_a/k1', mime: 'image/*' }]);
    expect(lark.lookups.some((l) => l.startsWith('resource:'))).toBe(false);
    ctl.abort();
    await done;
  });

  it('resolves sender display names through contact (cached with a TTL), leaving them unset on failure', async () => {
    let now = 1_000_000;
    const lark = new FakeLark();
    lark.users.set('on_alice', { name: 'Alice Zhang' });
    const adapter = new LarkBotAdapter({ ...cfg, senderNameTtlMs: 1000 }, { deps: lark.deps, now: () => now });
    const run = startAdapter(adapter);
    await tick();
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_1' }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_2' }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_3', sender: { open_id: 'ou_eve' } }));
    expect(run.envs.map((e) => e.sender.displayName)).toEqual(['Alice Zhang', 'Alice Zhang', undefined]);
    expect(lark.lookups.filter((l) => l.startsWith('user:'))).toEqual(['user:on_alice:union_id', 'user:ou_eve:open_id']);
    now += 2000;
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_4' }));
    expect(lark.lookups.filter((l) => l.startsWith('user:on_alice'))).toHaveLength(2);
    run.ctl.abort();
    await run.done;
  });

  it('helpers: content-disposition names, magic-byte sniffing, message text flattening', () => {
    expect(dispositionName('attachment; filename="a b.pdf"')).toBe('a b.pdf');
    expect(dispositionName("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.docx")).toBe('报告.docx');
    expect(dispositionName(undefined)).toBeUndefined();
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('hello'))).toBeUndefined();
    const post = JSON.stringify({ zh_cn: { title: 'T', content: [[{ tag: 'text', text: 'line' }], [{ tag: 'img', image_key: 'i' }]] } });
    expect(messageText('post', post)).toBe('T\nline\n[image]');
    expect(messageText('file', JSON.stringify({ file_key: 'k', file_name: 'a.pdf' }))).toBe('[file a.pdf]');
    expect(messageText('share_chat', '{}')).toBe('[share_chat message]');
  });
});
