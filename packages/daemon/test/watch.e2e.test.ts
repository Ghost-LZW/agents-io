import { describe, expect, it } from 'vitest';
import type { BodyOf, SessionEvent } from '@agents-io/protocol';
import { CommandError } from '../src/client.js';
import { formatWatch } from '../src/watch-spec.js';
import { tmp, until } from './helpers.js';
import { config, eve, group, start } from './watch-helpers.js';

describe('gateway watches', () => {
  it('loads config watches; local client adds, lists and removes as the owner #CF-5 #ID-4', async () => {
    const dir = tmp();
    const c = config(dir, { watches: [{ id: 'cfg', source: { channel: 'fake', conversation: 'g1' }, target: { sessionKey: 'main' }, mode: 'context' }] });
    const { gw, chat, client } = await start(dir, c);
    expect((await client.watchList()).map((w) => [w.id, w.createdBy])).toEqual([['cfg', 'me']]);
    const added = await client.watchAdd({ id: 'trig', source: { channel: 'fake', conversation: 'g2' }, target: { sessionKey: 'main' }, mode: 'trigger' });
    expect(added).toMatchObject({ id: 'trig', createdBy: 'me' });
    expect(formatWatch(added)).toMatch(/^trig\t→ main\tchannel=fake conversation=g2 mode=trigger\tby me/);
    expect((await client.watchList('main')).length).toBe(2);
    expect((await client.watchList('elsewhere')).length).toBe(0);
    await expect(client.watchAdd({ source: { channel: 'fake' }, target: { sessionKey: 'main' }, mode: 'digest' })).rejects.toThrow(CommandError);
    expect(await client.watchRemove('trig')).toEqual({ removed: true });
    expect(await client.watchRemove('trig')).toEqual({ removed: false });

    const sub = await client.subscribe({ sessionKey: 'main', tier: 'full', fromSeq: 0 });
    const events: SessionEvent[] = [];
    void (async () => {
      for await (const e of sub) events.push(e);
    })();
    await chat.inject({ sender: eve, conversation: group, text: 'overheard' });
    const a = await until(() => events.find((e) => e.body.t === 'input.admitted')?.body as BodyOf<'input.admitted'> | undefined);
    expect(a).toMatchObject({ disposition: 'observe_only', input: { channelContext: { watch: 'cfg' }, origin: { principal: null } } });
    // Agents are limited by the allowlist (empty here), the owner is not.
    const agent = { kind: 'agent' as const, principal: { id: 'session:main', labels: ['agent'] }, evidence: 'none' as const, via: 'mcp', adapter: 'mcp' };
    expect(await gw.addWatch(agent, { source: { channel: 'fake', conversationKind: 'group' }, target: { sessionKey: 'main' }, mode: 'context' })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
