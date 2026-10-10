import { describe, expect, it } from 'vitest';
import { FakeChannel } from '@agents-io/testkit';
import { until } from './helpers.js';
import { bridge, live } from './live-channels-helpers.js';

describe('console.liveChannels', () => {
  it('sessions already open render to a channel started live', async () => {
    const made: FakeChannel[] = [];
    const { w, doc, put } = await live({ channelAdapter: (ch) => (ch.type === 'bridge' ? (made.push(new FakeChannel('extra')), made.at(-1)) : undefined) });
    await w.chat.inject({ text: 'hello', sender: { channelUserId: 'alice', evidence: 'platform_signed' } as never });
    await until(() => (w.gw as any).lanes.size > 0);
    const before = (w.gw as any).compositors.length as number;
    await put({ ...(await doc()).config, channels: [bridge('x1')] });
    expect(made).toHaveLength(1);
    const lanes = (w.gw as any).lanes.size as number;
    expect((w.gw as any).compositors.length).toBe(before + lanes);
    await put({ ...(await doc()).config, channels: [] });
    expect((w.gw as any).compositors.length).toBe(before);
  });
});
