import { ClientFrame, check, errors } from '@agents-io/protocol';

// The client frames live in the protocol (packages/protocol/src/client.ts); re-exported for existing imports.
export {
  CLIENT_FRAME_TYPES,
  ClientCommand,
  ClientFrame,
  ClientInput,
  SERVER_FRAME_TYPES,
  ServerFrame,
  SessionInfo,
} from '@agents-io/protocol';

export type ParsedClientFrame = { ok: true; frame: ClientFrame } | { ok: false; id?: string; error: string };

/** Validate one decoded line from a client. Unknown frame types are reported, not thrown. */
export function parseClientFrame(raw: unknown): ParsedClientFrame {
  if (check(ClientFrame, raw)) return { ok: true, frame: raw };
  const id = raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : undefined;
  return { ok: false, ...(id !== undefined ? { id } : {}), error: errors(ClientFrame, raw).slice(0, 3).join('; ') || 'invalid frame' };
}
