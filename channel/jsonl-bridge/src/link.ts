import type { Readable, Writable } from 'node:stream';
import { FrameDecoder, encodeFrame } from '@agents-io/protocol';

export interface FrameLinkOptions {
  /** Refuse to send while more than this many bytes wait for the peer to read. Default 16MiB. */
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
    this.maxBuffered = opts.maxBufferedBytes ?? 16 * 1024 * 1024;
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

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
