import type { Readable, Writable } from 'node:stream';
import { FrameDecoder, encodeFrame } from '@agents-io/protocol';

/*
 * The JSONL connection both sides of the harness bridge use. The same as the channel bridge's
 * (`channel/jsonl-bridge/src/link.ts`): a module package imports only the protocol, so it has its own.
 */

export interface FrameLinkOptions {
  /** Refuse to send while more than this many bytes wait for the peer to read. Default 64MiB (a `blob.get` answer is up to 16MiB of base64). */
  maxBufferedBytes?: number;
  /** Longest incoming line; longer ones go to `onBadLine`. Default: FrameDecoder's. */
  maxLineLength?: number;
}

/**
 * One JSONL connection: decodes lines from `input`, writes frames to `output`.
 * Malformed lines go to `onBadLine` and are skipped; they never end the stream.
 */
export class FrameLink {
  private closed = false;
  private readonly maxBuffered: number;

  constructor(
    input: Readable,
    private readonly output: Writable,
    onFrame: (frame: unknown) => void,
    onBadLine: (line: string, err: unknown) => void,
    onEnd: () => void,
    opts: FrameLinkOptions = {},
  ) {
    this.maxBuffered = opts.maxBufferedBytes ?? 64 * 1024 * 1024;
    const decoder = new FrameDecoder(onBadLine, { maxLineLength: opts.maxLineLength });
    // setEncoding uses a stateful decoder, so multi-byte characters split across chunks survive.
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      for (const f of decoder.push(chunk)) {
        try {
          onFrame(f);
        } catch (err) {
          onBadLine(JSON.stringify(f).slice(0, 200), err);
        }
      }
    });
    const end = () => {
      if (this.closed) return;
      this.closed = true;
      onEnd();
    };
    input.on('end', end);
    input.on('close', end);
    input.on('error', end);
    // A dead peer must not crash us; the close event drives recovery.
    output.on('error', () => {});
  }

  /** True while the peer has stopped reading and the write buffer is over its limit. */
  get congested(): boolean {
    return this.output.writableLength > this.maxBuffered;
  }

  /** Returns false when the frame could not be written (peer gone, or not reading: see `congested`). */
  send(frame: unknown): boolean {
    if (this.closed || this.output.destroyed || !this.output.writable || this.congested) return false;
    try {
      this.output.write(encodeFrame(frame));
      return true;
    } catch {
      return false;
    }
  }
}

/** An unbounded async queue usable as an AsyncIterable. Iterated by one consumer. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An error's wire form (`ResultFrame.error`): its `code` and `retryable` when it has them (`AdapterError`). */
export function wireError(err: unknown, fallback: string): { code: string; message: string; retryable: boolean } {
  const e = err as { code?: unknown; retryable?: unknown } | undefined;
  return { code: typeof e?.code === 'string' ? e.code : fallback, message: errMsg(err), retryable: e?.retryable === true };
}
