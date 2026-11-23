import type { ChannelModule } from '@agents-io/protocol';

/**
 * Channel ids the daemon itself gives out: local ends (`local`) and agent addresses
 * (`agent:<agent>:<sessionKey>` routes, the `agent` identity namespace the daemon stamps, ID-7).
 * No channel module declares them and no entry may use them.
 */
export const CORE_CHANNEL_IDS: readonly string[] = ['local', 'agent'];

/**
 * The evidence an entry gives without its own `evidence` grant (channel-stamping E3): `caps`, all
 * its adapter's `caps.evidence`; `ungranted`, only `device_only` (`UNGRANTED_EVIDENCE`).
 */
export type DefaultEvidence = 'caps' | 'ungranted';

export interface ChannelRegistryOptions {
  /**
   * Per registered type, the evidence its entries give without their own grant (default
   * `ungranted`). The composition root's trust in adapters it ships (`bundle.ts`: lark-bot and
   * mail), never a module's own claim: a `ChannelModule` has no say in it.
   */
  defaultEvidence?: Readonly<Record<string, DefaultEvidence>>;
}

/** A resolved `channels[]` entry, as far as the registry reads it. */
type Entry = { type: string } & Record<string, unknown>;

/**
 * The channel types a deployment's config may name (`channels[].type`), each a `ChannelModule`, in
 * registration order (the order of the config file schema's union). `bundle.ts` builds the
 * built-in one (lark-bot, mail, bridge, module); an embedder may build its own and hand it to
 * `loadConfig` / `resolveConfig` (`channelRegistry`) and to `Gateway.start`, which builds every
 * configured channel through it.
 */
export class ChannelRegistry {
  private readonly byType = new Map<string, ChannelModule>();
  private readonly evidence = new Map<string, DefaultEvidence>();
  /**
   * Reserved channel ids: the ones the registered types declare (`ChannelModule.ids`, in
   * registration order), then the daemon's (`CORE_CHANNEL_IDS`). No entry of another type may use one.
   */
  readonly reservedIds: readonly string[];

  constructor(modules: readonly ChannelModule[], o: ChannelRegistryOptions = {}) {
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
    for (const [type, ev] of Object.entries(o.defaultEvidence ?? {})) {
      if (!this.byType.has(type)) throw new Error(`defaultEvidence: channel type ${JSON.stringify(type)} is not registered`);
      if (ev !== 'caps' && ev !== 'ungranted') throw new Error(`defaultEvidence: channel type ${JSON.stringify(type)}: ${JSON.stringify(ev)} is neither "caps" nor "ungranted"`);
      this.evidence.set(type, ev);
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

  /** What an entry of `type` gives without its own `evidence` grant (`ChannelRegistryOptions.defaultEvidence`). */
  defaultEvidence(type: string): DefaultEvidence {
    return this.evidence.get(type) ?? 'ungranted';
  }

  /**
   * Who an entry's channel id belongs to (channel-stamping F4): `<type>:<ChannelModule.owner>`, or
   * the type when its module does not say (`bridge:["node",["peer.js"]]`, `lark-bot`).
   */
  owner(entry: Entry): string {
    const m = this.byType.get(entry.type);
    return m?.owner ? `${entry.type}:${m.owner(entry)}` : entry.type;
  }

  /** The entry's channel id before its adapter is built: `ChannelModule.idOf`, else the type's one declared id, else unknown. */
  idOf(entry: Entry): string | undefined {
    const m = this.byType.get(entry.type);
    if (!m) return undefined;
    if (m.idOf) return m.idOf(entry);
    return m.ids?.length === 1 ? m.ids[0] : undefined;
  }

  /** Whether an adapter of an entry of `type` may use the channel id `id`: not reserved, or one its type declares. */
  mayUse(type: string, id: string): boolean {
    return !this.reservedIds.includes(id) || (this.byType.get(type)?.ids ?? []).includes(id);
  }
}
