import type { ChannelModule } from '@agents-io/protocol';

/**
 * Channel ids the daemon itself gives out: local ends (`local`) and agent addresses
 * (`agent:<agent>:<sessionKey>` routes, the `agent` identity namespace the daemon stamps, ID-7).
 * No channel module declares them and no entry may use them.
 */
export const CORE_CHANNEL_IDS: readonly string[] = ['local', 'agent'];

/**
 * The channel types a deployment's config may name (`channels[].type`), each a `ChannelModule`, in
 * registration order (the order of the config file schema's union). `bundle.ts` builds the
 * built-in one (lark-bot, mail, bridge, module); an embedder may build its own and hand it to
 * `resolveConfig` (`channelRegistry`).
 */
export class ChannelRegistry {
  private readonly byType = new Map<string, ChannelModule>();
  /**
   * Reserved channel ids: the ones the registered types declare (`ChannelModule.ids`, in
   * registration order), then the daemon's (`CORE_CHANNEL_IDS`). No entry of another type may use one.
   */
  readonly reservedIds: readonly string[];

  constructor(modules: readonly ChannelModule[]) {
    const ids = new Map<string, string>();
    for (const m of modules) {
      if (typeof m.type !== 'string' || !m.type) throw new Error('a channel module needs a non-empty type');
      if (this.byType.has(m.type)) throw new Error(`channel type ${JSON.stringify(m.type)} is registered twice`);
      for (const id of m.ids ?? []) {
        if (CORE_CHANNEL_IDS.includes(id)) throw new Error(`channel type ${JSON.stringify(m.type)}: channel id ${JSON.stringify(id)} is the daemon's own`);
        const other = ids.get(id);
        if (other !== undefined) throw new Error(`channel types ${JSON.stringify(other)} and ${JSON.stringify(m.type)} both declare channel id ${JSON.stringify(id)}`);
        ids.set(id, m.type);
      }
      this.byType.set(m.type, m);
    }
    this.reservedIds = Object.freeze([...ids.keys(), ...CORE_CHANNEL_IDS]);
  }

  get(type: string): ChannelModule | undefined {
    return this.byType.get(type);
  }

  /** In registration order. */
  get modules(): ChannelModule[] {
    return [...this.byType.values()];
  }

  get types(): string[] {
    return [...this.byType.keys()];
  }
}
