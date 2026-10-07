import type { Watch, WatchDraft } from '@agents-io/protocol';
import { ConfigError } from './config.js';

/*
 * `key=value` watch specs shared by `aio-dev watch add` and the attach `/watch add`:
 *
 *   channel=lark-bot conversation=oc_123 mode=digest every=30m [max=20]
 *   [account=…] [kind=group] [senders=a,b] [keywords=x,y] [mentions=u1] [self=true]
 *   [expires=2h] [id=…] [note=…] [session=<target>]
 *
 * `note` takes the rest of the line (it may contain spaces). `session` overrides
 * the target (default: the attached / --session session).
 */

export const WATCH_SPEC_HELP =
  'channel=<ch> [account=] [conversation=<id|kind>] [kind=dm|group|thread|meeting|mail|other] [senders=a,b] [keywords=a,b] [mentions=u1,u2] [self=true] mode=context|trigger|digest [every=30m] [max=N] [expires=2h] [id=] [session=] [note=… (rest of line)]';

const KINDS = ['dm', 'group', 'thread', 'meeting', 'mail', 'other'] as const;
const MODES = ['context', 'trigger', 'digest'] as const;

/** A usage error (exit code 2 in the CLI). */
export class WatchSpecError extends ConfigError {
  override name = 'WatchSpecError';
}

/** `90s`, `10m`, `2h`, `1d`, or plain milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new WatchSpecError(`bad duration ${JSON.stringify(s)} (use 90s, 10m, 2h, 1d or ms)`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? 'ms']!;
  return Math.round(n * unit);
}

const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

export function parseWatchSpec(tokens: string[], target: string, now = Date.now()): WatchDraft {
  const kv = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const eq = t.indexOf('=');
    if (eq <= 0) throw new WatchSpecError(`expected key=value, got ${JSON.stringify(t)}`);
    const k = t.slice(0, eq);
    if (k === 'note') {
      kv.set(k, [t.slice(eq + 1), ...tokens.slice(i + 1)].join(' ').trim());
      break;
    }
    kv.set(k, t.slice(eq + 1));
  }
  const known = new Set(['channel', 'account', 'conversation', 'kind', 'senders', 'keywords', 'mentions', 'self', 'mode', 'every', 'max', 'expires', 'id', 'note', 'session']);
  for (const k of kv.keys()) if (!known.has(k)) throw new WatchSpecError(`unknown watch key ${JSON.stringify(k)}`);
  const channel = kv.get('channel');
  if (!channel) throw new WatchSpecError('watch needs channel=<channel>');
  const mode = (kv.get('mode') ?? (kv.has('every') ? 'digest' : 'context')) as WatchDraft['mode'];
  if (!MODES.includes(mode)) throw new WatchSpecError(`mode must be ${MODES.join(', ')}`);
  const kind = kv.get('kind');
  if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) throw new WatchSpecError(`kind must be ${KINDS.join(', ')}`);
  const self = kv.get('self');
  if (self !== undefined && self !== 'true' && self !== 'false') throw new WatchSpecError('self must be true or false');
  const filter: NonNullable<WatchDraft['filter']> = {
    ...(kv.get('keywords') ? { keywords: list(kv.get('keywords')!) } : {}),
    ...(kv.get('mentions') ? { mentions: list(kv.get('mentions')!) } : {}),
    ...(self !== undefined ? { excludeSelf: self !== 'true' } : {}),
  };
  let digest: WatchDraft['digest'];
  if (mode === 'digest') {
    const max = kv.get('max');
    if (max !== undefined && !/^\d+$/.test(max)) throw new WatchSpecError('max must be a whole number');
    digest = { everyMs: parseDuration(kv.get('every') ?? '1h'), ...(max !== undefined ? { maxItems: Number(max) } : {}) };
  } else if (kv.has('every') || kv.has('max')) throw new WatchSpecError('every/max only apply to mode=digest');
  return {
    ...(kv.get('id') ? { id: kv.get('id')! } : {}),
    source: {
      channel,
      ...(kv.get('account') ? { account: kv.get('account')! } : {}),
      ...(kv.get('conversation') ? { conversation: kv.get('conversation')! } : {}),
      ...(kind ? { conversationKind: kind as (typeof KINDS)[number] } : {}),
      ...(kv.get('senders') ? { senders: list(kv.get('senders')!) } : {}),
    },
    ...(Object.keys(filter).length ? { filter } : {}),
    target: { sessionKey: kv.get('session') || target },
    mode,
    ...(digest ? { digest } : {}),
    ...(kv.get('expires') ? { expiresAt: now + parseDuration(kv.get('expires')!) } : {}),
    ...(kv.get('note') ? { note: kv.get('note')! } : {}),
  };
}

const dur = (ms: number) => (ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);

/** One line per watch for listings. */
export function formatWatch(w: Watch): string {
  const s = w.source;
  const src = [`channel=${s.channel}`, s.account && `account=${s.account}`, s.conversation && `conversation=${s.conversation}`, s.conversationKind && `kind=${s.conversationKind}`, s.senders?.length && `senders=${s.senders.join(',')}`];
  const f = w.filter;
  const flt = [f?.keywords?.length && `keywords=${f.keywords.join(',')}`, f?.mentions?.length && `mentions=${f.mentions.join(',')}`, f?.excludeSelf === false && 'self=true'];
  const mode = w.mode === 'digest' && w.digest ? `mode=digest every=${dur(w.digest.everyMs)}${w.digest.maxItems ? ` max=${w.digest.maxItems}` : ''}` : `mode=${w.mode}`;
  const exp = w.expiresAt ? ` expires=${new Date(w.expiresAt).toISOString()}` : '';
  return `${w.id}\t→ ${w.target.sessionKey}\t${[...src, ...flt].filter(Boolean).join(' ')} ${mode}${exp}\tby ${w.createdBy}${w.note ? `\tnote: ${w.note}` : ''}`;
}
