import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type BodyOf } from '@agents-io/protocol';
import { parseClientFrame } from '../src/frames.js';
import { tmp, until } from './helpers.js';
import { config, eve, group, start } from './watch-helpers.js';

describe('watch spec', () => {
  it('client watch frames validate #PR-1', () => {
    const w = { source: { channel: 'x' }, target: { sessionKey: 's' }, mode: 'context' };
    expect(parseClientFrame({ v: PROTOCOL_VERSION, type: 'watch.add', id: '1', watch: w }).ok).toBe(true);
    expect(parseClientFrame({ v: PROTOCOL_VERSION, type: 'watch.remove', id: '2', watchId: 'w' }).ok).toBe(true);
    expect(parseClientFrame({ v: PROTOCOL_VERSION, type: 'watch.list', id: '3' }).ok).toBe(true);
    expect(parseClientFrame({ v: PROTOCOL_VERSION, type: 'watch.add', id: '4', watch: { ...w, mode: 'loud' } })).toMatchObject({ ok: false, id: '4' });
  });
});

describe('gateway watches', () => {
  it('a digest buffered before a gateway restart is delivered after it; it replies to the target home route #RS-1 #CF-5', async () => {
    const dir = tmp();
    const c = config(dir);
    const one = await start(dir, c);
    // The owner talks to `main` locally first: that becomes its home route.
    await one.client.input('main', 'hello');
    await until(() => one.gw.hub.log.read('main', 0).some((e) => e.body.t === 'turn.completed'));
    await one.client.watchAdd({ id: 'dg', source: { channel: 'fake', conversation: 'g1' }, target: { sessionKey: 'main' }, mode: 'digest', digest: { everyMs: 300 } });
    await one.chat.inject({ sender: eve, conversation: group, text: 'first' });
    await one.chat.inject({ sender: eve, conversation: group, text: 'second' });
    await one.stop();

    const two = await start(dir, c);
    const started = await until(
      () => two.gw.hub.log.read('main', 0).filter((e) => e.body.t === 'turn.started').map((e) => e.body as BodyOf<'turn.started'>)[1],
      3000,
    );
    expect(started.replyRoute).toEqual({ channel: 'local', account: 'local', conversationId: 'main' });
    expect(started.run?.profile).toBe('restricted');
    const log = two.gw.hub.log.read('main', 0);
    const digest = log.map((e) => e.body).find((b): b is BodyOf<'input.admitted'> => b.t === 'input.admitted' && b.input?.origin.kind === 'system');
    expect((digest!.input!.content[0] as { text: string }).text).toMatch(/2 new items[\s\S]*first[\s\S]*second/);
    expect(log.some((e) => e.body.t === 'notice' && e.body.message.startsWith('watch dg: digest of 2 items'))).toBe(true);
  });
});
