import type { BodyType, Level, SessionEvent, Tier } from '@agents-io/protocol';
import type { Visibility } from './log.js';

export interface TierFilter {
  minLevel?: Level;
  /** Body types to leave out. Never removes events a human must answer. */
  optOut?: string[];
}

const LEVEL_RANK: Record<Level, number> = { primary: 0, detail: 1, debug: 2 };

/** RECOMMENDATION §2.6. `full` gets everything; the others a fixed whitelist. */
const CARD: ReadonlySet<BodyType> = new Set<BodyType>([
  'session.state',
  'input.admitted',
  'input.consumed',
  'input.cancelled',
  'input.rejected',
  'turn.started',
  'turn.delivery_added',
  'turn.completed',
  'text.snapshot',
  'item.started',
  'item.completed',
  'plan.updated',
  'headline',
  'notice',
  'delivery.settled',
  'render.anchor',
]);
const HEADLINE: ReadonlySet<BodyType> = new Set<BodyType>(['session.state', 'turn.started', 'turn.completed', 'headline']);
const FINAL: ReadonlySet<BodyType> = new Set<BodyType>(['turn.started', 'turn.completed', 'text.snapshot']);

/**
 * Events a human must see on any tier: approvals routed to people. The lane marks
 * them with `audience: 'approval'`; a `request.opened` carrying a human resolver
 * counts even if a producer forgot the audience.
 */
export function mustDeliver(e: SessionEvent): boolean {
  if (e.audience === 'approval') return true;
  return e.body.t === 'request.opened' && e.body.resolver?.kind === 'human';
}

export function defaultVisibility(tier: Tier): Visibility[] {
  return tier === 'full' ? ['participants', 'operators'] : ['participants'];
}

/** Whether `e` reaches a subscriber at `tier`. Approvals routed to humans always do. */
export function passes(e: SessionEvent, tier: Tier, filter: TierFilter = {}, visibility = defaultVisibility(tier)): boolean {
  if (mustDeliver(e)) return e.visibility !== 'internal' || visibility.includes('internal');
  if (!visibility.includes(e.visibility)) return false;
  if (filter.minLevel && LEVEL_RANK[e.level] > LEVEL_RANK[filter.minLevel]) return false;
  if (filter.optOut?.includes(e.body.t)) return false;
  const b = e.body;
  switch (tier) {
    case 'full':
      return true;
    case 'card':
      if (!CARD.has(b.t)) return false;
      if (b.t === 'text.snapshot') return e.audience === 'answer' || e.audience === 'commentary';
      return true;
    case 'headline':
      return HEADLINE.has(b.t);
    case 'final':
      if (!FINAL.has(b.t)) return false;
      if (b.t === 'text.snapshot') return b.final && e.audience === 'answer';
      return true;
  }
}

/** Strip what a tier does not render: `native` outside `full`, item details on card. */
export function project(e: SessionEvent, tier: Tier): SessionEvent {
  if (tier === 'full') return e;
  const { native: _native, ...rest } = e;
  const b = rest.body;
  if ((b.t === 'item.started' || b.t === 'item.completed') && (b.item.inputSummary !== undefined || b.item.result !== undefined)) {
    const { inputSummary: _i, result: _r, ...item } = b.item;
    return { ...rest, body: { ...b, item } };
  }
  return rest;
}
