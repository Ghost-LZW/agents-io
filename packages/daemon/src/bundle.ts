import { bridgeChannelModule, type BridgeChannelEntry } from '@agents-io/channel-jsonl-bridge';
import { larkBotChannelModule, type LarkBotChannelEntry, type LarkBotChannelSettings } from '@agents-io/channel-lark-bot';
import { mailChannelModule, type MailChannelEntry } from '@agents-io/channel-mail';
import { claudeCodeHarnessModule } from '@agents-io/harness-claude-code';
import { codexHarnessModule } from '@agents-io/harness-codex';
import { ChannelRegistry } from './channel-registry.js';
import { externalMcpModule, type ExternalMcpSection } from './external-mcp.js';
import { HarnessRegistry } from './harness-registry.js';
import { moduleChannelModule, type ModuleChannelEntry } from './module-channel.js';
import { ModuleRegistry } from './modules.js';
import { liveToolsModule, topicToolsModule, watchToolsModule, type ToolModuleSection } from './tool-modules.js';
import { topicTitleModule, type TopicTitleSection } from './topic-title.js';

/*
 * The composition root (docs/design/core-slimming §6): the built-in modules register here, and
 * only here does the daemon import a module package (`scripts/boundaries.json` `bundle`).
 */

/**
 * The built-in harness kinds; Claude Code first, the default kind. `launchAliases` (deprecated, one
 * release): the `HarnessInstance` fields their launch settings were under before `launch`.
 */
export const builtinHarnesses = new HarnessRegistry([claudeCodeHarnessModule, codexHarnessModule], {
  launchAliases: { [claudeCodeHarnessModule.kind]: 'claude', [codexHarnessModule.kind]: 'codex' },
});

/**
 * The built-in channel types, in the order of the config file schema's union. An entry without an
 * `evidence` grant gives what the adapters shipped here say they can (their `caps.evidence`) for
 * lark-bot and mail; a bridge's or a module's peer is someone else's code, so only `device_only`
 * (channel-stamping E3). This trust is given here, by the composition root, not by the modules.
 * What a type adds to the console is its own (`ChannelModule.admin`: lark-bot's bot provisioning),
 * mounted by the gateway for the types its registry has.
 */
export const builtinChannels = new ChannelRegistry([larkBotChannelModule, mailChannelModule, bridgeChannelModule, moduleChannelModule], {
  defaultEvidence: { [larkBotChannelModule.type]: 'caps', [mailChannelModule.type]: 'caps' },
});

/**
 * The built-in feature modules (core-slimming G6), in the order their tools, commands, features and
 * status entries come after the kernel's own, and the order they start (they stop in reverse).
 * Topic titles made by the model (on unless `topicTitles: { enabled: false }`; a host-level
 * feature, decision 16) come first. Then the model tools beyond the kernel's six, each group on
 * unless its section says `enabled: false`, in the order the tools were always listed: the watch
 * tools (`watchTools`), the live tools (`liveTools`), the topic tools (`topicTools`). The external
 * MCP endpoint (off unless its section `externalMcp` is in the file) is the last: it starts after
 * everything else and stops first, so no external write comes in while the rest stops; a module
 * added later goes before it. Its settings and status stay where they were before it was a
 * module: `Config.externalMcp` (deprecated, one release) and `GET /api/status` `externalMcp`. The
 * features still to move (strangers, owner commands and presets, the Claude Code terminal) live in
 * the gateway; each moves here as its own step.
 */
export const builtinModules = new ModuleRegistry([topicTitleModule, watchToolsModule, liveToolsModule, topicToolsModule, externalMcpModule], {
  origin: 'builtin',
  fields: { [externalMcpModule.id]: { config: 'externalMcp', status: 'externalMcp' } },
});

/** The built-in modules' sections of the config file, as written (`ConfigFile` adds them to the kernel's keys). */
export interface BuiltinModuleSections {
  topicTitles?: TopicTitleSection;
  watchTools?: ToolModuleSection;
  liveTools?: ToolModuleSection;
  topicTools?: ToolModuleSection;
  externalMcp?: ExternalMcpSection;
}

/** The topic titles' section (`topicTitles`: only `enabled`). */
export type { TopicTitleSection } from './topic-title.js';

/** The section of the watch, live and topic tools (`watchTools`, `liveTools`, `topicTools`: only `enabled`). */
export type { ToolModuleSection } from './tool-modules.js';

/** The external MCP endpoint's settings and their parts (`Config.externalMcp`, deprecated: `Config.modules`). */
export { DEFAULT_EXTERNAL_MCP_PORT, type ExternalMcpClient, type ExternalMcpConfig, type ExternalMcpSection } from './external-mcp.js';

/** A built-in channel type's own keys, as written (`ChannelEntry` adds the keys every entry has). */
export type BuiltinChannelEntry = LarkBotChannelEntry | MailChannelEntry | BridgeChannelEntry | ModuleChannelEntry;

/** A built-in channel type's own keys, resolved (`ResolvedChannel` adds the keys every entry has and `account`). */
export type BuiltinChannelSettings = LarkBotChannelSettings | MailChannelEntry | BridgeChannelEntry | ModuleChannelEntry;

/** Deprecated, kept for one release: moved to `@agents-io/channel-lark-bot`. */
export type { LarkChannelConfig } from '@agents-io/channel-lark-bot';
/** Deprecated, kept for one release: moved to `@agents-io/channel-lark-bot` (the default of `console.larkBotCommand`). */
export { CREATE_LARK_BOT } from '@agents-io/channel-lark-bot';
