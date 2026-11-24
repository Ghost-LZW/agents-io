import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';

/**
 * A frame the adapter sent the agent (`outbound`) or the agent sent it (`inbound`), as parsed JSON:
 * what a transcript recorder takes (`TranscriptRecorder.tap` in `@agents-io/testkit`; the transcript
 * format is docs/design/conformance-fixtures §2, protocol `acp`).
 */
export type AcpTranscriptTap = (direction: 'outbound' | 'inbound', frame: unknown) => void;

/** `inner` with every JSON-RPC message it carries also handed to `tap`, both ways, in the order they go. Nothing else changes. */
export function recordStream(inner: Stream, tap: AcpTranscriptTap): Stream {
  const copy = (m: AnyMessage) => JSON.parse(JSON.stringify(m)) as unknown;
  const out = new TransformStream<AnyMessage, AnyMessage>({
    transform(m, c) {
      tap('outbound', copy(m));
      c.enqueue(m);
    },
  });
  void out.readable.pipeTo(inner.writable).catch(() => undefined);
  const readable = inner.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(m, c) {
        tap('inbound', copy(m));
        c.enqueue(m);
      },
    }),
  );
  return { writable: out.writable, readable };
}
