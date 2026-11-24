import type { Transport } from './rpc.js';

/**
 * A frame the adapter sent (`outbound`) or the app-server sent it (`inbound`), parsed: what a
 * transcript recorder takes (`TranscriptRecorder.tap` in `@agents-io/testkit`; the transcript
 * format is docs/design/conformance-fixtures §2).
 */
export type TranscriptTap = (direction: 'outbound' | 'inbound', frame: unknown) => void;

/**
 * `inner` with every JSON line it carries also handed to `tap`, both ways, in the order they go:
 * the record of a real `codex app-server` exchange (`harness/codex/scripts/record-transcripts.ts`).
 * Lines that are not JSON (stray logs) are carried and not recorded. Nothing else changes.
 */
export function recordTransport(inner: Transport, tap: TranscriptTap): Transport & { stderrTail?(): string } {
  const listeners: ((line: string) => void)[] = [];
  let listening = false;
  const record = (direction: 'outbound' | 'inbound', line: string) => {
    if (!line.trim()) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    tap(direction, frame);
  };
  const tail = (inner as { stderrTail?: () => string }).stderrTail;
  return {
    write(line) {
      record('outbound', line);
      inner.write(line);
    },
    onLine(cb) {
      listeners.push(cb);
      if (listening) return;
      listening = true;
      inner.onLine((line) => {
        record('inbound', line);
        for (const l of listeners) l(line);
      });
    },
    onClose: (cb) => inner.onClose(cb),
    close: () => inner.close(),
    ...(tail ? { stderrTail: () => tail.call(inner) } : {}),
  };
}
