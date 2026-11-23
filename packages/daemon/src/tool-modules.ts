import type { KernelContext, ModuleConfig, ModuleManifest } from '@agents-io/protocol';
import { TOOL_GROUP_DEFS, liveToolHandlers, topicToolHandlers, watchToolHandlers } from '@agents-io/host-mcp';
import { TOPIC_TOOLS_HINT } from '@agents-io/session';

/*
 * The model tools beyond the kernel's own six, as built-in feature modules (core-slimming G6 step 3;
 * `bundle.ts` registers them, nothing else in the daemon imports them): the watch tools
 * (`watch_add`, `watch_remove`, `watch_list`), the live tools (`live_join`, `live_say`,
 * `live_leave`) and the topic tools (`session_rotate`, `session_list`, `session_switch`). Each
 * offers its group of host-mcp's tool definitions (`TOOL_GROUP_DEFS`: listed exactly as before)
 * and runs it with host-mcp's handlers over the kernel's mechanism, which stays the kernel's:
 * watches and their routing (`KernelContext.watches`, `Policy.watch`), the live (decision 16:
 * `KernelContext.live`; its protocol, events and LN invariants are core) and the topic handover
 * (TP-1: `KernelContext.topics.rotate` / `switch`). The topic tools also give the hint inputs of a
 * current topic carry (`inputHint`), to the agents offered them. Each is on unless its section
 * says `enabled: false`, so a deployment has the tools it had; per agent, `agents.<name>.tools` /
 * `outputTools` decide as before (CF-6). The live tools are offered also when no channel can open
 * a live, as before.
 */

/** The section of one of the tool modules (`watchTools`, `liveTools`, `topicTools`): only `enabled` (the daemon's). */
export interface ToolModuleSection {
  enabled?: boolean;
}

/** What the section resolves to: nothing of its own. */
export type ToolModuleConfig = Record<string, never>;

/** On, as the tools were before they were modules: a file without the section offers them. */
const section = (key: string): ModuleConfig<ToolModuleConfig> => ({ section: key, schema: {}, defaultEnabled: true, resolve: () => ({}) });

/** `watch_*`: an agent watches sources for its own session (CF-7), as `Policy.watch` and `policy.watchAllowlist` allow. */
export const watchToolsModule: ModuleManifest<ToolModuleConfig> = {
  id: 'tools.watch',
  kind: 'feature',
  needs: ['kernel:watches'],
  config: section('watchTools'),
  mcpTools: TOOL_GROUP_DEFS.watch,
  setup: (k) => ({ tools: watchToolHandlers(k.watches) }),
};

/** `live_*`: the agent joins a live (realtime voice) on a channel that can open one, speaks there, leaves. */
export const liveToolsModule: ModuleManifest<ToolModuleConfig> = {
  id: 'tools.live',
  kind: 'feature',
  needs: ['kernel:live'],
  config: section('liveTools'),
  mcpTools: TOOL_GROUP_DEFS.live,
  setup: (k) => ({
    tools: liveToolHandlers({
      join: (sessionKey, turn, a) => k.live.join(sessionKey, turn.turnId, a),
      say: (sessionKey, text, a) => k.live.say(sessionKey, text, a),
      leave: (sessionKey) => k.live.leave(sessionKey),
    }),
  }),
};

/**
 * `session_*`: the agent moves the conversation to a new topic or back to an earlier one, handing it
 * the message. TP-1 is the kernel's (`KernelContext.topics.rotate` / `switch` hold it for any
 * caller); the handlers check it first too, so the model reads the refusal before its arguments.
 */
export const topicToolsModule: ModuleManifest<ToolModuleConfig> = {
  id: 'tools.topics',
  kind: 'feature',
  needs: ['kernel:topics', 'kernel:agents'],
  config: section('topicTools'),
  mcpTools: TOOL_GROUP_DEFS.topics,
  setup: (k) => ({
    tools: topicToolHandlers({
      list: (sessionKey) => (k.topics.bySession(sessionKey) ? k.topics.siblings(sessionKey) : undefined),
      rotate: (sessionKey, turn, a) => k.topics.rotate(sessionKey, turn.turnId, a),
      switch: (sessionKey, turn, a) => k.topics.switch(sessionKey, turn.turnId, a),
    }),
    hooks: { inputHint: (agent) => topicHint(k, agent) },
  }),
};

/**
 * The hint for an input of a current topic going to `agent`: only when it is offered a `session_*`
 * tool (all its tools, or a list naming one), as the gateway decided before this was a module.
 */
function topicHint(k: KernelContext, agent: string | undefined): string | undefined {
  return k.agents.tools(agent).some((t) => t.startsWith('session_')) ? TOPIC_TOOLS_HINT : undefined;
}
