import type { Readable, Writable } from 'node:stream';
import { FrameDecoder, encodeFrame } from '@agents-io/protocol';

/**
 * One JSONL connection: decodes lines from `input`, writes frames to `output`.
 * Malformed lines go to `onBadLine` and are skipped; they never end the stream.
 */
export class FrameLink {
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    onFrame: (frame: unknown) => void,
    onBadLine: (line: string, err: unknown) => void,
    onEnd: () => void,
  ) {
    const decoder = new FrameDecoder(onBadLine);
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

  /** Returns false when the frame could not be written (peer gone). */
  send(frame: unknown): boolean {
    if (this.closed || this.output.destroyed || !this.output.writable) return false;
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
