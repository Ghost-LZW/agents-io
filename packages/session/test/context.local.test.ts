import { describe, expect, it } from 'vitest';
import type { InputRecord } from '@agents-io/protocol';
import { ManualHarness, input, origin, route, setup, until } from './helpers.js';

/** A context-only message from a stranger in group g1. */
function said(id: string, text: string): InputRecord {
  return {
    inputId: id,
    origin: { ...origin(null), via: 'fake:default:g1' },
    content: [{ type: 'text', text }],
    replyRoute: route('g1'),
    channelContext: { conversationKind: 'group', senderName: 'Eve' },
  };
}

describe('context hand-over', () => {
  it('maxItems 0 turns the hand-over off (still recorded)', async () => {
    const h = new ManualHarness();
    const { lane } = setup({ harness: h, context: { maxItems: 0 } });
    await lane.observe(said('c1', 'a'));
    await lane.command({ type: 'input', sessionKey: 's1', input: input('what did they say?', { id: 'q', route: route('g1') }), mode: 'queue' });
    await until(() => (h.session?.starts.length ?? 0) === 1);
    expect(h.session!.starts[0]!.inputs.map((i) => i.inputId)).toEqual(['q']);
    expect(lane.observed().map((i) => i.inputId)).toEqual(['c1']);
  });
});
