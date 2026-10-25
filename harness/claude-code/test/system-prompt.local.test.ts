import { describe, expect, it } from 'vitest';
import { runHarnessEnvConformance } from '@agents-io/testkit';
import type { HarnessSession } from '@agents-io/protocol';
import { CONTEXT_LABEL, ClaudeCodeHarness, convertBlock, inputUuid, preface, toTurnMessage } from '../src/index.js';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
import type { PermissionResult } from '../src/types.js';
import { bodies, collectUntil, fakeQueryFn, input, isTurnCompleted, sdk, type FakeQuery } from './fake-query.js';
import { run, setup, uuidOf } from './claude-code-helpers.js';

// Moved from claude-code.test.ts: feature-path tests with no promise in docs/INVARIANTS.md (decision 14: local tier).

describe('system-prompt', () => {
  it("runs on Claude Code's own system prompt unless options.sdk sets one", async () => {
    // The SDK turns an absent systemPrompt into an empty one (no tool guidance, no sub-agents).
    const { q } = await setup();
    expect(q.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    const custom = await setup({}, { sdk: { systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Be brief.' } } });
    expect(custom.q.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Be brief.' });
  });
});
