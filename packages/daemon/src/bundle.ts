import { bridgeChannelModule, type BridgeChannelEntry } from '@agents-io/channel-jsonl-bridge';
import { larkBotChannelModule, type LarkBotChannelEntry, type LarkBotChannelSettings } from '@agents-io/channel-lark-bot';
import { mailChannelModule, type MailChannelEntry } from '@agents-io/channel-mail';
import { claudeCodeHarnessModule } from '@agents-io/harness-claude-code';
import { codexHarnessModule } from '@agents-io/harness-codex';
import { ChannelRegistry } from './channel-registry.js';
import { HarnessRegistry } from './harness-registry.js';
import { moduleChannelModule, type ModuleChannelEntry } from './module-channel.js';

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

/** A built-in channel type's own keys, as written (`ChannelEntry` adds the keys every entry has). */
export type BuiltinChannelEntry = LarkBotChannelEntry | MailChannelEntry | BridgeChannelEntry | ModuleChannelEntry;

/** A built-in channel type's own keys, resolved (`ResolvedChannel` adds the keys every entry has and `account`). */
export type BuiltinChannelSettings = LarkBotChannelSettings | MailChannelEntry | BridgeChannelEntry | ModuleChannelEntry;

/** Deprecated, kept for one release: moved to `@agents-io/channel-lark-bot`. */
export type { LarkChannelConfig } from '@agents-io/channel-lark-bot';
/** Deprecated, kept for one release: moved to `@agents-io/channel-lark-bot` (the default of `console.larkBotCommand`). */
export { CREATE_LARK_BOT } from '@agents-io/channel-lark-bot';
