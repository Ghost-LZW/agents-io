import { ADMIN_ENDPOINTS, type AdminContribution, type ChannelModule } from '@agents-io/protocol';

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
 * A channel type's name: ASCII letters, digits, `-` and `_`, starting with a letter or digit. The
 * type names its entries' owners (`<type>:<owner>`) and state directories (`<type>.<account>`):
 * with a `:` one type could say another's owner (`a:b` + `c` is `a` + `b:c`), with a `.` or `/`
 * share or leave a directory. Two names that differ only in letter case (`Chat`, `chat`) are one
 * directory on a case-insensitive file system (macOS's default), so a registry has at most one of them.
 */
const TYPE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The first member of a channel module that is not what `ChannelModule` says, described; none when
 * all are. A module may be untyped code: one without `create` would pass the config and fail the
 * gateway's start with a TypeError.
 */
function badChannelModule(m: Partial<Record<string, unknown>>): string | undefined {
  if (!isObject(m.entry)) return 'entry (an object of schemas)';
  const required = (['resolve', 'create'] as const).find((k) => typeof m[k] !== 'function');
  if (required) return `${required} (a function)`;
  const optional = (['isCredential', 'credentialHint', 'implicitEnv', 'validateAll', 'owner', 'idOf'] as const).find((k) => m[k] !== undefined && typeof m[k] !== 'function');
  if (optional) return `${optional} (a function when present)`;
  if (m.ids !== undefined && !(Array.isArray(m.ids) && m.ids.every((id) => typeof id === 'string' && id.length > 0))) return 'ids (an array of non-empty strings when present)';
  return m.admin === undefined ? undefined : badAdmin(m.admin);
}

const ROUTE_METHODS: readonly unknown[] = ['GET', 'PUT', 'POST'];

/** The first member of an `AdminContribution` that is not what it says, described (`admin.…`). */
function badAdmin(a: unknown): string | undefined {
  if (!isObject(a)) return 'admin (an object when present)';
  for (const k of ['console', 'schemas'] as const) if (a[k] !== undefined && !(isObject(a[k]) && Object.values(a[k]).every(isObject))) return `admin.${k} (an object of schemas when present)`;
  if (a.mount !== undefined && typeof a.mount !== 'function') return 'admin.mount (a function when present)';
  if (a.routes === undefined) return undefined;
  if (!Array.isArray(a.routes)) return 'admin.routes (an array when present)';
  for (const [i, r] of a.routes.entries()) {
    const bad = badRoute(r);
    if (bad) return `admin.routes[${i}]${bad}`;
  }
  return undefined;
}

/** What is wrong with one `AdminRoute` (`.member (what it must be)`), if anything. */
function badRoute(r: unknown): string | undefined {
  if (!isObject(r)) return ' (an object)';
  if (!ROUTE_METHODS.includes(r.method)) return '.method (GET, PUT or POST)';
  if (typeof r.path !== 'string' || !r.path.startsWith('/api/')) return '.path (a path under /api/)';
  if (r.status !== 200 && r.status !== 202) return '.status (200 or 202)';
  if (!isObject(r.response)) return '.response (a schema)';
  if (r.body !== undefined && !isObject(r.body)) return '.body (a schema when present)';
  if (r.public !== undefined && r.public !== false) return '.public (a module route always needs credentials)';
  if (typeof r.handle !== 'function') return '.handle (a function)';
  return undefined;
}

/** A route's method and path with its parameters unnamed: two routes with the same key are one. */
const routeKey = (e: { method: string; path: string }) => `${e.method} ${e.path.replace(/:[^/]*/g, ':')}`;

/** A route's method and path as the messages name it. */
const routeName = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

/** One registered type's admin contribution (`ChannelModule.admin`). */
export interface ChannelAdminContribution {
  type: string;
  admin: AdminContribution;
}

/**
 * The channel types a deployment's config may name (`channels[].type`), each a `ChannelModule`, in
 * registration order (the order of the config file schema's union). Registration checks each
 * module's type name (`TYPE_NAME`) and members (`badChannelModule`), so a type that passes the
 * config has a `create` to build with. `bundle.ts` builds the built-in one (lark-bot, mail,
 * bridge, module); an embedder may build its own and hand it to `loadConfig` / `resolveConfig`
 * (`channelRegistry`) and to `Gateway.start`, which builds every configured channel through it.
 */
export class ChannelRegistry {
  private readonly byType = new Map<string, ChannelModule>();
  private readonly evidence = new Map<string, DefaultEvidence>();
  /**
   * Reserved channel ids: the ones the registered types declare (`ChannelModule.ids`, in
   * registration order), then the daemon's (`CORE_CHANNEL_IDS`). No entry of another type may use one.
   */
  readonly reservedIds: readonly string[];

  /** The registered types' admin contributions (`ChannelModule.admin`), in registration order. */
  readonly adminContributions: readonly ChannelAdminContribution[];
  private readonly admins: ChannelAdminContribution[] = [];

  constructor(modules: readonly ChannelModule[], o: ChannelRegistryOptions = {}) {
    const ids = new Map<string, string>();
    // What the contributions claim, by kind and name: the type that claimed it.
    const claimed = new Map<string, string>(ADMIN_ENDPOINTS.map((e) => [`route ${routeKey(e)}`, '']));
    for (const m of modules) {
      if (typeof m.type !== 'string' || !m.type) throw new Error('a channel module needs a non-empty type');
      if (!TYPE_NAME.test(m.type)) throw new Error(`channel type ${JSON.stringify(m.type)}: a type name is ASCII letters, digits, "-" and "_", starting with a letter or digit (it names owners "<type>:<owner>" and state directories "<type>.<account>")`);
      if (this.byType.has(m.type)) throw new Error(`channel type ${JSON.stringify(m.type)} is registered twice`);
      const same = [...this.byType.keys()].find((t) => t.toLowerCase() === m.type.toLowerCase());
      if (same !== undefined) throw new Error(`channel type ${JSON.stringify(m.type)}: differs from the registered type ${JSON.stringify(same)} only in letter case (their state directories "<type>.<account>" are one on a case-insensitive file system)`);
      const bad = badChannelModule(m as unknown as Partial<Record<string, unknown>>);
      if (bad) throw new Error(`channel type ${JSON.stringify(m.type)}: bad ${bad}`);
      for (const id of m.ids ?? []) {
        if (CORE_CHANNEL_IDS.includes(id)) throw new Error(`channel type ${JSON.stringify(m.type)}: channel id ${JSON.stringify(id)} is the daemon's own`);
        const other = ids.get(id);
        if (other !== undefined) throw new Error(`channel types ${JSON.stringify(other)} and ${JSON.stringify(m.type)} both declare channel id ${JSON.stringify(id)}`);
        ids.set(id, m.type);
      }
      if (m.admin) this.claimAdmin(m.type, m.admin, claimed);
      this.byType.set(m.type, m);
    }
    for (const [type, ev] of Object.entries(o.defaultEvidence ?? {})) {
      if (!this.byType.has(type)) throw new Error(`defaultEvidence: channel type ${JSON.stringify(type)} is not registered`);
      if (ev !== 'caps' && ev !== 'ungranted') throw new Error(`defaultEvidence: channel type ${JSON.stringify(type)}: ${JSON.stringify(ev)} is neither "caps" nor "ungranted"`);
      this.evidence.set(type, ev);
    }
    this.reservedIds = Object.freeze([...ids.keys(), ...CORE_CHANNEL_IDS]);
    this.adminContributions = Object.freeze(this.admins);
  }

  /**
   * Record `type`'s admin contribution after checking it against the core's endpoints and the
   * contributions registered before it: a route (method and path, parameters unnamed), a console
   * key or a schema name belongs to one type. The console's own keys are config.ts's to check.
   */
  private claimAdmin(type: string, admin: AdminContribution, claimed: Map<string, string>): void {
    const claim = (what: string, name: string) => {
      const other = claimed.get(what);
      if (other === '') throw new Error(`channel type ${JSON.stringify(type)}: admin ${name} is the console's own`);
      if (other !== undefined) throw new Error(`channel types ${JSON.stringify(other)} and ${JSON.stringify(type)} both contribute admin ${name}`);
      claimed.set(what, type);
    };
    for (const r of admin.routes ?? []) claim(`route ${routeKey(r)}`, `route ${routeName(r)}`);
    for (const k of Object.keys(admin.console ?? {})) claim(`console ${k}`, `setting console.${k}`);
    for (const k of Object.keys(admin.schemas ?? {})) claim(`schema ${k}`, `schema ${k}`);
    this.admins.push({ type, admin });
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
   * the type when its module does not say (`bridge:["node",["peer.js"]]`, `lark-bot`). A type name
   * has no `:` (`TYPE_NAME`), so the prefix ends at the first one: no type can say another's owner.
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
