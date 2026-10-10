import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  BindingAction,
  BindingTable,
  SessionLaunch,
  SessionScope,
  errors,
  routeKey,
  type Binding,
  type BindingMatch,
  type Evidence,
  type IdentifyArgs,
  type Identity,
  type InboundEnvelope,
  type InputMode,
  type InputRecord,
  type Origin,
  type Policy,
  type Principal,
  type RouteExplanation,
  type Watch,
  type WatchSource,
} from '@agents-io/protocol';
import { IdentityError, IdentityMap, OWNER_LABEL, checkIdentities, ownerIdentities, type IdentityRules } from './identity.js';
import { conversationRouteKey } from './policy.js';
import { titleFrom, type TopicCreateOptions, type TopicDraft, type TopicRecord, type TopicRegistry } from './topics.js';
import { contentText } from './watch.js';

/*
 * Routing (docs/HOSTS.md §2, decisions 1–3). Every stamped input is matched
 * against the active binding tables — the local config table, at most one table
 * a host pushed, and the runtime watch rules — with fixed fields only. Every
 * matching rule applies (fan-out); per target session the strongest action wins
 * (dispatch > digest > context); `host` and `drop` stand on their own; an input
 * no rule matches is dropped. No model is ever called here: a rule that needs a
 * judgement hands the input to the host (`on: "host"`) or asks it synchronously
 * (`callout`). Every decision is explained and the explanation is persisted.
 */

export class RouterError extends Error {
  override name = 'RouterError';
  constructor(
    readonly code: 'invalid' | 'conflict' | 'task_agent' | 'unknown_agent' | 'stale_version',
    message: string,
  ) {
    super(message);
  }
}

/**
 * A named run configuration of the host app (harness instance, model, profile,
 * cwd, tools: the app keeps those). The router only needs its name, whether it
 * may be a binding target, and how its session keys are spelled.
 */
export interface AgentSpec {
  name: string;
  /** `task` agents only run through `run.start`: a table naming one is rejected. */
  mode?: 'interactive' | 'task';
  /** Session key of `session: "main"` (default `<name>:main`). */
  mainSession?: string;
  /** Prefix of resolved per-conversation / per-thread keys (default `<name>:`; `''` = the bare route key). */
  sessionPrefix?: string;
}

export type BindingSource = RouteExplanation['matched'][number]['source'];
type Effective = 'dispatch' | 'context' | 'digest';
export type CalloutOutcome = NonNullable<RouteExplanation['matched'][number]['callout']>['outcome'];

/** One target session of a routed input. */
export interface RouteDelivery {
  bindingId: string;
  source: BindingSource;
  on: Effective;
  /** Absent for watch rules: they name a session, not an agent. */
  agent?: string;
  sessionKey: string;
  /** Watch rules: the watch to deliver through (`WatchDispatcher.deliverWatch`). */
  watchId?: string;
  /** Digest rules of a table. */
  digest?: { everyMs: number; maxItems?: number };
  /** For the digest text. */
  note?: string;
  /** The rule's match, to describe a digest's source. */
  match?: BindingMatch;
  /** Legacy `Policy.admit` only. */
  mode?: InputMode;
  /** `session: "topic"`: the conversation's current topic this delivery resolved to. */
  topic?: { id: string; conversation: string; title?: string };
  /** A callout answer's launch for this session, as checked (`RouterOptions.launches`). */
  launch?: SessionLaunch;
}

/** The daemon's view of session launches (decision 7). */
export interface RouterLaunches {
  /**
   * Whether `launch` may apply to `sessionKey` (read-only; the session is pinned
   * when its lane opens): `applied` for a new session, `same` when it is already
   * pinned to it, else a refusal code (`launch_conflict`, `launch_not_allowed`, …).
   */
  check(a: { sessionKey: string; agent: string | undefined; launch: SessionLaunch }): { ok: true; outcome: 'applied' | 'same'; launch: SessionLaunch } | { ok: false; code: string; message: string };
  /** The session has a pinned launch (`callout.skipWhenPinned`). */
  pinned(sessionKey: string): boolean;
}

/** `RouteExplanation` plus why nothing was delivered, and when (not in the protocol type yet). */
export type Explanation = RouteExplanation & {
  at: number;
  /** `adapter`: the adapter marked the envelope a drop; `no_match`: no rule matched; `drop_rule`: only drop rules matched. */
  dropped?: 'adapter' | 'no_match' | 'drop_rule';
};

export interface RouteDecision {
  /** One per target session: the strongest matching action for it. */
  deliveries: RouteDelivery[];
  /** Put into the host inbound queue (the first matching `host` rule). */
  host?: { bindingId: string; source: BindingSource };
  explanation: Explanation;
}

/** A host's answer to a `route` callout; replaces the rule's `on` / `agent` / `session`. */
export interface CalloutAnswer {
  on: BindingAction;
  agent?: string;
  session?: SessionScope;
  /** Feature `session.launch`: how the session the input lands in is launched. */
  launch?: SessionLaunch;
}

export type RouteCallout = (bindingId: string, input: InputRecord, envelope: InboundEnvelope) => Promise<CalloutAnswer>;

export interface RouterOptions {
  /** Every agent a rule may name. */
  agents: AgentSpec[];
  /** Agent of dispatch/context/digest rules that name none. */
  defaultAgent?: string;
  /** The local config table (e.g. `ownersTable(...)`). */
  config?: BindingTable;
  /** Runtime rules: every live watch is one binding (`watchBinding`). */
  watches?: { list(): Watch[] };
  /** Own bot accounts (`${channel}:${channelUserId}`): echoes, and who `mentions: ["self"]` means. */
  selfAccounts?: string[];
  agentAccounts?: string[];
  isSelfDeclared?: (declared: string) => boolean;
  /** SQLite file or `:memory:` (default) for the host table and explanations. Ignored when `db` is given. */
  path?: string;
  /** Share an open database (e.g. `SqliteSessionLog.db`); the router then never closes it. */
  db?: DatabaseSync;
  /**
   * The topic table (decision 6). Without one, `session: "topic"` resolves like
   * `per-thread` (one session per conversation, or per thread when there is one).
   */
  topics?: TopicRegistry;
  /** Answers rule callouts (the daemon forwards to the connected host). */
  routeCallout?: RouteCallout;
  /** Callout timeout when the rule names none (default 1500 ms). */
  calloutTimeoutMs?: number;
  /** Whether a host is connected at start (default false: a persisted host table stays suspended until `setHostConnected(true)`). */
  hostConnected?: boolean;
  /**
   * Legacy: a host app's own `Policy.admit`. Honoured only while no table is
   * configured (no config table and no active host table); its verdict becomes a
   * single synthetic rule `legacy:admit`. Watches still apply as rules.
   */
  legacyAdmit?: Policy['admit'];
  now?: () => number;
  /** How long explanations are kept (default 7 days). */
  explainTtlMs?: number;
  log?: (level: 'debug' | 'info' | 'warn', msg: string) => void;
  /** Session launches (decision 7). Without it a callout answer with `launch` is an error. */
  launches?: RouterLaunches;
}

const DAY = 86_400_000;
const STRENGTH: Record<Effective, number> = { dispatch: 3, digest: 2, context: 1 };
const KINDS = new Set(['dm', 'group', 'thread', 'meeting', 'call', 'mail', 'other']);
const NON_DM_KINDS = ['group', 'thread', 'meeting', 'call', 'mail', 'other'] as const;

/** Host table state for `bindings.get` and operators. */
export interface HostTableState {
  table: BindingTable;
  putAt: number;
  active: boolean;
  /** Why it is not active. */
  suspended?: 'expired' | 'host_down';
}

interface Rule {
  binding: Binding;
  source: BindingSource;
  watchId?: string;
}

/**
 * Deterministic router over the binding tables. Construct once per deployment;
 * `route` is safe to call concurrently (it only reads).
 */
export class Router {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly now: () => number;
  private readonly agents = new Map<string, AgentSpec>();
  private readonly selfAccounts: Set<string>;
  private config: BindingTable | undefined;
  private host: { table: BindingTable; putAt: number } | undefined;
  private connected: boolean;
  private identities!: IdentityMap;
  private q: Record<'tablePut' | 'tableGet' | 'tableDel' | 'explainPut' | 'explainGet' | 'explainPrune', StatementSync>;
  private records = 0;

  constructor(private readonly o: RouterOptions) {
    for (const a of o.agents) {
      if (!a.name) throw new RouterError('invalid', 'agent without a name');
      if (this.agents.has(a.name)) throw new RouterError('invalid', `agent ${a.name} is defined twice`);
      this.agents.set(a.name, a);
    }
    if (o.defaultAgent !== undefined) this.target(o.defaultAgent, 'defaultAgent');
    this.now = o.now ?? Date.now;
    this.selfAccounts = new Set(o.selfAccounts ?? []);
    this.connected = o.hostConnected ?? false;
    this.ownsDb = !o.db;
    this.db = o.db ?? new DatabaseSync(o.path ?? ':memory:');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS router_tables (source TEXT PRIMARY KEY, json TEXT NOT NULL, put_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS router_explain (input_id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS router_explain_at ON router_explain (at);
    `);
    const p = (sql: string) => this.db.prepare(sql);
    this.q = {
      tablePut: p('INSERT INTO router_tables (source, json, put_at) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET json = excluded.json, put_at = excluded.put_at'),
      tableGet: p('SELECT json, put_at FROM router_tables WHERE source = ?'),
      tableDel: p('DELETE FROM router_tables WHERE source = ?'),
      explainPut: p('INSERT INTO router_explain (input_id, at, json) VALUES (?, ?, ?) ON CONFLICT(input_id) DO UPDATE SET at = excluded.at, json = excluded.json'),
      explainGet: p('SELECT json FROM router_explain WHERE input_id = ?'),
      explainPrune: p('DELETE FROM router_explain WHERE at < ?'),
    };
    if (o.config) this.validate(o.config, 'config');
    this.config = o.config && structuredClone(o.config);
    const row = this.q.tableGet.get('host') as { json: string; put_at: number } | undefined;
    if (row) {
      const table = JSON.parse(row.json) as BindingTable;
      try {
        this.validate(table, 'host');
        this.host = { table, putAt: row.put_at };
      } catch (e) {
        // The agents changed under a persisted table: keep the old one out rather than fail to start.
        o.log?.('warn', `persisted host table ${table.version} no longer valid, ignored: ${(e as Error).message}`);
      }
    }
    this.rebuildIdentities();
  }

  // ---- tables -------------------------------------------------------------

  /** Replace the local config table (validated first; nothing changes when it is invalid). */
  setConfigTable(table: BindingTable | undefined): void {
    if (table) this.validate(table, 'config');
    this.config = table && structuredClone(table);
    this.rebuildIdentities();
  }

  configTable(): BindingTable | undefined {
    return this.config && structuredClone(this.config);
  }

  /**
   * `bindings.put`: validate, then atomically replace the host table and persist
   * it. The same version again is a no-op. Throws `RouterError` (and keeps the
   * current table) when the table is invalid.
   */
  putHostTable(table: BindingTable): { version: string; previous?: string; changed: boolean } {
    this.validate(table, 'host');
    const previous = this.host?.table.version;
    if (this.host && previous === table.version && JSON.stringify(this.host.table) === JSON.stringify(table)) return { version: table.version, previous, changed: false };
    // HQ-5: decimal-integer versions (a counter, a ms timestamp) are ordered, so a late older
    // push never replaces a newer table. Other versions are opaque labels: any one replaces.
    if (previous !== undefined && olderVersion(table.version, previous)) {
      throw new RouterError('stale_version', `host table ${table.version} is older than the installed ${previous}; push a version above ${previous}`);
    }
    const putAt = this.now();
    this.q.tablePut.run('host', JSON.stringify(table), putAt);
    this.host = { table: structuredClone(table), putAt };
    this.rebuildIdentities();
    this.o.log?.('info', `host table ${table.version} installed${previous !== undefined ? ` (was ${previous})` : ''}: ${table.bindings.length} bindings, ${table.identities.length} identities`);
    return { version: table.version, ...(previous !== undefined ? { previous } : {}), changed: true };
  }

  /** Remove the host table (and its identities). */
  clearHostTable(): boolean {
    const had = !!this.host;
    this.q.tableDel.run('host');
    this.host = undefined;
    this.rebuildIdentities();
    return had;
  }

  hostTable(): HostTableState | undefined {
    if (!this.host) return undefined;
    const why = this.suspension();
    return { table: structuredClone(this.host.table), putAt: this.host.putAt, active: why === undefined, ...(why ? { suspended: why } : {}) };
  }

  /**
   * The daemon reports its host connection. While disconnected, a host table with
   * `onHostDown: "suspend"` (the default) is out of routing, its identities too;
   * callouts answer `no_host`.
   */
  setHostConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.rebuildIdentities();
    if (this.host) this.o.log?.('info', `host ${connected ? 'connected' : 'disconnected'}; host table ${this.host.table.version} ${this.suspension() ? 'suspended' : 'active'}`);
  }

  get hostConnected(): boolean {
    return this.connected;
  }

  private suspension(): HostTableState['suspended'] {
    const h = this.host?.table;
    if (!h) return undefined;
    if (h.expiresAt !== undefined && h.expiresAt <= this.now()) return 'expired';
    if (!this.connected && (h.onHostDown ?? 'suspend') === 'suspend') return 'host_down';
    return undefined;
  }

  private activeHost(): BindingTable | undefined {
    return this.host && this.suspension() === undefined ? this.host.table : undefined;
  }

  private rebuildIdentities(): void {
    const rules: IdentityRules = {
      ...(this.o.selfAccounts ? { selfAccounts: this.o.selfAccounts } : {}),
      ...(this.o.agentAccounts ? { agentAccounts: this.o.agentAccounts } : {}),
      ...(this.o.isSelfDeclared ? { isSelfDeclared: this.o.isSelfDeclared } : {}),
    };
    const host = this.activeHost();
    this.identities = new IdentityMap([this.config?.identities ?? [], host?.identities ?? []], rules);
    this.identitiesExpireAt = host?.expiresAt;
  }

  private identitiesExpireAt: number | undefined;

  /** Throws `RouterError` naming the first problem. */
  validate(table: BindingTable, source: 'config' | 'host'): void {
    const errs = errors(BindingTable, table);
    if (errs.length) throw new RouterError('invalid', `invalid ${source} table: ${errs.slice(0, 3).join('; ')}`);
    const ids = new Set<string>();
    for (const b of table.bindings) {
      const where = `${source} table ${table.version}, binding ${JSON.stringify(b.id)}`;
      if (!b.id.trim()) throw new RouterError('invalid', `${source} table ${table.version}: binding with an empty id`);
      if (ids.has(b.id)) throw new RouterError('invalid', `${where}: id used twice`);
      ids.add(b.id);
      const actions = [b.on, ...(b.callout?.onFailure ? [b.callout.onFailure] : [])];
      if (actions.some(targets) || b.agent !== undefined) this.target(b.agent ?? this.o.defaultAgent, where);
      if (typeof b.session === 'object' && !b.session.key) throw new RouterError('invalid', `${where}: session.key is empty`);
      if (actions.includes('digest') && !(b.digest && b.digest.everyMs > 0)) throw new RouterError('invalid', `${where}: digest needs digest.everyMs > 0`);
      if (b.digest?.maxItems !== undefined && !(b.digest.maxItems >= 1)) throw new RouterError('invalid', `${where}: digest.maxItems must be >= 1`);
      if (b.match.conversationKind !== undefined && !KINDS.has(b.match.conversationKind)) throw new RouterError('invalid', `${where}: unknown conversationKind`);
      if (b.callout?.skipWhenPinned && !targets(b.on)) throw new RouterError('invalid', `${where}: callout.skipWhenPinned needs an on that targets a session (dispatch, context, digest)`);
    }
    try {
      checkIdentities(table.identities);
    } catch (e) {
      if (e instanceof IdentityError) throw new RouterError(e.code === 'conflict' ? 'conflict' : 'invalid', `${source} table ${table.version}: ${e.message}`);
      throw e;
    }
  }

  /** The agent a rule targets; throws for an unknown or task agent. */
  private target(name: string | undefined, where: string): AgentSpec {
    if (name === undefined) throw new RouterError('invalid', `${where}: no agent named and no defaultAgent`);
    const a = this.agents.get(name);
    if (!a) throw new RouterError('unknown_agent', `${where}: unknown agent ${JSON.stringify(name)} (agents: ${[...this.agents.keys()].join(', ') || 'none'})`);
    if (a.mode === 'task') throw new RouterError('task_agent', `${where}: agent ${JSON.stringify(name)} is a task agent; task agents only run through run.start and can not be a binding target`);
    return a;
  }

  // ---- identity -----------------------------------------------------------

  /**
   * Identify a sender with the active identity maps (config `owners` + the host
   * map; the host's entry wins for the same channel identity). Use it as
   * `Policy.identify`.
   */
  identify(a: IdentifyArgs): Identity {
    if (this.identitiesExpireAt !== undefined && this.identitiesExpireAt <= this.now()) this.rebuildIdentities();
    return this.identities.identify(a);
  }

  /** The principal of one of this deployment's agents (`IdentityMap.agentPrincipal`; the host map may name it). */
  agentPrincipal(agent: string): Principal {
    if (this.identitiesExpireAt !== undefined && this.identitiesExpireAt <= this.now()) this.rebuildIdentities();
    return this.identities.agentPrincipal(agent);
  }

  // ---- routing ------------------------------------------------------------

  /** Rules in evaluation order: config, host (when active), legacy admit (when no table), watches. */
  private rules(): Rule[] {
    const out: Rule[] = [];
    for (const binding of this.config?.bindings ?? []) out.push({ binding, source: 'config' });
    for (const binding of this.activeHost()?.bindings ?? []) out.push({ binding, source: 'host' });
    for (const w of this.o.watches?.list() ?? []) out.push({ binding: watchBinding(w), source: 'watch', watchId: w.id });
    return out;
  }

  private versions(): string[] {
    const h = this.activeHost();
    return [...(this.config ? [this.config.version] : []), ...(h ? [h.version] : [])];
  }

  /**
   * Route one stamped input. Does not record the explanation (`record` does),
   * so the caller can still settle the input id.
   */
  async route(env: InboundEnvelope, origin: Origin, input: InputRecord): Promise<RouteDecision> {
    const explanation: Explanation = {
      inputId: input.inputId,
      tableVersions: this.versions(),
      matched: [],
      principal: origin.principal?.id ?? null,
      evidence: origin.evidence,
      at: this.now(),
    };
    // Auto-replies, bounces, bulk mail: not a message for anyone, not even a watch.
    if (env.admission === 'drop') return { deliveries: [], explanation: { ...explanation, dropped: 'adapter' } };

    const rules = this.rules();
    const hits = rules.filter((r) => matches(r.binding.match, env, origin, this.selfAccounts));
    // Callouts run in parallel so one slow host does not add up per rule.
    const resolved = await Promise.all(hits.map((r) => this.resolve(r, env, input)));
    if (this.o.legacyAdmit && !this.config && !this.activeHost()) resolved.unshift(await this.legacy(env, origin));

    const best = new Map<string, RouteDelivery>();
    let host: RouteDecision['host'];
    for (const answered of resolved) {
      let r = answered;
      let p = this.place(r, env, origin);
      if (r.launch !== undefined && p.delivery) {
        const c = this.o.launches
          ? this.o.launches.check({ sessionKey: p.delivery.sessionKey, agent: p.delivery.agent, launch: r.launch })
          : { ok: false as const, code: 'launch_unsupported', message: 'this router takes no session launches' };
        const shown = { ...(r.launch.cwd !== undefined ? { cwd: r.launch.cwd } : {}), envKeys: Object.keys(r.launch.env ?? {}).sort(), outcome: c.ok ? c.outcome : c.code };
        if (c.ok) p.delivery.launch = c.launch;
        else {
          // The answer counts as an error: the rule's failure mode applies, without the launch.
          this.o.log?.('warn', `callout for binding ${r.binding.id}: launch for ${p.delivery.sessionKey} refused: ${c.code}: ${c.message}`);
          r = r.failed!(c.code);
          p = this.place(r, env, origin);
        }
        p.entry.launch = shown;
      }
      const { on, entry, delivery: d } = p;
      if (d) {
        const prior = best.get(d.sessionKey);
        // Same session: the strongest action wins; on a tie the earlier rule (config before host before watches).
        // A launch rides along whichever delivery wins.
        if (!prior || STRENGTH[on as Effective] > STRENGTH[prior.on]) best.set(d.sessionKey, prior?.launch && !d.launch ? { ...d, launch: prior.launch } : d);
        else if (d.launch && !prior.launch) prior.launch = d.launch;
      } else if (on === 'host') host ??= { bindingId: r.binding.id, source: r.source };
      explanation.matched.push(entry);
    }
    const deliveries = [...best.values()];
    if (!deliveries.length && !host) {
      explanation.dropped = explanation.matched.length ? 'drop_rule' : 'no_match';
      if (!explanation.matched.length) this.o.log?.('debug', `input ${input.inputId} from ${origin.via} (${origin.principal?.id ?? 'unknown'}) matched no binding: dropped`);
    }
    return { deliveries, ...(host ? { host } : {}), explanation };
  }

  /**
   * Where a host redispatches a queued input (`inbound.redispatch`): the session
   * a `dispatch` rule for `agent` (default: the default agent) with `session`
   * (default `per-conversation`) would pick for this envelope, and `launch`
   * checked as a callout answer's would be. The origin is the one the input was
   * stamped with when it arrived; the deployment's own echo is recorded as
   * context, never a turn. Throws `RouterError` for an unknown or task agent, a
   * bad scope or a task run session key; a refused launch is `{ ok: false }`. Records nothing.
   */
  redirect(
    env: InboundEnvelope,
    origin: Origin,
    o: { inputId: string; agent?: string; session?: SessionScope; launch?: SessionLaunch; redispatchOf: NonNullable<Explanation['redispatchOf']> },
  ): { ok: true; delivery: RouteDelivery; explanation: Explanation } | { ok: false; code: string; message: string } {
    if (o.session !== undefined && errors(SessionScope, o.session).length) throw new RouterError('invalid', `session ${JSON.stringify(o.session)}`);
    if (o.launch !== undefined && errors(SessionLaunch, o.launch).length) throw new RouterError('invalid', `launch ${JSON.stringify(Object.keys(o.launch ?? {}))}`);
    const agent = this.target(o.agent ?? this.o.defaultAgent, 'inbound.redispatch');
    const r: Resolved = { binding: { id: REDISPATCH_RULE, match: {}, on: 'dispatch' }, source: 'host', on: 'dispatch', agent: agent.name, ...(o.session !== undefined ? { session: o.session } : {}) };
    const { entry, delivery } = this.place(r, env, origin);
    if (!delivery) throw new RouterError('invalid', 'redispatch has no target session');
    if (delivery.sessionKey.startsWith('run:')) throw new RouterError('invalid', `${delivery.sessionKey} is a task run session key (task runs use run.start)`);
    if (o.launch !== undefined) {
      const c = this.o.launches
        ? this.o.launches.check({ sessionKey: delivery.sessionKey, agent: delivery.agent, launch: o.launch })
        : { ok: false as const, code: 'launch_unsupported', message: 'this router takes no session launches' };
      if (!c.ok) return c;
      delivery.launch = c.launch;
      entry.launch = { ...(o.launch.cwd !== undefined ? { cwd: o.launch.cwd } : {}), envKeys: Object.keys(o.launch.env ?? {}).sort(), outcome: c.outcome };
    }
    const explanation: Explanation = {
      inputId: o.inputId,
      tableVersions: this.versions(),
      matched: [entry],
      principal: origin.principal?.id ?? null,
      evidence: origin.evidence,
      at: this.now(),
      redispatchOf: o.redispatchOf,
    };
    return { ok: true, delivery, explanation };
  }

  /** Where one resolved rule puts the input: its explanation entry and, for an action that targets a session, the delivery. */
  private place(r: Resolved, env: InboundEnvelope, origin: Origin): { on: BindingAction; entry: RouteExplanation['matched'][number]; delivery?: RouteDelivery } {
    let on = r.on;
    // Our own echoes are recorded at most, never start a turn: no rule can make the deployment loop on its output.
    if (origin.self && on === 'dispatch') on = 'context';
    const entry: RouteExplanation['matched'][number] = { bindingId: r.binding.id, source: r.source, on, ...(r.callout ? { callout: r.callout } : {}) };
    if (!targets(on)) return { on, entry };
    const agent = r.watchId !== undefined || r.legacyKey !== undefined ? undefined : this.agents.get(r.agent ?? this.o.defaultAgent ?? '');
    const scope = r.legacyKey !== undefined ? { sessionKey: r.legacyKey } : this.scope(r.session, agent, env, on);
    const sessionKey = scope.sessionKey;
    if (agent) entry.agent = agent.name;
    entry.sessionKey = sessionKey;
    const delivery: RouteDelivery = {
      bindingId: r.binding.id,
      source: r.source,
      on,
      sessionKey,
      ...(agent ? { agent: agent.name } : {}),
      ...(r.watchId !== undefined ? { watchId: r.watchId } : {}),
      ...(on === 'digest' && r.binding.digest ? { digest: r.binding.digest } : {}),
      ...(r.binding.note !== undefined ? { note: r.binding.note } : {}),
      ...(r.source !== 'watch' ? { match: r.binding.match } : {}),
      ...(r.mode ? { mode: r.mode } : {}),
      ...(scope.topic ? { topic: { id: scope.topic.id, conversation: scope.topic.conversation, ...(scope.topic.title !== undefined ? { title: scope.topic.title } : {}) } } : {}),
    };
    return { on, entry, delivery };
  }

  private async resolve(r: Rule, env: InboundEnvelope, input: InputRecord): Promise<Resolved> {
    const b = r.binding;
    const base: Resolved = { ...r, on: b.on, ...(b.agent !== undefined ? { agent: b.agent } : {}), ...(b.session !== undefined ? { session: b.session } : {}) };
    if (!b.callout) return base;
    const onFailure = b.callout.onFailure ?? 'host';
    const fail = (outcome: CalloutOutcome, reason?: string): Resolved => ({ ...base, on: onFailure, callout: { outcome, on: onFailure, ...(reason !== undefined ? { reason } : {}) } });
    // Once the rule's own session is pinned (a launch recorded), the rule routes alone: the host is asked once per session key.
    if (b.callout.skipWhenPinned && targets(b.on) && this.o.launches) {
      const key = this.scope(b.session, this.agents.get(b.agent ?? this.o.defaultAgent ?? ''), env, b.on, true).sessionKey;
      if (this.o.launches.pinned(key)) return { ...base, callout: { outcome: 'skipped_pinned', on: b.on } };
    }
    const call = this.o.routeCallout;
    if (!call || !this.connected) return fail('no_host');
    const { raw: _raw, ...envelope } = env;
    let answer: CalloutAnswer;
    try {
      answer = await withTimeout(call(b.id, input, envelope), b.callout.timeoutMs ?? this.o.calloutTimeoutMs ?? 1500);
    } catch (e) {
      this.o.log?.('warn', `callout for binding ${b.id} failed: ${(e as Error).message}`);
      return fail(e instanceof CalloutTimeout ? 'timeout' : 'error');
    }
    const bad = this.badAnswer(answer, b);
    if (bad) {
      this.o.log?.('warn', `callout for binding ${b.id} answered badly: ${bad}`);
      return fail('error', answer && typeof answer === 'object' && answer.launch !== undefined ? 'bad_launch' : undefined);
    }
    return {
      ...base,
      on: answer.on,
      ...(answer.agent !== undefined ? { agent: answer.agent } : {}),
      ...(answer.session !== undefined ? { session: answer.session } : {}),
      callout: { outcome: 'answered', on: answer.on },
      ...(answer.launch !== undefined ? { launch: answer.launch, failed: (reason: string) => fail('error', reason) } : {}),
    };
  }

  private badAnswer(a: CalloutAnswer, b: Binding): string | undefined {
    if (!a || typeof a !== 'object') return 'not an object';
    if (errors(BindingAction, a.on).length) return `on ${JSON.stringify(a.on)}`;
    if (a.session !== undefined && errors(SessionScope, a.session).length) return `session ${JSON.stringify(a.session)}`;
    if (a.on === 'digest' && !b.digest) return 'digest, but the rule has no digest settings';
    if (a.launch !== undefined) {
      if (errors(SessionLaunch, a.launch).length) return `launch ${JSON.stringify(Object.keys(a.launch ?? {}))}`;
      if (!targets(a.on)) return `launch with on ${JSON.stringify(a.on)} (only with an on that targets a session)`;
    }
    if (targets(a.on) || a.agent !== undefined) {
      try {
        this.target(a.agent ?? b.agent ?? this.o.defaultAgent, `callout answer for ${b.id}`);
      } catch (e) {
        return (e as Error).message;
      }
    }
    return undefined;
  }

  private async legacy(env: InboundEnvelope, origin: Origin): Promise<Resolved> {
    const a = await this.o.legacyAdmit!(env, origin);
    const binding: Binding = { id: 'legacy:admit', match: {}, on: a.action === 'dispatch' ? 'dispatch' : a.action === 'observe' ? 'context' : 'drop' };
    return {
      binding,
      source: 'config',
      on: binding.on,
      legacyKey: a.sessionKey ?? conversationRouteKey(env),
      ...(a.mode ? { mode: a.mode } : {}),
    };
  }

  /**
   * Session key of a scope for an agent (watch rules always name `{ key }`). For
   * `topic` this resolves (and on first use creates) the conversation's current topic.
   */
  sessionKey(scope: SessionScope | undefined, agent: AgentSpec | undefined, env: InboundEnvelope): string {
    return this.scope(scope, agent, env).sessionKey;
  }

  private scope(scope: SessionScope | undefined, agent: AgentSpec | undefined, env: InboundEnvelope, on?: BindingAction, peek = false): { sessionKey: string; topic?: TopicRecord } {
    const s = scope ?? 'per-conversation';
    if (typeof s === 'object') return { sessionKey: s.key };
    const name = agent?.name ?? this.o.defaultAgent ?? 'default';
    if (s === 'main') return { sessionKey: agent?.mainSession ?? `${name}:main` };
    const prefix = agent?.sessionPrefix ?? `${name}:`;
    // Context (and digest items) of a flat conversation that keeps topics go where its turns go now, the current
    // topic, also from per-thread / per-conversation rules such as the default `observe-<kind>` (whose key is the first topic's).
    if (s !== 'topic' && on !== undefined && on !== 'dispatch' && env.conversation.threadId === undefined && this.o.topics) {
      const cur = this.o.topics.current(topicConversation(env), name);
      if (cur) return { sessionKey: cur.sessionKey };
    }
    // Threaded conversations keep one session per thread; without a topic table a topic is the conversation.
    if (s === 'per-thread' || (s === 'topic' && (env.conversation.threadId !== undefined || !this.o.topics))) return { sessionKey: prefix + conversationRouteKey(env) };
    const conversation = topicConversation(env);
    if (s === 'topic' && peek) {
      // Without creating or touching the topic: the current one's key, else the first topic's (the conversation's own).
      return { sessionKey: this.o.topics!.current(conversation, name)?.sessionKey ?? prefix + conversation };
    }
    if (s === 'topic') {
      const title = titleFrom(contentText(env.content, 400));
      const { topic, created } = this.o.topics!.ensureCurrent(conversation, name, this.topicKey(name, conversation), title !== undefined ? { title } : {});
      if (!created) this.o.topics!.touch(topic.sessionKey);
      return { sessionKey: topic.sessionKey, topic };
    }
    return { sessionKey: prefix + conversation };
  }

  /**
   * How an agent's topic sessions are spelled: the first topic of a conversation
   * keeps the conversation's own key (what `per-conversation` names, so a session
   * from before topics carries on as the first topic), later ones add `#<topicId>`.
   */
  topicKey(agentName: string, conversation: string) {
    const prefix = this.agents.get(agentName)?.sessionPrefix ?? `${agentName}:`;
    return ({ topicId, first }: { topicId: string; first: boolean }) => (first ? prefix + conversation : `${prefix}${conversation}#${topicId}`);
  }

  /** Start a new topic in a conversation (it becomes current). Throws without a topic table. */
  newTopic(agentName: string, conversation: string, draft: TopicDraft, reason: 'user' | 'agent' | 'system', opts: TopicCreateOptions = {}) {
    if (!this.o.topics) throw new RouterError('invalid', 'no topic table');
    this.target(agentName, 'newTopic');
    return this.o.topics.create(conversation, agentName, this.topicKey(agentName, conversation), draft, reason, opts);
  }

  /** The topic table, when there is one. */
  get topics(): TopicRegistry | undefined {
    return this.o.topics;
  }

  // ---- explanations -------------------------------------------------------

  /** Persist an explanation (`explain` finds it after a restart too). */
  record(e: Explanation): void {
    this.q.explainPut.run(e.inputId, e.at, JSON.stringify(e));
    if (++this.records % 1000 === 0) this.q.explainPrune.run(this.now() - (this.o.explainTtlMs ?? 7 * DAY));
  }

  /** Why an input went where it went (`aio explain <inputId>`). */
  explain(inputId: string): Explanation | undefined {
    const row = this.q.explainGet.get(inputId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Explanation) : undefined;
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}

interface Resolved extends Rule {
  on: BindingAction;
  agent?: string;
  session?: SessionScope;
  callout?: { outcome: CalloutOutcome; on: BindingAction; reason?: string };
  /** A callout answer's launch, and the rule's failure mode should it be refused. */
  launch?: SessionLaunch;
  failed?: (reason: string) => Resolved;
  /** Legacy admit: the session it named. */
  legacyKey?: string;
  mode?: InputMode;
}

/** Route key of the conversation an envelope belongs to, without thread: what topics are kept per. */
export function topicConversation(env: InboundEnvelope): string {
  return routeKey({ channel: env.channel, account: env.account, conversationId: env.conversation.id });
}

/** Binding id of an `inbound.redispatch` delivery in `explain`. */
export const REDISPATCH_RULE = 'host:redispatch';

const targets = (on: BindingAction): on is Effective => on === 'dispatch' || on === 'context' || on === 'digest';

/** `v` is older than `than`: both are decimal integers and `v` is smaller. */
function olderVersion(v: string, than: string): boolean {
  const dec = /^\d{1,30}$/;
  return dec.test(v) && dec.test(than) && BigInt(v) < BigInt(than);
}

class CalloutTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new CalloutTimeout(`no answer within ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

// ---- matching -------------------------------------------------------------

/** The action id of a card click (`event` named `action`), if the input is one. */
export function actionIdOf(env: InboundEnvelope): string | undefined {
  for (const c of env.content) if (c.type === 'event' && c.name === 'action' && typeof c.data.actionId === 'string') return c.data.actionId;
  return undefined;
}

/**
 * Whether a message addresses this deployment (`mentions: ["self"]`): it
 * @-mentions one of our own accounts, or the adapter says so with its admission
 * hint (`dispatch`: a DM, an @ of the bot, a card click). An adapter that gives
 * no hint (mail to the deployment's mailbox, a bridge) delivers what is meant
 * for the deployment; `observe` means it is not addressed (a group message
 * without an @ of the bot, our own mail coming back).
 */
export function addressesSelf(env: InboundEnvelope, selfAccounts: ReadonlySet<string>): boolean {
  if ((env.mentions ?? []).some((m) => selfAccounts.has(`${env.channel}:${m.id}`))) return true;
  return env.admission !== 'observe';
}

/** Fixed-field match: every field the rule sets must hold. Empty lists count as unset. */
export function matches(m: BindingMatch, env: InboundEnvelope, origin: Origin, selfAccounts: ReadonlySet<string> = new Set()): boolean {
  if (origin.self && !m.includeSelf) return false;
  if (m.channel !== undefined && m.channel !== env.channel) return false;
  if (m.account !== undefined && m.account !== env.account) return false;
  if (m.conversation !== undefined && m.conversation !== env.conversation.id) return false;
  if (m.conversationKind !== undefined && m.conversationKind !== env.conversation.kind) return false;
  if (m.senders?.length && !m.senders.includes(env.sender.channelUserId)) return false;
  if (m.labels?.length && !m.labels.some((l) => origin.principal?.labels.includes(l))) return false;
  if (m.principal !== undefined && origin.principal?.id !== m.principal) return false;
  if (m.known !== undefined && (origin.principal !== null) !== m.known) return false;
  if (m.mentions?.length) {
    const ids = new Set((env.mentions ?? []).map((x) => x.id));
    if (!m.mentions.some((x) => (x === 'self' ? addressesSelf(env, selfAccounts) : ids.has(x)))) return false;
  }
  if (m.keywords?.length) {
    const text = contentText(env.content, Number.POSITIVE_INFINITY).toLowerCase();
    if (!m.keywords.some((k) => k && text.includes(k.toLowerCase()))) return false;
  }
  if (m.actionPrefix !== undefined) {
    const id = actionIdOf(env);
    if (id === undefined || !id.startsWith(m.actionPrefix)) return false;
  }
  return true;
}

/**
 * A watch as a runtime binding: its source and filters as the match, its mode
 * as the action (`trigger` → `dispatch`), its target as the session. A source
 * `conversation` naming a kind (`group`, …) matches that kind.
 */
export function watchBinding(w: Watch): Binding {
  const s = w.source;
  const f = w.filter;
  const kindName = s.conversation !== undefined && KINDS.has(s.conversation) ? s.conversation : undefined;
  const match: BindingMatch = {
    channel: s.channel,
    ...(s.account !== undefined ? { account: s.account } : {}),
    ...(s.conversation !== undefined && kindName === undefined ? { conversation: s.conversation } : {}),
    ...(s.conversationKind !== undefined || kindName !== undefined ? { conversationKind: (s.conversationKind ?? kindName) as BindingMatch['conversationKind'] } : {}),
    ...(s.senders?.length ? { senders: [...s.senders] } : {}),
    ...(f?.keywords?.length ? { keywords: [...f.keywords] } : {}),
    ...(f?.mentions?.length ? { mentions: [...f.mentions] } : {}),
    ...(f?.excludeSelf === false ? { includeSelf: true } : {}),
  };
  // A source naming a kind as its conversation and another kindName as conversationKind matches nothing (as matchesSource).
  if (kindName !== undefined && s.conversationKind !== undefined && s.conversationKind !== kindName) match.conversation = '\u0000never';
  return {
    id: `watch:${w.id}`,
    match,
    on: w.mode === 'trigger' ? 'dispatch' : w.mode,
    session: { key: w.target.sessionKey },
    ...(w.digest ? { digest: w.digest } : {}),
    ...(w.note !== undefined ? { note: w.note } : {}),
  };
}

/** Describe a rule's match as a watch source (digest text). */
export function sourceOf(m: BindingMatch | undefined): WatchSource {
  return {
    channel: m?.channel ?? '*',
    ...(m?.account !== undefined ? { account: m.account } : {}),
    ...(m?.conversation !== undefined ? { conversation: m.conversation } : {}),
    ...(m?.conversationKind !== undefined && m.conversationKind !== 'call' ? { conversationKind: m.conversationKind } : {}),
    ...(m?.senders?.length ? { senders: m.senders } : {}),
  };
}

// ---- the default table ----------------------------------------------------

export interface DefaultBindingsOptions {
  /** The agent every default rule targets. */
  agent: string;
  /** Put every owner DM into this one session instead of one per conversation. */
  ownerSessionKey?: string;
  /** Label of the owner (default `owner`). */
  label?: string;
}

/**
 * The single-owner defaults (POSITIONING §4) as rules, in place of the old
 * `defaultPolicy.admit`:
 *
 * - `default:owner-dm` — the owner's DM starts a turn in the DM's current topic (in `ownerSessionKey` when set);
 * - `default:owner-<kind>` — the owner addressing the deployment anywhere else
 *   (`mentions: ["self"]`: an @ of the bot, or an adapter that hints `dispatch` or nothing) starts a turn there;
 * - `default:observe-<kind>` — anything else outside DMs is recorded as context of that conversation's session.
 *
 * Unknown senders' DMs and our own echoes match nothing and are dropped.
 * Sessions are per thread (`channel:account:conversation[:thread]` plus the agent's prefix); the
 * owner's DM is per topic (its first topic has the DM's own key, later ones `#<topicId>`).
 */
export function defaultBindings(o: DefaultBindingsOptions): Binding[] {
  const label = o.label ?? OWNER_LABEL;
  const out: Binding[] = [
    {
      id: 'default:owner-dm',
      match: { conversationKind: 'dm', labels: [label] },
      on: 'dispatch',
      agent: o.agent,
      // One topic at a time in a flat DM (decision 6); a DM thread stays its own session.
      session: o.ownerSessionKey ? { key: o.ownerSessionKey } : 'topic',
      note: 'the owner talking to the deployment directly',
    },
  ];
  for (const kind of NON_DM_KINDS) {
    out.push({ id: `default:owner-${kind}`, match: { conversationKind: kind, labels: [label], mentions: ['self'] }, on: 'dispatch', agent: o.agent, session: 'per-thread' });
    out.push({ id: `default:observe-${kind}`, match: { conversationKind: kind }, on: 'context', agent: o.agent, session: 'per-thread' });
  }
  return out;
}

export interface OwnersTableOptions extends DefaultBindingsOptions {
  /** `${channel}:${channelUserId}` of every owner. */
  owners: string[];
  /** Evidence an owner's input must carry (default `platform_signed`, `dkim_pass`). */
  ownerEvidence?: Evidence[];
  version?: string;
}

/** The local `owners` config as a table: the smallest identity map plus the default rules. */
export function ownersTable(o: OwnersTableOptions): BindingTable {
  return {
    version: o.version ?? 'config',
    bindings: defaultBindings(o),
    identities: ownerIdentities(o.owners, o.ownerEvidence),
  };
}
