import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeChannel } from '@agents-io/testkit';
import { tmp } from './helpers.js';
import { BrokenChannel, FAKE_BOT, live, provision } from './live-channels-helpers.js';

describe('console.liveChannels', () => {
  it('a lark-bot channel provisioned by POST /api/bots/lark starts at once #CF-2', async () => {
    const argsOut = join(tmp(), 'args.json');
    const made: FakeChannel[] = [];
    const { api, status } = await live({
      raw: { console: { larkBotCommand: [process.execPath, FAKE_BOT] } },
      consoleEnv: { FAKE_ARGS_OUT: argsOut, PATH: process.env.PATH! },
      channelAdapter: (ch) => (ch.type === 'lark-bot' ? (made.push(new FakeChannel('lark-bot')), made.at(-1)) : undefined),
    });
    const j = await provision(api, argsOut);
    expect(j).toMatchObject({ state: 'succeeded', message: expect.stringContaining('the channel is started'), result: { account: 'proj-a', channelAdded: true, channelStarted: true } });
    expect(made).toHaveLength(1);
    expect(status().find((c) => c.id === 'lark-bot')).toEqual({ id: 'lark-bot', account: 'proj-a', state: 'running' });
  });

  it('a provisioned lark-bot whose start fails: channelStarted false, and the job says why #CF-2', async () => {
    const argsOut = join(tmp(), 'args.json');
    const { api } = await live({
      raw: { console: { larkBotCommand: [process.execPath, FAKE_BOT] } },
      consoleEnv: { FAKE_ARGS_OUT: argsOut, PATH: process.env.PATH! },
      channelAdapter: (ch) => (ch.type === 'lark-bot' ? new BrokenChannel('lark-bot') : undefined),
    });
    const j = await provision(api, argsOut);
    expect(j).toMatchObject({ state: 'succeeded', message: expect.stringContaining('the channel did not start (invalid app secret)'), result: { account: 'proj-a', channelAdded: true, channelStarted: false } });
  });
});
