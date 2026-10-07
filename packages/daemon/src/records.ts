import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { InboundEnvelope, InputVerifyResult, Origin, VerifiedInput } from '@agents-io/protocol';
import { channelRefOf, type DeliveryRecord, type OutboxStore } from '@agents-io/session';

/*
 * Daemon-side records next to the session log (same SQLite file when the log is
 * SQLite): who sent each channel message as the channel reported it (for
 * `input.verify`), settled deliveries (outbox idempotency across restarts), and
 * which agent each session belongs to.
 */

const DAY = 86_400_000;

/** What `input.verify` answers for one channel message (protocol `VerifiedInput`). Never a guess. */
export type { VerifiedInput };

/** `input.verify` answer (protocol `InputVerifyResult`). */
export type VerifyResult = InputVerifyResult;

export class DaemonRecords implements OutboxStore {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private q: Record<'inPut' | 'inGet' | 'inPrune' | 'outGet' | 'outPut' | 'outPrune' | 'agentGet' | 'agentPut', StatementSync>;

  constructor(o: { db?: DatabaseSync; path?: string; retainMs?: number } = {}) {
    this.ownsDb = !o.db;
    this.db = o.db ?? new DatabaseSync(o.path ?? ':memory:');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_inputs (account TEXT NOT NULL, channel_ref TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (account, channel_ref)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS daemon_inputs_ref ON daemon_inputs (channel_ref);
      CREATE TABLE IF NOT EXISTS daemon_outbox (operation_id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS daemon_session_agents (session_key TEXT PRIMARY KEY, agent TEXT NOT NULL) WITHOUT ROWID;
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
      agentGet: p('SELECT agent FROM daemon_session_agents WHERE session_key = ?'),
      agentPut: p('INSERT INTO daemon_session_agents (session_key, agent) VALUES (?, ?) ON CONFLICT DO NOTHING'),
    };
    const retain = o.retainMs ?? 30 * DAY;
    this.q.inPrune.run(Date.now() - retain);
    this.q.outPrune.run(Date.now() - retain);
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

  put(rec: DeliveryRecord): void {
    this.q.outPut.run(rec.operationId, Date.now(), JSON.stringify(rec));
  }

  // ---- session → agent ----------------------------------------------------

  agentOf(sessionKey: string): string | undefined {
    return (this.q.agentGet.get(sessionKey) as { agent: string } | undefined)?.agent;
  }

  /** The first agent recorded for a session stays its agent. */
  setAgent(sessionKey: string, agent: string): void {
    this.q.agentPut.run(sessionKey, agent);
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}
