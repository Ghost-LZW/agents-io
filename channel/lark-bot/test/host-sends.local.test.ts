import { describe, expect, it } from 'vitest';
import { FakeLark } from './fake-lark.js';
import { cardOf, make, route } from './process-helpers.js';

/* What a host's one-shot `deliver` of a finished turn and its `conversation.create` do on Lark. */

describe('a finished turn sent in one message', () => {
  it('sends the answer that does not fit the card in more messages, the process as a panel', async () => {
    const { lark, adapter } = make({ process: 'auto', maxCardKitBytes: 8000, maxCardBytes: 8000 });
    const answer = Array.from({ length: 600 }, (_, i) => `line ${i} of a long answer`).join('\n');
    const r = await adapter.send(
      route,
      {
        text: answer,
        progress: {
          turnId: 'n1',
          status: 'completed',
          steps: [{ kind: 'tool', itemId: 'i1', type: 'command', title: 'Bash: npm test', status: 'completed', resultPreview: 'ok' }],
          answer,
          answerFinal: true,
        },
      },
      { operationId: 'n1' },
    );
    await adapter.settled();
    expect(r.providerMessageId).toBeTruthy();
    const first = FakeLark.element(cardOf(lark, r.providerMessageId!).json, 'answer').content as string;
    expect(first).toContain('line 0 of a long answer');
    const all = lark.messages.map((m) => m.content).join('\n');
    expect(all).toContain('line 599 of a long answer');
    expect(lark.messages.length).toBeGreaterThan(1);
    // Sent already finished: no bubble (nothing would settle it later); the process is a panel of the card.
    expect(lark.cots).toHaveLength(0);
    expect(JSON.stringify(cardOf(lark, r.providerMessageId!).json)).toContain('Bash: npm test');
  });
});

describe('createConversation', () => {
  it('makes a private group with the owner in it, the bot a manager, deduplicated by a uuid', async () => {
    const lark = new FakeLark();
    const { adapter } = make({}, lark);
    const a = await adapter.createConversation('acct', { operationId: 'wb', name: 'workbench', owner: 'on_owner', members: ['on_owner'] });
    expect(a).toEqual({ conversationId: 'oc_made1' });
    await adapter.createConversation('acct', { operationId: 'wb', name: 'workbench', owner: 'on_owner', members: ['on_owner'] });
    const [x, y] = lark.createdChats;
    expect(x?.params).toMatchObject({ user_id_type: 'union_id', set_bot_manager: true });
    expect(x?.data).toEqual({ name: 'workbench', owner_id: 'on_owner', user_id_list: ['on_owner'], chat_mode: 'group', chat_type: 'private' });
    expect(y?.params.uuid).toBe(x?.params.uuid);
  });

  it('refuses mixed id types and passes the platform error on', async () => {
    const lark = new FakeLark();
    const { adapter } = make({}, lark);
    await expect(adapter.createConversation('acct', { operationId: 'g', name: 'g', members: ['on_a', 'ou_b'] })).rejects.toThrow(/union_ids, open_ids or user_ids/);
    lark.fail.set('chat.create', [99991672]);
    await expect(adapter.createConversation('acct', { operationId: 'g', name: 'g', members: ['ou_b'] })).rejects.toThrow(/code 99991672/);
  });
});

describe('a turn sent while it runs, then updated (deliver.update)', () => {
  it('opens a thinking bubble, feeds it and settles it when finalized', async () => {
    const { lark, adapter } = make({ process: 'auto' });
    const base = { turnId: 'n2', answer: '', answerFinal: false, steps: [] as any[] };
    const tool = { kind: 'tool', itemId: 'i1', type: 'command', title: 'Bash: ls', status: 'running' } as const;
    const running = { ...base, status: 'running' as const, steps: [tool] };
    const r = await adapter.send(route, { text: 'Working…', progress: running }, { operationId: 'n2' });
    await adapter.edit(route, r.providerMessageId!, { text: 'Working…', progress: { ...running, steps: [{ ...tool, status: 'completed', resultPreview: 'a.ts' }] } }, { operationId: 'n2:1', sequence: 1 });
    await adapter.finalize(route, r.providerMessageId!, { text: 'Done.', progress: { ...base, status: 'completed', answer: 'Done.', answerFinal: true, steps: [{ ...tool, status: 'completed', resultPreview: 'a.ts' }] } });
    await adapter.settled();
    expect(lark.cots).toHaveLength(1);
    const types = lark.cots[0]!.events.map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_RESULT', 'RUN_FINISHED']));
  });
});
