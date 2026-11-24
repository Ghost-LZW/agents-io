import type { HarnessCaps } from '@agents-io/protocol';

/**
 * Notifications nothing in this adapter maps; suppressed per connection. Codex ignores
 * names it does not know, so the ones a newer line adds are listed too (0.171:
 * `thread/prediction/updated`, `thread/readState/changed`, `thread/search/partial`,
 * `thread/section/changed`), keeping the event stream the same on every supported line.
 */
export const DEFAULT_OPT_OUT = [
  'account/login/completed',
  'account/rateLimits/updated',
  'account/updated',
  'app/list/updated',
  'command/exec/outputDelta',
  'deprecationNotice',
  'externalAgentConfig/import/completed',
  'externalAgentConfig/import/progress',
  'fs/changed',
  'fuzzyFileSearch/sessionCompleted',
  'fuzzyFileSearch/sessionUpdated',
  'item/fileChange/outputDelta',
  'item/reasoning/summaryPartAdded',
  'mcpServer/oauthLogin/completed',
  'process/exited',
  'process/outputDelta',
  'project/changed',
  'remoteControl/status/changed',
  'thread/prediction/updated',
  'thread/realtime/closed',
  'thread/realtime/error',
  'thread/realtime/item/completed',
  'thread/realtime/item/started',
  'thread/realtime/item/transcript/delta',
  'thread/realtime/itemAdded',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/started',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/readState/changed',
  'thread/search/partial',
  'thread/section/changed',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
];

/** Realtime notifications a `live` connection needs (audio and partial transcripts stay opted out). */
export const LIVE_NOTIFICATIONS = [
  'thread/realtime/closed',
  'thread/realtime/error',
  'thread/realtime/itemAdded',
  'thread/realtime/sdp',
  'thread/realtime/started',
  'thread/realtime/transcript/done',
];

/**
 * What Codex app-server supports (0.160 and 0.171 alike), as agents-io capabilities:
 * - steer: `turn/steer` with `expectedTurnId` injects into the running turn;
 * - interrupt: `turn/interrupt`;
 * - approvals / questions: server requests (`item/*\/requestApproval`, `item/tool/requestUserInput`);
 * - tokenDeltas: `item/agentMessage/delta`;
 * - injectWithoutTurn: `thread/inject_items` (HarnessSession.inject);
 * - switchProfileMidSession: `turn/start` approvalPolicy/sandboxPolicy overrides;
 * - resume: `thread/resume`;
 * - switchModelMidSession: `turn/start.model` overrides per turn.
 */
export const CODEX_CAPS: HarnessCaps = {
  steer: 'native',
  interrupt: true,
  approvals: true,
  questions: true,
  tokenDeltas: true,
  cancelQueued: false,
  injectWithoutTurn: true,
  resume: true,
  switchModelMidSession: true,
  switchProfileMidSession: true,
};
