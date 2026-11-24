import { bridgeChannelModule, type BridgeChannelEntry } from '@agents-io/channel-jsonl-bridge';
import { larkBotChannelModule, type LarkBotChannelEntry, type LarkBotChannelSettings } from '@agents-io/channel-lark-bot';
import { mailChannelModule, type MailChannelEntry } from '@agents-io/channel-mail';
import { claudeCodeHarnessModule } from '@agents-io/harness-claude-code';
import { codexHarnessModule } from '@agents-io/harness-codex';
import { bridgeHarnessModule } from '@agents-io/harness-jsonl-bridge';
import { ChannelRegistry } from './channel-registry.js';
import { externalMcpModule, type ExternalMcpSection } from './external-mcp.js';
import { HarnessRegistry } from './harness-registry.js';
import { moduleChannelModule, type ModuleChannelEntry, type ModuleChannelSettings } from './module-channel.js';
import { ModuleRegistry } from './modules.js';
import { ownerCommandsModule, type OwnerCommandsSection } from './owner-commands.js';
import { presetsModule, type PresetsSection } from './presets.js';
import { strangersModule, type StrangersSection } from './strangers.js';
import { liveToolsModule, scheduleToolsModule, topicToolsModule, watchToolsModule, type ToolModuleSection } from './tool-modules.js';
import { topicTitleModule, type TopicTitleSection } from './topic-title.js';

/*
 * The composition root (docs/design/core-slimming §6): the built-in modules register here, and
 * only here does the daemon import a module package (`scripts/boundaries.json` `bundle`).
 */

/**
 * The built-in harness kinds; Claude Code first, the default kind. Then Codex, and the bridge: a
 * harness in another process, any language, over JSONL stdio (`use: "bridge"`), which says what it
 * declares in its hello, so its instances are probed at start (`HarnessModule.probeAtStart`).
 * `launchAliases` (deprecated, one release): the `HarnessInstance` fields their launch settings
 * were under before `launch`.
 */
export const builtinHarnesses = new HarnessRegistry([claudeCodeHarnessModule, codexHarnessModule, bridgeHarnessModule], {
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
 * tools (`watchTools`), the schedule tools (`scheduleTools`), the live tools (`liveTools`), the
 * topic tools (`topicTools`). Then the
 * stranger approval (a host-level feature, decision 16): off unless `policy.strangers: "ask"`,
 * where it always was (or its section `strangers`); `Config.policy.strangers` still says, and
 * written before the start still decides, whether it is on (deprecated, one release). Then the
 * presets (named run defaults, `runDefaults`: a host-level feature, decision 16), on whenever
 * registered: their section `presets` (a map of names) is where it always was in the file's schema,
 * after `harness`, and `Config.presets` (deprecated, one release) is the same object as their
 * settings. Then the owner's run-config chat commands (`/agent`, `/preset`, `/model`, `/effort`,
 * `/plan`, `/bypass`, `/compact` and their `/status` line; a host-level feature, decision 16): on
 * unless `ownerCommands: { enabled: false }`; what they set and `Policy.plan` stay the kernel's,
 * which asks the presets module what a preset gives. The external MCP endpoint (off unless its
 * section `externalMcp` is in the file) is the
 * last: it starts after everything else and stops first, so no external write comes in while the
 * rest stops; a module added later goes before it. Its settings and status stay where they were
 * before it was a module: `Config.externalMcp` (deprecated, one release) and `GET /api/status`
 * `externalMcp`. The Claude Code terminal is not one of these: it is what the claude-code harness
 * kind's adapter does (`HarnessAdapter.takeover`, with the `tui-bridge` command its kind adds to the
 * CLI), and the gateway's part of it names no harness.
 */
export const builtinModules = new ModuleRegistry([topicTitleModule, watchToolsModule, scheduleToolsModule, liveToolsModule, topicToolsModule, strangersModule, presetsModule, ownerCommandsModule, externalMcpModule], {
  origin: 'builtin',
  fields: {
    [strangersModule.id]: { switch: { path: 'policy.strangers', on: 'ask', off: 'drop' } },
    [presetsModule.id]: { config: 'presets', sectionAfter: 'harness' },
    // Its clients' schedules set before a schedule recorded its module (their principals are always `external:…`).
    [externalMcpModule.id]: { config: 'externalMcp', status: 'externalMcp', schedules: 'external:' },
  },
});

/** The built-in modules' sections of the config file, as written (`ConfigFile` adds them to the kernel's keys). */
export interface BuiltinModuleSections {
  topicTitles?: TopicTitleSection;
  watchTools?: ToolModuleSection;
  scheduleTools?: ToolModuleSection;
  liveTools?: ToolModuleSection;
  topicTools?: ToolModuleSection;
  strangers?: StrangersSection;
  presets?: PresetsSection;
  ownerCommands?: OwnerCommandsSection;
  externalMcp?: ExternalMcpSection;
}

/** The topic titles' section (`topicTitles`: only `enabled`). */
export type { TopicTitleSection } from './topic-title.js';

/** The section of the watch, schedule, live and topic tools (`watchTools`, `scheduleTools`, `liveTools`, `topicTools`: only `enabled`). */
export type { ToolModuleSection } from './tool-modules.js';

/** The stranger approval's section (`strangers`: only `enabled`; `policy.strangers` is its older place). */
export type { StrangersSection } from './strangers.js';

/** The presets' section (`presets`: harness instance + model + effort, by name), a preset as resolved (`Config.presets`, deprecated: `Config.modules`), and the reserved name. */
export { DEFAULT_PRESET, type PresetConfig, type PresetsConfig, type PresetsSection } from './presets.js';

/** The owner's run-config commands' section (`ownerCommands`: only `enabled`). */
export type { OwnerCommandsSection } from './owner-commands.js';

/** The external MCP endpoint's settings and their parts (`Config.externalMcp`, deprecated: `Config.modules`). */
export { DEFAULT_EXTERNAL_MCP_PORT, type ExternalMcpClient, type ExternalMcpConfig, type ExternalMcpSection } from './external-mcp.js';

/** A built-in channel type's own keys, as written (`ChannelEntry` adds the keys every entry has). */
export type BuiltinChannelEntry = LarkBotChannelEntry | MailChannelEntry | BridgeChannelEntry | ModuleChannelEntry;

/** A built-in channel type's own keys, resolved (`ResolvedChannel` adds the keys every entry has and `account`). */
export type BuiltinChannelSettings = LarkBotChannelSettings | MailChannelEntry | BridgeChannelEntry | ModuleChannelSettings;

/** Deprecated, kept for one release: moved to `@agents-io/channel-lark-bot`. */
export type { LarkChannelConfig } from '@agents-io/channel-lark-bot';
/** Deprecated, kept for one release: moved to `@agents-io/channel-lark-bot` (the default of `console.larkBotCommand`). */
export { CREATE_LARK_BOT } from '@agents-io/channel-lark-bot';
