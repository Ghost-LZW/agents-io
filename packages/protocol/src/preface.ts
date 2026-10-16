import type { InputRecord } from './inbound.js';

/*
 * The channelContext part of a harness's sender preface (INVARIANTS ID-2). Keys
 * that stay the same across a conversation (how replies render, the topic and its
 * hint) or a sender (display name) are shown when they change, not on every
 * input; keys `via` already names (`channel`, `conversationId`) are not repeated.
 * The sender fields themselves (from, kind, evidence, via, ref…) are not here:
 * every input carries them.
 */

/** Keys shown once per conversation (`origin.via`) until their value changes. */
const PER_CONVERSATION = new Set(['conversationKind', 'reply', 'topic', 'topicTitle', 'topicTools']);
/** Keys shown once per sender until their value changes. */
const PER_SENDER = new Set(['senderName', 'senderIsBot']);

/**
 * What a harness session already showed the model. Reset it whenever the model
 * may no longer have what was shown: the context was compacted, or a rendered
 * input was withdrawn before the model read it.
 */
export class PrefaceMemo {
  private shown = new Map<string, string>();

  /** The next input shows every key again. */
  reset(): void {
    this.shown.clear();
  }

  /** Whether `value` is new for `scope` and `key`; records it as shown. */
  fresh(scope: string, key: string, value: string): boolean {
    const k = `${scope}\0${key}`;
    if (this.shown.get(k) === value) return false;
    this.shown.set(k, value);
    return true;
  }
}

/** The channelContext entries the preface shows, values as JSON. Without a memo, every key but the ones `via` names. */
export function prefaceContext(input: InputRecord, memo?: PrefaceMemo, value: (v: unknown) => string = json): [string, string][] {
  // `via` is a route key `channel:account:conversation[:thread]` for a channel message.
  const via = input.origin.via;
  const [channel, , ...rest] = via.split(':');
  const conversation = rest.join(':');
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(input.channelContext)) {
    if (k === 'channel' && v === channel) continue;
    if (k === 'conversationId' && typeof v === 'string' && v && (conversation === v || conversation.startsWith(`${v}:`))) continue;
    const s = value(v);
    if (memo && PER_CONVERSATION.has(k) && !memo.fresh(`via:${via}`, k, s)) continue;
    if (memo && PER_SENDER.has(k) && !memo.fresh(`from:${input.origin.principal?.id ?? via}`, k, s)) continue;
    out.push([k, s]);
  }
  return out;
}

const json = (v: unknown): string => JSON.stringify(v) ?? 'null';
