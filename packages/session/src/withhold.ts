import { routeKey, type SessionEvent } from '@agents-io/protocol';

/**
 * U20 (feature `reply.check`, docs/HOSTS.md §4.1a): what an external reader (the external MCP
 * endpoint's `session_events`, anything else that reads a session for a client other than the
 * host) must not see of a checked turn before its answer is past the exit check.
 *
 * - `checking`: the turn's checked answer has not settled yet; `held`: the host took it or its check
 *   answered `deny` (`denied`: the text stays with the host, for good). Settled `delivered`, `unknown`
 *   or `rejected` by the channel (a send failing is not the exit's decision) releases it.
 * - What is withheld: answer / reasoning / output text (`text.delta`, `text.snapshot`), the text of
 *   `reasoning` and `agent_message` items, `headline` lines, every `native` payload of the turn; a
 *   card (`request.opened`: `title`, `inputPreview`, `questions`, `suggestions`) and the tool item
 *   that opened it (its `title`, `inputSummary`, `result.preview`, progress text) until that card
 *   settles on every route the turn is checked on (a copy sent where it is not checked releases
 *   nothing; no card sent there: as the turn's answer).
 * - From the event the turn became checked at: `turn.started` / `turn.adopted` with `checked`,
 *   or a `turn.delivery_added` with `checked` (what was read before cannot be taken back).
 * - The agent's `session_rotate` (its title and summary are in its tool item's `title`, `inputSummary`),
 *   call by call: a `topic.changed` with `check` answers the rotate item of its turn running at that
 *   seq (started, not completed). An item is released only by its own `allowed`; `held` holds it for
 *   good. In a checked turn, or a turn where some rotate was asked, an item no `check` answered is
 *   `checking` while it (and its turn) runs and `held` once either ended (it failed or was refused
 *   before the host was asked). Two running at once (parallel calls): `held` holds both, `allowed`
 *   releases neither. The summary handed to the new topic (its `input.admitted`,
 *   `channelContext.topicSummary`) is withheld in that topic's log where `check` was `held`.
 *
 * The host's own subscription is never withheld: it needs the final text to check it.
 */
export type Withheld = 'checking' | 'held';

interface CheckedTurn {
  /** Seq the turn became checked at. */
  from: number;
  /** Route keys the answer is checked on (empty for an adopted turn: any route of it). */
  routes: Set<string>;
  /** Route keys whose checked answer settled other than held. */
  released: Set<string>;
  held: boolean;
  completed: boolean;
  /**
   * Its cards by request id: the tool item that opened each, and how its card settled, by route (as the
   * answer: a card sent where the turn is not checked releases nothing).
   */
  cards: Map<string, { itemId?: string; released: Set<string>; held: boolean }>;
}

export interface Withholding {
  /** Nothing in the log is checked: every event reads as it is. */
  readonly none: boolean;
  /** How `e` (an event of the same log) is withheld now, if at all. */
  of(e: SessionEvent): Withheld | undefined;
  /** `view` with what `e` withholds taken out, and `withheld` set (`view` itself when nothing is). */
  apply<V extends { body: unknown; native?: unknown }>(e: SessionEvent, view: V): V & { withheld?: Withheld };
}

const CONTENT_ITEMS = new Set(['reasoning', 'agent_message']);

/** The agent's `session_rotate` call: by `tool` (HC-7), else by its title `<server>.session_rotate[: …]`. */
const ROTATE_TITLE = /^[^\s:]+\.session_rotate(?::|$)/;
function isRotate(item: { type: string; title: string; tool?: { name: string } }): boolean {
  if (item.tool) return item.tool.name === 'session_rotate';
  return item.type === 'mcp_tool' && ROTATE_TITLE.test(item.title);
}

/** Read the whole log of a session (from seq 0) once; then ask for each event read out of it. */
export function withholding(events: readonly SessionEvent[]): Withholding {
  const turns = new Map<string, CheckedTurn>();
  const itemTypes = new Map<string, string>();
  /**
   * The turn open at each seq: what an event without a turn id belongs to (by seq, not identity: the
   * events asked about come from another read of the log; an ephemeral one has its last durable seq).
   */
  const openAt = new Map<number, string>();
  let open: string | undefined;
  /** session_rotate items by item id: their turn, whether the call ended, and the `check` that answered it. */
  const rotates = new Map<string, { turnId?: string; ended: boolean; check?: 'allowed' | 'held' }>();
  /** Turns where some session_rotate was asked (a `topic.changed` with `check`), and turns that ended. */
  const askedTurns = new Set<string>();
  const endedTurns = new Set<string>();
  /** Topics left by a rotate whose check was `held` (this log is the new topic's), and the summaries handed from them. */
  const heldFrom = new Set<string>();
  const heldSummaries = new Set<number>();
  const checked = (turnId: string, from: number): CheckedTurn => {
    let t = turns.get(turnId);
    if (!t) turns.set(turnId, (t = { from, routes: new Set(), released: new Set(), held: false, completed: false, cards: new Map() }));
    return t;
  };
  for (const e of events) {
    const b = e.body;
    if (b.t === 'turn.started' || b.t === 'turn.adopted') open = b.turnId;
    const turnId = e.turnId ?? open;
    if (open !== undefined) openAt.set(e.seq, open);
    switch (b.t) {
      case 'turn.started':
        if (b.checked === true) {
          const t = checked(b.turnId, e.seq);
          if (b.replyRoute) t.routes.add(routeKey(b.replyRoute));
        }
        break;
      case 'turn.adopted':
        // After a restart: which route made it checked is not known, so any of its answers counts.
        if (b.checked === true) checked(b.turnId, e.seq);
        break;
      case 'turn.delivery_added':
        if (b.checked === true) checked(b.turnId, e.seq).routes.add(routeKey(b.route));
        break;
      case 'turn.completed': {
        const t = turns.get(b.turnId);
        if (t) t.completed = true;
        endedTurns.add(b.turnId);
        if (open === b.turnId) open = undefined;
        break;
      }
      case 'item.started':
      case 'item.completed':
        itemTypes.set(b.item.itemId, b.item.type);
        if (isRotate(b.item)) {
          let r = rotates.get(b.item.itemId);
          if (!r) rotates.set(b.item.itemId, (r = { ...(turnId !== undefined ? { turnId } : {}), ended: false }));
          if (b.t === 'item.completed') r.ended = true;
        }
        break;
      case 'topic.changed': {
        if (b.check === 'held' && b.from !== undefined) heldFrom.add(b.from);
        if (b.check === undefined || e.turnId === undefined) break;
        askedTurns.add(e.turnId);
        // The call it answers: the rotate of this turn running now (the check is asked inside the call).
        const running = [...rotates.values()].filter((r) => r.turnId === e.turnId && !r.ended);
        if (b.check === 'held') for (const r of running) r.check = 'held';
        // Several running at once: which one was allowed is not known, so none is released.
        else if (running.length === 1 && running[0]!.check === undefined) running[0]!.check = 'allowed';
        break;
      }
      case 'input.admitted': {
        const cc = b.input?.channelContext;
        if (cc?.topicSummary === true && typeof cc.fromTopic === 'string' && heldFrom.has(cc.fromTopic)) heldSummaries.add(e.seq);
        break;
      }
      case 'request.opened': {
        const t = turnId !== undefined ? turns.get(turnId) : undefined;
        if (t && e.seq >= t.from) t.cards.set(b.requestId, { ...(e.itemId !== undefined ? { itemId: e.itemId } : {}), released: new Set(), held: false });
        break;
      }
      case 'delivery.settled': {
        const t = b.turnId !== undefined ? turns.get(b.turnId) : undefined;
        if (!t) break;
        if (b.kind === 'reply') {
          const k = routeKey(b.route);
          if (t.routes.size && !t.routes.has(k)) break;
          if (b.result === 'held' || b.denied === true) t.held = true;
          else t.released.add(k);
        } else if ((b.kind === 'question' || b.kind === 'request') && b.requestId !== undefined) {
          const c = t.cards.get(b.requestId);
          if (!c) break;
          if (b.result === 'held' || b.denied === true) c.held = true;
          else c.released.add(routeKey(b.route));
        }
        break;
      }
    }
  }
  const answer = (t: CheckedTurn): Withheld | undefined => {
    if (t.held) return 'held';
    if (!t.completed) return 'checking';
    const all = t.routes.size ? [...t.routes].every((k) => t.released.has(k)) : t.released.size > 0;
    return all ? undefined : 'checking';
  };
  const cardItems = new Map<string, { t: CheckedTurn; requestId: string }>();
  for (const t of turns.values()) for (const [requestId, c] of t.cards) if (c.itemId !== undefined) cardItems.set(c.itemId, { t, requestId });
  /**
   * A card: held anywhere = held; released once it settled (not held) on every route the turn is checked
   * on (an adopted turn: any). Sent to none of them yet: as the turn's answer.
   */
  const card = (t: CheckedTurn, requestId: string): Withheld | undefined => {
    const c = t.cards.get(requestId);
    if (!c) return answer(t);
    if (c.held) return 'held';
    const on = t.routes.size ? [...t.routes].filter((k) => c.released.has(k)).length : c.released.size;
    if (t.routes.size ? on === t.routes.size : on > 0) return undefined;
    return on > 0 ? 'checking' : answer(t);
  };
  const itemIdOf = (e: SessionEvent): string | undefined => {
    const b = e.body;
    if (b.t === 'item.started' || b.t === 'item.completed') return b.item.itemId;
    if (b.t === 'item.progress') return b.itemId;
    return undefined;
  };
  /** A session_rotate item: withheld for itself (`undefined`: as any tool item of its turn). */
  const rotate = (itemId: string, seq: number): Withheld | undefined => {
    const r = rotates.get(itemId);
    if (!r) return undefined;
    if (r.check !== undefined) return r.check === 'held' ? 'held' : undefined;
    // Not answered by a check of its own: held where the turn is checked or another rotate of it was asked.
    const t = r.turnId !== undefined ? turns.get(r.turnId) : undefined;
    const asked = r.turnId !== undefined && askedTurns.has(r.turnId);
    if (!asked && (!t || seq < t.from)) return undefined;
    return r.ended || (r.turnId !== undefined && endedTurns.has(r.turnId)) ? 'held' : 'checking';
  };
  const rotateOf = (e: SessionEvent): Withheld | undefined => {
    const item = itemIdOf(e);
    return item !== undefined && rotates.has(item) ? rotate(item, e.seq) : undefined;
  };
  const none = turns.size === 0 && heldSummaries.size === 0 && [...rotates.keys()].every((id) => rotate(id, Infinity) === undefined);
  const of = (e: SessionEvent): Withheld | undefined => {
    if (heldSummaries.has(e.seq) && e.body.t === 'input.admitted') return 'held';
    const r = rotateOf(e);
    if (r !== undefined) return r;
    const turnId = e.turnId ?? openAt.get(e.seq);
    const t = turnId !== undefined ? turns.get(turnId) : undefined;
    if (!t || e.seq < t.from) return undefined;
    const b = e.body;
    if (b.t === 'request.opened' && t.cards.has(b.requestId)) return card(t, b.requestId);
    const item = itemIdOf(e);
    const opened = item !== undefined ? cardItems.get(item) : undefined;
    if (opened) return card(opened.t, opened.requestId);
    return answer(t);
  };
  return {
    none,
    of,
    apply<V extends { body: unknown; native?: unknown }>(e: SessionEvent, view: V): V & { withheld?: Withheld } {
      const w = none ? undefined : of(e);
      if (w === undefined) return view;
      const { native: _native, ...rest } = view;
      const b = e.body;
      const item = itemIdOf(e);
      const content = item !== undefined && (cardItems.has(item) || CONTENT_ITEMS.has(itemTypes.get(item) ?? '') || rotateOf(e) !== undefined);
      const body = view.body as Record<string, unknown>;
      let out: Record<string, unknown> | undefined;
      switch (b.t) {
        case 'text.delta':
          out = { ...body, delta: '' };
          break;
        case 'text.snapshot':
        case 'headline':
          out = { ...body, text: '' };
          break;
        case 'item.started':
        case 'item.completed':
          if (content) {
            const { inputSummary: _i, result, ...it } = body.item as Record<string, unknown> & { result?: Record<string, unknown> };
            out = { ...body, item: { ...it, title: '', ...(result ? { result: { ...result, preview: '' } } : {}) } };
          }
          break;
        case 'item.progress':
          if (content && body.text !== undefined) {
            const { text: _t, ...p } = body;
            out = p;
          }
          break;
        case 'request.opened': {
          const { inputPreview: _p, questions: _q, suggestions: _s, ...r } = body;
          out = { ...r, title: '' };
          break;
        }
        case 'input.admitted':
          if (heldSummaries.has(e.seq)) {
            const input = body.input as Record<string, unknown> & { content: { type: string; text?: string }[] };
            out = { ...body, input: { ...input, content: input.content.map((c) => (c.type === 'text' ? { ...c, text: '' } : c)) } };
          }
          break;
      }
      if (!out && view.native === undefined) return view;
      return { ...rest, body: out ?? view.body, withheld: w } as V & { withheld?: Withheld };
    },
  };
}
