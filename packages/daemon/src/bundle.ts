import type { AdminChannelsApplied } from '@agents-io/protocol';
import { bridgeChannelModule, type BridgeChannelEntry } from '@agents-io/channel-jsonl-bridge';
import { LarkBotJobs, larkBotChannelModule, type LarkBotChannelEntry, type LarkBotChannelSettings, type ProvisionConfig } from '@agents-io/channel-lark-bot';
import { mailChannelModule, type MailChannelEntry } from '@agents-io/channel-mail';
import { claudeCodeHarnessModule } from '@agents-io/harness-claude-code';
import { codexHarnessModule } from '@agents-io/harness-codex';
import { ChannelRegistry } from './channel-registry.js';
import type { ConsoleConfig } from './config.js';
import type { ConsoleHost } from './console.js';
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
 */
export const builtinChannels = new ChannelRegistry([larkBotChannelModule, mailChannelModule, bridgeChannelModule, moduleChannelModule], {
  defaultEvidence: { [larkBotChannelModule.type]: 'caps', [mailChannelModule.type]: 'caps' },
});

/** What the gateway hands the console parts of the built-in channel types (`builtinConsoleParts`). */
export interface ConsolePartsInit {
  /** The config's `console` section. */
  console: ConsoleConfig;
  /** Private work directory (`<dataDir>/provision`; the gateway makes it 0700). */
  dir: string;
  /** The daemon's config file (its `ConfigStore`). */
  config: ProvisionConfig;
  /** Every `env:NAME` a document references (`console-config.ts` `envRefs`). */
  envRefs: (doc: Record<string, unknown>) => string[];
  /** `console.liveChannels`: the gateway's `applyChannels`. */
  applyChannels?: () => Promise<{ channels: AdminChannelsApplied } | undefined>;
  log: (level: 'info' | 'warn', msg: string) => void;
  /** Environment of the children they run (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Console parts: what they add to the console's host, and how they end with the daemon. */
export interface ConsoleParts {
  host: Pick<ConsoleHost, 'larkBots'>;
  close(): void;
}

/**
 * What the built-in channel types add to the console API of a daemon with a config file: lark-bot's
 * bot provisioning (`POST /api/bots/lark`, `GET /api/bots/lark/:job`; `console.larkBotCommand`),
 * when `channels` has the built-in lark-bot type. Transitional: core-slimming G5 turns it into
 * routes the lark-bot module contributes.
 */
export function builtinConsoleParts(channels: ChannelRegistry, o: ConsolePartsInit): ConsoleParts | undefined {
  if (channels.get(larkBotChannelModule.type) !== larkBotChannelModule) return undefined;
  const jobs = new LarkBotJobs({
    command: o.console.larkBotCommand,
    dir: o.dir,
    config: o.config,
    envRefs: o.envRefs,
    ...(o.applyChannels ? { applyChannels: o.applyChannels } : {}),
    log: o.log,
    ...(o.env ? { env: o.env } : {}),
  });
  return { host: { larkBots: jobs }, close: () => jobs.close() };
}

/** A built-in channel type's own keys, as written (`ChannelEntry` adds the keys every entry has). */
export type BuiltinChannelEntry = LarkBotChannelEntry | MailChannelEntry | BridgeChannelEntry | ModuleChannelEntry;

/** A built-in channel type's own keys, resolved (`ResolvedChannel` adds the keys every entry has and `account`). */
export type BuiltinChannelSettings = LarkBotChannelSettings | MailChannelEntry | BridgeChannelEntry | ModuleChannelEntry;

/** Deprecated, kept for one release: moved to `@agents-io/channel-lark-bot`. */
export type { LarkChannelConfig } from '@agents-io/channel-lark-bot';
