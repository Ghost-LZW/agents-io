import { createHash } from 'node:crypto';
import { STREAMING_CONFIG } from './process-card.js';
import type { LarkApiResponse, LarkCardKitApi } from './types.js';

/** Error from a Lark API call; `code` is the platform code when the platform answered. */
export class LarkApiError extends Error {
  constructor(
    readonly op: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`lark ${op} failed${code !== undefined ? ` (code ${code})` : ''}: ${message}`);
    this.name = 'LarkApiError';
  }
}

export function errCode(e: unknown): number | undefined {
  const x = e as { code?: unknown; response?: { data?: { code?: unknown } } };
  const c = x?.response?.data?.code ?? x?.code;
  return typeof c === 'number' ? c : undefined;
}

/** Codes that reject a request without applying it, worth one more try: interaction lock, rate limits. */
const RETRY_CODES = new Set([200810, 99991400, 99991401]);
/** Streaming mode closed by itself (10 minutes after it was turned on) or explicitly. */
const STREAM_CLOSED_CODES = new Set([200850, 300309]);

export interface CardKitOptions {
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

/** Run a Lark call with a timeout; reject non-zero codes as LarkApiError. */
export async function call<T extends LarkApiResponse>(op: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LarkApiError(op, undefined, `timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  let res: T;
  try {
    res = await Promise.race([fn(), timeout]);
  } catch (err) {
    if (err instanceof LarkApiError) throw err;
    throw new LarkApiError(op, errCode(err), err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
  if (res?.code) throw new LarkApiError(op, res.code, res.msg ?? 'unknown error');
  return res;
}

/** A sequence that is larger than anything a card created by an earlier process used (for adopted cards). */
export function adoptedSequence(now = Date.now()): number {
  return Math.max(1, Math.floor(now / 1000) - 1_700_000_000);
}

/**
 * One CardKit card entity. Every mutation carries a strictly increasing `sequence` and an
 * idempotency `uuid` derived from (card, sequence, op). Callers serialise calls per card.
 */
export class CardKitCard {
  private seq: number;

  private constructor(
    private readonly api: LarkCardKitApi,
    readonly cardId: string,
    seq: number,
    private readonly o: CardKitOptions,
  ) {
    this.seq = seq;
  }

  static async create(api: LarkCardKitApi, card: object, o: CardKitOptions): Promise<CardKitCard> {
    const res = await call('cardkit.card.create', o.timeoutMs, () => api.card.create({ data: { type: 'card_json', data: JSON.stringify(card) } }));
    const id = res.data?.card_id;
    if (!id) throw new LarkApiError('cardkit.card.create', undefined, 'no card_id returned');
    return new CardKitCard(api, id, 1, o);
  }

  /** Take over a card this process did not create (e.g. after a restart). */
  static adopt(api: LarkCardKitApi, cardId: string, o: CardKitOptions, seq = adoptedSequence()): CardKitCard {
    return new CardKitCard(api, cardId, seq, o);
  }

  get sequence(): number {
    return this.seq;
  }

  private async mutate(op: string, send: (m: { sequence: number; uuid: string }) => Promise<LarkApiResponse>): Promise<void> {
    const sequence = ++this.seq;
    const uuid = `c${createHash('sha256').update(`${this.cardId}\0${sequence}\0${op}`).digest('hex').slice(0, 32)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await call(`cardkit.${op}`, this.o.timeoutMs, () => send({ sequence, uuid }));
        return;
      } catch (err) {
        // An explicit "not now" was not applied: retry the very same mutation.
        if (attempt >= 3 || !(err instanceof LarkApiError) || err.code === undefined || !RETRY_CODES.has(err.code)) throw err;
        await this.o.sleep(250 * 2 ** attempt);
      }
    }
  }

  /** Stream a text element's full content; reopens streaming once if the platform closed it. */
  async content(elementId: string, content: string): Promise<void> {
    const send = () =>
      this.mutate(`cardElement.content:${elementId}`, (m) =>
        this.api.cardElement.content({ path: { card_id: this.cardId, element_id: elementId }, data: { content, ...m } }),
      );
    try {
      await send();
    } catch (err) {
      if (!(err instanceof LarkApiError) || err.code === undefined || !STREAM_CLOSED_CODES.has(err.code)) throw err;
      await this.settings({ config: { streaming_mode: true, streaming_config: STREAMING_CONFIG } });
      await send();
    }
  }

  updateElement(elementId: string, element: object): Promise<void> {
    return this.mutate(`cardElement.update:${elementId}`, (m) =>
      this.api.cardElement.update({ path: { card_id: this.cardId, element_id: elementId }, data: { element: JSON.stringify(element), ...m } }),
    );
  }

  createElements(elements: object[], at: { type: 'insert_before' | 'insert_after'; target: string } | { type: 'append' }): Promise<void> {
    return this.mutate(`cardElement.create`, (m) =>
      this.api.cardElement.create({
        path: { card_id: this.cardId },
        data: { type: at.type, ...('target' in at ? { target_element_id: at.target } : {}), elements: JSON.stringify(elements), ...m },
      }),
    );
  }

  deleteElement(elementId: string): Promise<void> {
    return this.mutate(`cardElement.delete:${elementId}`, (m) => this.api.cardElement.delete({ path: { card_id: this.cardId, element_id: elementId }, data: { ...m } }));
  }

  settings(settings: object): Promise<void> {
    return this.mutate('card.settings', (m) => this.api.card.settings({ path: { card_id: this.cardId }, data: { settings: JSON.stringify(settings), ...m } }));
  }

  update(card: object): Promise<void> {
    return this.mutate('card.update', (m) =>
      this.api.card.update({ path: { card_id: this.cardId }, data: { card: { type: 'card_json', data: JSON.stringify(card) }, ...m } }),
    );
  }
}
