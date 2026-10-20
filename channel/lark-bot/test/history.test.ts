import { describe, expect, it } from 'vitest';
import { LarkBotAdapter } from '../src/index.js';
import { FakeLark, listed, messageEvent, startAdapter, tick } from './fake-lark.js';

const cfg = { appId: 'cli_x', appSecret: 's', domain: 'feishu' as const, editMinIntervalMs: 0 };
const AT_BOT = [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'bot' }];

/** An adapter, started, that received one @ in thread omt_1; history calls are made against it. */
async function threadAt(now: () => number = Date.now) {
  const lark = new FakeLark();
  const adapter = new LarkBotAdapter(cfg, { deps: lark.deps, now });
  const run = startAdapter(adapter);
  await tick();
  lark.histories.set('thread:omt_1', [listed({ id: 'om_1', text: 'the launch moved', at: 1_699_999_990_000 })]);
  await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_at', chatType: 'group', thread: 'omt_1', root: 'om_1', parent: 'om_1', mentions: AT_BOT, content: { text: '@_user_1 what now?' } }));
  return { lark, adapter, ...run, at: run.envs[0]! };
}

describe('history on mention (lark-bot)', () => {
  it('a missing permission costs only the history: no messages, one warning, and no more calls until degradeTtlMs #IN-9', async () => {
    let now = 1_000_000;
    const t = await threadAt(() => now);
    t.lark.fail.set('message.list', [230027, 99991672]);
    expect(await t.adapter.history(t.at, 'thread')).toEqual([]);
    expect(await t.adapter.history(t.at, 'chat')).toEqual([]);
    const warns = () => t.logs.filter((l) => l.startsWith('warn:') && l.includes('history'));
    expect(warns()).toHaveLength(1);
    expect(warns()[0]).toMatch(/im:message:readonly.*im:message\.group_msg/);
    expect(t.lark.lookups.filter((l) => l.startsWith('list:'))).toHaveLength(1);
    // After the rest it tries again; a second refusal is not warned again.
    now += 1_800_001;
    expect(await t.adapter.history(t.at, 'thread')).toEqual([]);
    expect(t.lark.lookups.filter((l) => l.startsWith('list:'))).toHaveLength(2);
    expect(warns()).toHaveLength(1);
    // Granted later: history comes back without a restart.
    now += 1_800_001;
    expect((await t.adapter.history(t.at, 'thread')).map((e) => e.id)).toEqual(['om_1']);
    t.ctl.abort();
    await t.done;
  });

  it('never rejects: a failing or hanging list call answers no messages #IN-9', async () => {
    const t = await threadAt();
    const api = t.lark.client.im.v1.message;
    api.list = async () => {
      throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: {} } });
    };
    await expect(t.adapter.history(t.at, 'thread')).resolves.toEqual([]);
    expect(t.logs.some((l) => l.startsWith('warn:') && l.includes('thread history of omt_1 not read'))).toBe(true);
    const slow = new LarkBotAdapter({ ...cfg, lookupTimeoutMs: 20 }, { deps: t.lark.deps });
    const run = startAdapter(slow);
    await tick();
    api.list = () => new Promise(() => {});
    await expect(slow.history(t.at, 'thread')).resolves.toEqual([]);
    run.ctl.abort();
    await run.done;
    t.ctl.abort();
    await t.done;
  });
});
