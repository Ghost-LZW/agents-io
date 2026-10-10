import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { InboundEnvelope, InputCause, InputVerifyResult, LoopGuardTrip, Origin, ReplyRoute, SessionLaunch, TurnProvenance, VerifiedInput } from '@agents-io/protocol';
import { channelRefOf, type DeliveryRecord, type InFlightDelivery, type OutboxStore } from '@agents-io/session';

/*
 * Daemon-side records next to the session log (same SQLite file when the log is
 * SQLite): who sent each channel message as the channel reported it (for
 * `input.verify`), settled and in-flight deliveries (outbox idempotency across
 * restarts; an in-flight row is written before the adapter is called),
 * which agent each session belongs to, and how a session is launched (decision 7:
 * its cwd and env, kept in this 0600 database like the transcripts).
 */

const DAY = 86_400_000;

/**
 * One settled delivery (`daemon_outbound`): which session and turn made it, and — for a
 * message a turn delivered with a platform id — the outbound index that recognises the
 * message when a channel brings it back (agent-messaging §4.3.3), and `explain` of a
 * side effect by its operationId (INVARIANTS EX-2).
 */
export interface OutboundRecord {
  operationId: string;
  channel: string;
  providerMessageId?: string;
  sessionKey: string;
  turnId?: string;
  /** The agent of the session (when it has one). */
  agent?: string;
  route: ReplyRoute;
  result: 'delivered' | 'rejected' | 'unknown';
  /** A delivery no turn made that answers inputs (a system reply): which. */
  inputIds?: string[];
  /** The turn's provenance when it settled: its chain and flags, carried into a recovered input's cause. */
  provenance?: Pick<TurnProvenance, 'external' | 'watched' | 'group' | 'cause'>;
  at: number;
}

/** One agent-originated input as admitted (`daemon_causes`): where it went and its chain (`explain --chain`). */
export interface CauseRecord {
  inputId: string;
  sessionKey: string;
  principal: string | null;
  cause: InputCause;
  loopGuard?: LoopGuardTrip;
  at: number;
}

/** What `input.verify` answers for one channel message (protocol `VerifiedInput`). Never a guess. */
export type { VerifiedInput };

/** `input.verify` answer (protocol `InputVerifyResult`). */
export type VerifyResult = InputVerifyResult;

export class DaemonRecords implements OutboxStore {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private q: Record<
    | 'inPut' | 'inGet' | 'inPrune' | 'outGet' | 'outPut' | 'outPrune' | 'flyPut' | 'flyGet' | 'flyAll' | 'flyDel' | 'agentGet' | 'agentPut' | 'launchGet' | 'launchPut' | 'launchKeys'
    | 'obPut' | 'obByOp' | 'obByMsg' | 'obPrune' | 'causePut' | 'causeGet' | 'causePrune',
    StatementSync
  >;
  /** Tests: called between the agent row and the launch row of `pin` (a throw rolls both back). */
  betweenPinWrites?: () => void;

  constructor(o: { db?: DatabaseSync; path?: string; retainMs?: number; causeRetainMs?: number } = {}) {
    this.ownsDb = !o.db;
    this.db = o.db ?? new DatabaseSync(o.path ?? ':memory:');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_inputs (account TEXT NOT NULL, channel_ref TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (account, channel_ref)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS daemon_inputs_ref ON daemon_inputs (channel_ref);
      CREATE TABLE IF NOT EXISTS daemon_outbox (operation_id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS daemon_outbox_inflight (operation_id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS daemon_session_agents (session_key TEXT PRIMARY KEY, agent TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS daemon_session_launch (session_key TEXT PRIMARY KEY, cwd TEXT, env_json TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS daemon_outbound (operation_id TEXT PRIMARY KEY, channel TEXT NOT NULL, provider_message_id TEXT, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS daemon_outbound_msg ON daemon_outbound (channel, provider_message_id);
      CREATE TABLE IF NOT EXISTS daemon_causes (input_id TEXT PRIMARY KEY, chain TEXT, hop INTEGER, session_key TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
    `);
    const p = (sql: string) => this.db.prepare(sql);
    this.q = {
      // First copy wins: a redelivered message keeps the record of its first arrival.
      inPut: p('INSERT INTO daemon_inputs (account, channel_ref, at, json) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'),
      inGet: p('SELECT json FROM daemon_inputs WHERE channel_ref = ? ORDER BY account'),
      inPrune: p('DELETE FROM daemon_inputs WHERE at < ?'),
      outGet: p('SELECT json FROM daemon_outbox WHERE operation_id = ?'),
      outPut: p('INSERT INTO daemon_outbox (operation_id, at, json) VALUES (?, ?, ?) ON CONFLICT(operation_id) DO UPDATE SET json = excluded.json'),
      outPrune: p('DELETE FROM daemon_outbox WHERE at < ?'),
      // In-flight marks are never pruned: the next start settles each one (as unknown).
      flyPut: p('INSERT INTO daemon_outbox_inflight (operation_id, at, json) VALUES (?, ?, ?) ON CONFLICT(operation_id) DO UPDATE SET at = excluded.at, json = excluded.json'),
      flyGet: p('SELECT json FROM daemon_outbox_inflight WHERE operation_id = ? AND operation_id NOT IN (SELECT operation_id FROM daemon_outbox)'),
      flyAll: p('SELECT json FROM daemon_outbox_inflight WHERE operation_id NOT IN (SELECT operation_id FROM daemon_outbox) ORDER BY at'),
      flyDel: p('DELETE FROM daemon_outbox_inflight WHERE operation_id = ?'),
      agentGet: p('SELECT agent FROM daemon_session_agents WHERE session_key = ?'),
      agentPut: p('INSERT INTO daemon_session_agents (session_key, agent) VALUES (?, ?) ON CONFLICT DO NOTHING'),
      launchGet: p('SELECT cwd, env_json FROM daemon_session_launch WHERE session_key = ?'),
      launchKeys: p('SELECT session_key FROM daemon_session_launch'),
      launchPut: p('INSERT INTO daemon_session_launch (session_key, cwd, env_json, at) VALUES (?, ?, ?, ?)'),
      obPut: p('INSERT INTO daemon_outbound (operation_id, channel, provider_message_id, at, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(operation_id) DO UPDATE SET channel = excluded.channel, provider_message_id = excluded.provider_message_id, at = excluded.at, json = excluded.json'),
      obByOp: p('SELECT json FROM daemon_outbound WHERE operation_id = ?'),
      // Only messages a turn delivered name a turn; the newest wins if a platform id was ever reused.
      obByMsg: p('SELECT json FROM daemon_outbound WHERE channel = ? AND provider_message_id = ? ORDER BY at DESC LIMIT 1'),
      obPrune: p('DELETE FROM daemon_outbound WHERE at < ?'),
      causePut: p('INSERT INTO daemon_causes (input_id, chain, hop, session_key, at, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(input_id) DO UPDATE SET chain = excluded.chain, hop = excluded.hop, session_key = excluded.session_key, json = excluded.json'),
      causeGet: p('SELECT json FROM daemon_causes WHERE input_id = ?'),
      causePrune: p('DELETE FROM daemon_causes WHERE at < ?'),
    };
    const retain = o.retainMs ?? 30 * DAY;
    this.q.inPrune.run(Date.now() - retain);
    this.q.outPrune.run(Date.now() - retain);
    // The outbound index lives as long as the outbox records; causes as long as routing explanations (7 days).
    this.q.obPrune.run(Date.now() - retain);
    this.q.causePrune.run(Date.now() - (o.causeRetainMs ?? 7 * DAY));
  }

  // ---- outbound index and causes (agent-messaging §4.3) -------------------

  putOutbound(r: OutboundRecord): void {
    // Only a delivered message a turn made is a key the index answers by.
    const msg = r.result === 'delivered' && r.turnId !== undefined && r.providerMessageId !== undefined ? r.providerMessageId : null;
    this.q.obPut.run(r.operationId, r.channel, msg, r.at, JSON.stringify(r));
  }

  /** The delivery an operationId names, if it settled. */
  outboundByOperation(operationId: string): OutboundRecord | undefined {
    const r = this.q.obByOp.get(operationId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as OutboundRecord) : undefined;
  }

  /** The turn that delivered platform message `id` on `channel` (any account of it), if this daemon did. */
  outboundByMessage(channel: string, providerMessageId: string): OutboundRecord | undefined {
    const r = this.q.obByMsg.get(channel, providerMessageId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as OutboundRecord) : undefined;
  }

  putCause(r: CauseRecord): void {
    this.q.causePut.run(r.inputId, r.cause.chain ?? null, r.cause.hop ?? null, r.sessionKey, r.at, JSON.stringify(r));
  }

  causeOf(inputId: string): CauseRecord | undefined {
    const r = this.q.causeGet.get(inputId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as CauseRecord) : undefined;
  }

  /** Record who sent an accepted envelope (no content, no raw payload). */
  recordInput(env: InboundEnvelope, origin: Origin, inputId: string | undefined, at = Date.now()): void {
    const channelRef = channelRefOf(env);
    const rec: VerifiedInput = {
      channelRef,
      channel: env.channel,
      account: env.account,
      conversation: { id: env.conversation.id, kind: env.conversation.kind, ...(env.conversation.threadId !== undefined ? { threadId: env.conversation.threadId } : {}) },
      author: {
        channelUserId: env.sender.channelUserId,
        ...(env.sender.displayName !== undefined ? { displayName: env.sender.displayName } : {}),
        ...(env.sender.isBot !== undefined ? { isBot: env.sender.isBot } : {}),
      },
      evidence: env.sender.evidence,
      principal: origin.principal?.id ?? null,
      labels: origin.principal ? [...origin.principal.labels] : [],
      kind: origin.kind,
      ...(origin.self ? { self: true } : {}),
      ...(inputId !== undefined ? { inputId } : {}),
      receivedAt: at,
      ...(env.sentAt !== undefined ? { sentAt: env.sentAt } : {}),
    };
    this.q.inPut.run(env.account, channelRef, at, JSON.stringify(rec));
  }

  verify(channelRef: string): VerifyResult {
    const records = (this.q.inGet.all(channelRef) as { json: string }[]).map((r) => JSON.parse(r.json) as VerifiedInput);
    return { channelRef, found: records.length > 0, records };
  }

  // ---- OutboxStore --------------------------------------------------------

  get(operationId: string): DeliveryRecord | undefined {
    const r = this.q.outGet.get(operationId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as DeliveryRecord) : undefined;
  }

  /** The outcome and the end of the in-flight mark in one savepoint (also inside another transaction). */
  put(rec: DeliveryRecord): void {
    this.db.exec('SAVEPOINT outbox_settle');
    try {
      this.q.outPut.run(rec.operationId, Date.now(), JSON.stringify(rec));
      this.q.flyDel.run(rec.operationId);
      this.db.exec('RELEASE outbox_settle');
    } catch (e) {
      this.db.exec('ROLLBACK TO outbox_settle');
      this.db.exec('RELEASE outbox_settle');
      throw e;
    }
  }

  begin(rec: InFlightDelivery): void {
    this.q.flyPut.run(rec.operationId, rec.startedAt, JSON.stringify(rec));
  }

  inFlight(operationId: string): InFlightDelivery | undefined {
    const r = this.q.flyGet.get(operationId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as InFlightDelivery) : undefined;
  }

  allInFlight(): InFlightDelivery[] {
    return (this.q.flyAll.all() as { json: string }[]).map((r) => JSON.parse(r.json) as InFlightDelivery);
  }

  // ---- session → agent ----------------------------------------------------

  agentOf(sessionKey: string): string | undefined {
    return (this.q.agentGet.get(sessionKey) as { agent: string } | undefined)?.agent;
  }

  /** The first agent recorded for a session stays its agent. */
  setAgent(sessionKey: string, agent: string): void {
    this.q.agentPut.run(sessionKey, agent);
  }

  // ---- session launch (decision 7) ---------------------------------------

  /** The launch pinned to a session, if any. */
  launchOf(sessionKey: string): SessionLaunch | undefined {
    const r = this.q.launchGet.get(sessionKey) as { cwd: string | null; env_json: string } | undefined;
    if (!r) return undefined;
    const env = JSON.parse(r.env_json) as Record<string, string>;
    return { ...(r.cwd !== null ? { cwd: r.cwd } : {}), ...(Object.keys(env).length ? { env } : {}) };
  }

  /** Sessions with a pinned launch (prepared ones too, before any input opened them). */
  launchedSessions(): string[] {
    return (this.q.launchKeys.all() as { session_key: string }[]).map((r) => r.session_key);
  }

  /**
   * Pin a session's agent and launch in one transaction: never an agent row
   * without its launch (a crash in between would leave a launch-less session).
   * Fails if the session already has a launch.
   */
  pin(sessionKey: string, agent: string, launch: SessionLaunch): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.q.agentPut.run(sessionKey, agent);
      this.betweenPinWrites?.();
      this.q.launchPut.run(sessionKey, launch.cwd ?? null, JSON.stringify(launch.env ?? {}), Date.now());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}
