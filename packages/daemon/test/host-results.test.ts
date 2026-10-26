import { describe, expect, it } from 'vitest';
import { HOST_RESULT_VALUES, InboundAnswer, RunEnded, errors, type Binding, type BindingTable } from '@agents-io/protocol';
import type { FakeTurnScript } from '@agents-io/testkit';
import { daemon } from './helpers.js';

// What the daemon answers must match the protocol's result-value schemas (host.ts), which other implementations rely on.

const hostRule: Binding = { id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host' };
const table = (version: string): BindingTable => ({ version, bindings: [hostRule], identities: [], onHostDown: 'keep' });
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const script: FakeTurnScript = async (t) => {
  t.emit({ t: 'text.snapshot', text: 'done', final: true }, { audience: 'answer' });
};
const valid = (type: keyof typeof HOST_RESULT_VALUES, value: unknown) => expect(errors(HOST_RESULT_VALUES[type], value)).toEqual([]);

describe('host result values', () => {
  it('match the protocol schemas #PR-1', async () => {
    const w = await daemon({ raw: { agents: { chat: { harness: 'claude-code' }, exec: { harness: 'claude-code', mode: 'task' } } }, script });
    const c = await w.client();
    valid('host.hello', await c.hello({ token: w.gw.token, name: 'xwo', consumer: 'xwo' }));
    const answer = { accepted: true };
    expect(errors(InboundAnswer, answer)).toEqual([]);
    c.onRequest('inbound', () => answer);
    valid('bindings.put', await c.bindingsPut(table('v1')));
    valid('bindings.get', await c.bindingsGet());

    const r = await w.chat.inject({ id: 'm1', sender: alice, text: 'xwo hi' });
    const t = await w.host({ name: 'tail' });
    const read = await t.inboundRead({ consumer: 'pull' });
    expect(read.items).toHaveLength(1);
    valid('inbound.read', read);
    valid('inbound.ack', await t.inboundAck('pull', read.items[0]!.cursor));
    valid('explain', await t.explain(r.inputId!));
    valid('input.verify', await t.verify('channel:fake/m1'));
    valid('input.verify', await t.verify('channel:fake/never'));
    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    const sent = await t.deliver({ operationId: 'op', route, message: { text: 'x' } });
    valid('deliver', sent);
    const id = sent.providerMessageId!;
    valid('deliver.update', await t.deliverUpdate({ operationId: 'op:1', route, providerMessageId: id, message: { text: 'y' }, sequence: 1 }));
    valid('deliver.update', await t.deliverUpdate({ operationId: 'op:2', route, providerMessageId: id, message: { text: 'z' }, sequence: 2, final: true }));
    valid('conversation.create', await t.conversationCreate({ operationId: 'g1', channel: 'fake', account: 'default', name: 'bench', members: ['alice'] }));

    valid('run.start', await t.runStart({ runId: 'r1', agent: 'exec', cwd: w.dir, input: [{ type: 'text', text: 'go' }] }));
    expect(errors(RunEnded, await t.runEndedOf('r1'))).toEqual([]);
    valid('run.start', await t.runStart({ runId: 'r1', agent: 'exec', input: [{ type: 'text', text: 'go' }] }));
    // With the host's input id, correlation id and overrides: the answer, run.ended and explain of the run's input.
    valid('run.start', await t.runStart({ runId: 'r2', agent: 'exec', input: [{ type: 'text', text: 'go' }], inputId: 'h-1', correlation: 'c-1', overrides: { model: 'm', effort: 'e' } }));
    expect(errors(RunEnded, await t.runEndedOf('r2'))).toEqual([]);
    valid('explain', await t.explain('h-1'));
    valid('explain', await t.explain('h-1', { chain: true }));

    // A live session (its turn has run): compacted, then the same id again.
    const key = w.gw.sessions().find((s) => s.live && !s.sessionKey.startsWith('run:'))!.sessionKey;
    valid('session.compact', await t.sessionCompact({ sessionKey: key, inputId: 'cmp-1' }));
    valid('session.compact', await t.sessionCompact({ sessionKey: key, inputId: 'cmp-1' }));
  });
});
