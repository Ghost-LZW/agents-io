import type { ClientCommand, ClientFrame, TopicSwitchFrame } from '@agents-io/protocol';
import type { Hub } from '@agents-io/session';
import type { Outcome } from './gateway.js';

/*
 * Client op receipts (feature `client.opId`, INVARIANTS PR-3). A client frame whose retry would act
 * twice (an input or interrupt command, `topic.switch`, `watch.add`) may carry `opId`: the client's
 * id for that one command, unique per principal (a UUID). The first time, the command acts and what
 * it answered is kept in `client_ops` (`DaemonRecords`) in the same transaction as the event that
 * decided it (`Hub.batch`): an input's admission or rejection, an interrupt's `input.cancelled`, a
 * topic change, the stored watch; alone when it wrote none (a refusal, a duplicate). The same
 * (principal, opId) again, also after a restart, gets that answer back verbatim with
 * `replayed: true` and acts on nothing; one naming another frame type or session is refused
 * (`op_id_conflict`). Rejections are kept too: the client knows the command did not act and
 * sends a new one. Receipts are never deleted, not with the log either (like the outbox's settled
 * rows, DL-2).
 *
 * An interrupt without `turnId` resolves its turn the first time and keeps it (`pending`) before it
 * acts, so a retry after a crash in between acts on that turn (or on none), never on the next one.
 *
 * A receipt that cannot be written rolls back the event it was kept with (the command did not act
 * then), and the command fails (`internal`); a steered input is the one exception: the harness has
 * it already, so the lane admits it all the same (`Lane.trySteer`) and only the answer is lost.
 */

/** What the receipt names: the command type for a `command` frame, else the frame type. */
export type OpFrameType = 'input' | 'interrupt' | 'topic.switch' | 'watch.add';

/** A client frame whose `opId` the daemon honours; on any other frame or command it is an unknown field. */
export type OpFrame = (
  | (Extract<ClientFrame, { type: 'command' }> & { command: Extract<ClientCommand, { type: 'input' | 'interrupt' }> })
  | Extract<ClientFrame, { type: 'watch.add' }>
  | TopicSwitchFrame
) & { opId: string };

export interface OpKey {
  /** The connection's principal (`origin.principal.id`): the local owner, `host:<name>`. */
  principal: string;
  opId: string;
  frameType: OpFrameType;
  /** The session the frame names (a watch's target), or a `topic.switch`'s conversation. */
  sessionKey: string;
}

/** One row of `client_ops`. */
export interface OpReceipt extends OpKey {
  /** `pending`: an interrupt's turn kept before it acts (`turnId`); `ok` / `rejected`: answered (`result`). */
  status: 'pending' | 'ok' | 'rejected';
  result?: Outcome;
  /** The event written with the receipt: in `sessionKey`, or in the now-current topic's session (`topic.switch`). */
  seq?: number;
  /** `pending`: the turn the interrupt resolved (null: none ran). */
  turnId?: string | null;
  at: number;
}

/** An answer to a frame with `opId`. */
export type OpOutcome = Outcome & { seq?: number; replayed?: true };

export interface OpStore {
  getOp(principal: string, opId: string): OpReceipt | undefined;
  /** Insert or replace (a `pending` row by its answer). */
  putOp(r: OpReceipt): void;
}

/** Answers that decide nothing (the daemon is stopping): not kept, so a retry acts. */
const UNDECIDED = new Set(['stopped']);

/** The op of one frame while it acts: how its answer is kept. */
export class Op {
  /** An earlier attempt kept a `pending` interrupt and never answered: the turn it resolved (null: none ran). */
  readonly pinned: string | null | undefined;
  /** `settle` ran (in a transaction that may still roll back: the store says whether it holds). */
  wrote = false;

  constructor(
    private readonly o: ClientOpsOptions,
    readonly key: OpKey,
    prior: OpReceipt | undefined,
  ) {
    this.pinned = prior?.status === 'pending' ? (prior.turnId ?? null) : undefined;
  }

  /** An interrupt's turn, kept (`pending`) before it acts. */
  pin(turnId: string | null): void {
    this.o.store.putOp({ ...this.key, status: 'pending', turnId, at: this.now() });
  }

  /** Keep the answer: inside the transaction of the event that decided it (`seq`), or on its own. */
  settle(outcome: Outcome, seq?: number): void {
    this.o.store.putOp({ ...this.key, status: outcome.ok ? 'ok' : 'rejected', result: outcome, ...(seq !== undefined ? { seq } : {}), at: this.now() });
    this.wrote = true;
  }

  /** `fn`'s writes and the answer to what it returned commit together (`Hub.batch`). */
  commit<T>(fn: () => T, answer: (v: T) => { outcome: Outcome; seq?: number }): T {
    return this.o.hub.batch(() => {
      const v = fn();
      const a = answer(v);
      this.settle(a.outcome, a.seq);
      return v;
    });
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
}

export interface ClientOpsOptions {
  store: OpStore;
  hub: Pick<Hub, 'batch'>;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Runs each op frame once per (principal, opId) and answers its retries (INVARIANTS PR-3). */
export class ClientOps {
  /** Ops acting in this process: a retry meanwhile waits for the first one's answer. */
  private readonly flying = new Map<string, { key: OpKey; done: Promise<OpOutcome> }>();

  constructor(private readonly o: ClientOpsOptions) {}

  async run(key: OpKey, act: (op: Op) => Promise<Outcome>): Promise<OpOutcome> {
    const id = `${key.principal}\u0000${key.opId}`;
    for (;;) {
      const fly = this.flying.get(id);
      if (fly) {
        if (!sameTarget(fly.key, key)) return conflict(key, fly.key);
        // Its answer, once kept, is this one's too; if it kept none (it threw), this one acts.
        await fly.done.catch(() => undefined);
        continue;
      }
      const kept = this.o.store.getOp(key.principal, key.opId);
      if (kept && !sameTarget(kept, key)) return conflict(key, kept);
      if (kept && kept.status !== 'pending') return { ...answerOf(kept), replayed: true };
      const op = new Op(this.o, key, kept);
      const done = this.act(op, act);
      this.flying.set(id, { key, done });
      try {
        return await done;
      } finally {
        this.flying.delete(id);
      }
    }
  }

  private async act(op: Op, act: (op: Op) => Promise<Outcome>): Promise<OpOutcome> {
    let outcome: Outcome;
    try {
      outcome = await act(op);
    } catch (e) {
      // Kept with the event that decided it before the command failed further on: that is its answer.
      const kept = this.kept(op);
      if (!kept) throw e;
      this.o.log?.(`${op.key.frameType} ${op.key.sessionKey} (op ${op.key.opId}) failed after its answer was kept: ${(e as Error).message}`);
      return answerOf(kept);
    }
    const kept = this.kept(op);
    if (kept) return answerOf(kept);
    if (!outcome.ok && UNDECIDED.has(outcome.code)) return outcome;
    op.settle(outcome);
    return outcome;
  }

  /** The answer the store holds for `op`, once written and committed (a rolled-back write left none). */
  private kept(op: Op): OpReceipt | undefined {
    if (!op.wrote) return undefined;
    const r = this.o.store.getOp(op.key.principal, op.key.opId);
    return r && r.status !== 'pending' ? r : undefined;
  }
}

function sameTarget(a: OpKey, b: OpKey): boolean {
  return a.frameType === b.frameType && a.sessionKey === b.sessionKey;
}

function conflict(key: OpKey, kept: OpKey): OpOutcome {
  return { ok: false, code: 'op_id_conflict', message: `op id ${key.opId} is ${kept.frameType} on ${kept.sessionKey}, not ${key.frameType} on ${key.sessionKey}; use a new op id for another command` };
}

function answerOf(r: OpReceipt): OpOutcome {
  return { ...r.result!, ...(r.seq !== undefined ? { seq: r.seq } : {}) };
}
