import type { HarnessAdapter } from '@agents-io/protocol';

/** What a harness adapter declares statically (HarnessAdapter displayName, compact, modes, …), for a FakeHarness. */
export type HarnessDeclares = Pick<HarnessAdapter, 'displayName' | 'compact' | 'modes' | 'ownerProfileSwitch' | 'ephemeralOpen'>;

/** What Claude Code's adapter declares (a compaction command), for a FakeHarness that stands in for it. */
export const CLAUDE_CODE_DECLARES: HarnessDeclares = { displayName: 'Claude Code', compact: { command: '/compact' } };

/** What Codex's adapter declares (Plan mode, the owner's profile switch, ephemeral opens), for a FakeHarness that stands in for it. */
export const CODEX_DECLARES: HarnessDeclares = { displayName: 'Codex', modes: ['plan'], ownerProfileSwitch: true, ephemeralOpen: true };
