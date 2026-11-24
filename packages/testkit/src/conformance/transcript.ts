import { readFileSync } from 'node:fs';

/*
 * L1 harness transcripts (docs/design/conformance-fixtures §2): what went over a harness's wire, as
 * NDJSON in t3code's shape. The first line is `transcript_start`; every other line is a frame the
 * harness was sent (`expect_outbound`), a frame it sent (`emit_inbound`, optionally `afterMs` after
 * the line before it), or its exit (`runtime_exit`). "Outbound" and "inbound" are the adapter's
 * view: outbound frames go from the adapter (or the bridge host) to the harness program.
 *
 * `protocol` names the wire: `codex.app-server` (Codex's JSON-RPC, as the Codex adapter's
 * `Transport` carries it), `aio.jsonl-harness` (the harness bridge frames of
 * `@agents-io/protocol` `wire.ts`) or `acp` (the Agent Client Protocol's JSON-RPC on stdio, v1, as
 * the ACP adapter's connection carries it). `metadata.match` is `exact` (default: what a recording
 * is) or `subset` (a hand-written transcript names only the fields that matter, `match.ts`).
 */

export const TRANSCRIPT_PROTOCOLS = ['codex.app-server', 'aio.jsonl-harness', 'acp'] as const;
export type TranscriptProtocol = (typeof TRANSCRIPT_PROTOCOLS)[number];

export interface TranscriptStart {
  type: 'transcript_start';
  provider: string;
  protocol: string;
  version: string;
  scenario: string;
  metadata?: Record<string, unknown>;
}
export interface ExpectOutbound {
  type: 'expect_outbound';
  label?: string;
  frame: unknown;
}
export interface EmitInbound {
  type: 'emit_inbound';
  label?: string;
  frame: unknown;
  afterMs?: number;
}
export interface RuntimeExit {
  type: 'runtime_exit';
  status: 'success' | 'error' | 'cancelled';
  error?: unknown;
}
export type TranscriptEntry = ExpectOutbound | EmitInbound | RuntimeExit;
export type TranscriptLine = TranscriptStart | TranscriptEntry;

export interface Transcript {
  header: TranscriptStart;
  entries: TranscriptEntry[];
}

const KEYS: Record<TranscriptLine['type'], { required: string[]; optional: string[] }> = {
  transcript_start: { required: ['provider', 'protocol', 'version', 'scenario'], optional: ['metadata'] },
  expect_outbound: { required: ['frame'], optional: ['label'] },
  emit_inbound: { required: ['frame'], optional: ['label', 'afterMs'] },
  runtime_exit: { required: ['status'], optional: ['error'] },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

/** Why `line` (the `n`th, from 1) is not a transcript line of its place, or nothing. */
function lineError(line: unknown, n: number): string | undefined {
  if (!isObject(line) || typeof line.type !== 'string' || !(line.type in KEYS)) return `line ${n}: not a transcript line (type ${isObject(line) ? JSON.stringify(line.type) : 'missing'})`;
  const type = line.type as TranscriptLine['type'];
  if ((n === 1) !== (type === 'transcript_start')) return n === 1 ? 'line 1: a transcript starts with transcript_start' : `line ${n}: transcript_start only on line 1`;
  const k = KEYS[type];
  for (const r of k.required) if (!(r in line)) return `line ${n}: ${type} without ${r}`;
  const extra = Object.keys(line).filter((x) => x !== 'type' && !k.required.includes(x) && !k.optional.includes(x));
  if (extra.length) return `line ${n}: ${type} has unknown ${extra.join(', ')}`;
  if (type === 'transcript_start') {
    for (const f of ['provider', 'protocol', 'version', 'scenario']) if (!nonEmpty(line[f])) return `line ${n}: ${f} must be a non-empty string`;
    if (line.metadata !== undefined && !isObject(line.metadata)) return `line ${n}: metadata must be an object`;
    const m = (line.metadata as Record<string, unknown> | undefined)?.match;
    if (m !== undefined && m !== 'exact' && m !== 'subset') return `line ${n}: metadata.match must be "exact" or "subset"`;
  }
  if ('label' in line && !nonEmpty(line.label)) return `line ${n}: label must be a non-empty string`;
  if (type === 'emit_inbound' && line.afterMs !== undefined && !(Number.isInteger(line.afterMs) && (line.afterMs as number) >= 0)) return `line ${n}: afterMs must be a non-negative integer`;
  if (type === 'runtime_exit' && !['success', 'error', 'cancelled'].includes(line.status as string)) return `line ${n}: status must be success, error or cancelled`;
  return undefined;
}

/** Parses NDJSON text (`where` names it in errors). Throws on anything that is not a transcript. */
export function parseTranscript(text: string, where = 'transcript'): Transcript {
  const lines = text.split('\n').map((l) => l.trim());
  const out: TranscriptLine[] = [];
  for (const [i, l] of lines.entries()) {
    if (!l) continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch (e) {
      throw new Error(`${where}: line ${i + 1}: not JSON (${(e as Error).message})`);
    }
    const why = lineError(v, out.length + 1);
    if (why) throw new Error(`${where}: ${why}`);
    out.push(v as TranscriptLine);
  }
  if (!out.length) throw new Error(`${where}: empty`);
  const [header, ...entries] = out;
  return { header: header as TranscriptStart, entries: entries as TranscriptEntry[] };
}

export function readTranscript(path: string): Transcript {
  return parseTranscript(readFileSync(path, 'utf8'), path);
}

/** NDJSON, one line each, header first. */
export function formatTranscript(t: Transcript): string {
  return [t.header, ...t.entries].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** How a transcript's outbound frames are compared (`metadata.match`). */
export const matchModeOf = (t: Transcript): 'exact' | 'subset' => (t.header.metadata?.match === 'subset' ? 'subset' : 'exact');

// ---- labels -------------------------------------------------------------------

/**
 * A line's label: what the frame is, for people and for gates. JSON-RPC (`codex.app-server`, `acp`): the
 * method, a response the method of the request it answers. Harness bridge frames: the frame type,
 * a result the type of the request it answers, an event `event:<body.t>`.
 */
export class Labeler {
  private readonly asked = new Map<string, string>();
  constructor(private readonly protocol: string) {}

  label(direction: 'outbound' | 'inbound', frame: unknown): string | undefined {
    if (!isObject(frame)) return undefined;
    const id = frame.id === undefined ? undefined : String(frame.id);
    // An answer goes the other way from the request it answers.
    const answered = () => (id === undefined ? undefined : this.asked.get(`${direction === 'outbound' ? 'inbound' : 'outbound'}:${id}`));
    const asks = (what: string) => {
      if (id !== undefined) this.asked.set(`${direction}:${id}`, what);
      return what;
    };
    if (this.protocol === 'aio.jsonl-harness') {
      const type = typeof frame.type === 'string' ? frame.type : undefined;
      if (type === 'result') return answered() ?? 'result';
      if (type === 'event' && isObject(frame.event) && isObject(frame.event.body) && typeof frame.event.body.t === 'string') return `event:${frame.event.body.t}`;
      return type && asks(type);
    }
    if (typeof frame.method === 'string') return asks(frame.method);
    return answered();
  }
}

// ---- scrubbing ----------------------------------------------------------------

export interface ScrubOptions {
  /** The recording machine's home directory: replaced by `/home/replay-user`. */
  home?: string;
  /** Its host name: a string equal to it becomes `replay-host`. */
  hostname?: string;
  /** The working directory of the recorded sessions: `<$workspace>` (a binding: what the replaying side gives). */
  workspace?: string;
  /**
   * Which string values are ids made up during the recording (a key and its value): each distinct
   * one becomes `<$prefix-N>` everywhere it occurs, inside other strings too. The replaying peer
   * sends an unbound one as `prefix-N`; the side under test echoes it back.
   */
  ids?: (key: string, value: string, path: string) => string | undefined;
  /** Values of outbound frames that differ every run and are not echoed back (tokens, URLs): `<any>`. */
  volatile?: (key: string, value: unknown, path: string) => boolean;
}

export const REPLAY_HOME = '/home/replay-user';
export const REPLAY_HOSTNAME = 'replay-host';

/**
 * A recording without what is particular to the machine and the run (t3code's
 * `codexReplayRecordingOutputRecords`): the home directory and host name replaced, the workspace
 * and made-up ids turned into bindings, volatile outbound values into `<any>`.
 */
export function scrubTranscript(t: Transcript, o: ScrubOptions): Transcript {
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();
  const collect = (v: unknown, key: string, path: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => collect(x, key, `${path}[${i}]`));
    if (isObject(v)) return Object.entries(v).forEach(([k, x]) => collect(x, k, path ? `${path}.${k}` : k));
    if (typeof v !== 'string' || !o.ids || ids.has(v) || v.length < 2) return;
    const prefix = o.ids(key, v, path);
    if (!prefix) return;
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    ids.set(v, `<$${prefix}-${n}>`);
  };
  for (const e of t.entries) if (e.type !== 'runtime_exit') collect(e.frame, '', '');
  // Longest first, so an id that contains another is replaced whole.
  const byLength = [...ids.entries()].sort((a, b) => b[0].length - a[0].length);
  const text = (s: string): string => {
    if (ids.has(s)) return ids.get(s)!;
    let out = s;
    if (o.workspace && out.includes(o.workspace)) out = out === o.workspace ? '<$workspace>' : out.split(o.workspace).join('<$workspace>');
    for (const [id, ph] of byLength) if (out.includes(id)) out = out.split(id).join(ph);
    if (o.home) out = out.split(o.home).join(REPLAY_HOME);
    if (o.hostname && out === o.hostname) out = REPLAY_HOSTNAME;
    return out;
  };
  const scrub = (v: unknown, outbound: boolean, key: string, path: string): unknown => {
    if (outbound && o.volatile?.(key, v, path)) return '<any>';
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map((x, i) => scrub(x, outbound, key, `${path}[${i}]`));
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, outbound, k, path ? `${path}.${k}` : k)]));
    return v;
  };
  return {
    header: { ...t.header, ...(t.header.metadata ? { metadata: scrub(t.header.metadata, false, '', '') as Record<string, unknown> } : {}) },
    entries: t.entries.map((e) => (e.type === 'runtime_exit' ? e : { ...e, frame: scrub(e.frame, e.type === 'expect_outbound', '', '') })),
  };
}

// ---- recording ----------------------------------------------------------------

/** What a recorder taps: one frame in one direction (the adapter's view). */
export type TranscriptTap = (direction: 'outbound' | 'inbound', frame: unknown) => void;

/**
 * Collects a transcript from a tap (`recordTransport` in `@agents-io/harness-codex`, the harness
 * bridge's `record` option): every frame as it went, labelled.
 */
export class TranscriptRecorder {
  private readonly entries: TranscriptEntry[] = [];
  private readonly labeler: Labeler;
  version: string;

  constructor(private readonly header: Omit<TranscriptStart, 'type' | 'version'> & { version?: string }) {
    this.labeler = new Labeler(header.protocol);
    this.version = header.version ?? 'unknown';
  }

  readonly tap: TranscriptTap = (direction, frame) => {
    const copy = JSON.parse(JSON.stringify(frame)) as unknown;
    const label = this.labeler.label(direction, copy);
    this.entries.push({ type: direction === 'outbound' ? 'expect_outbound' : 'emit_inbound', ...(label ? { label } : {}), frame: copy });
  };

  exit(status: RuntimeExit['status'], error?: unknown): void {
    this.entries.push({ type: 'runtime_exit', status, ...(error !== undefined ? { error } : {}) });
  }

  transcript(): Transcript {
    const { version: _v, ...rest } = this.header;
    return { header: { type: 'transcript_start', ...rest, version: this.version }, entries: [...this.entries] };
  }
}
