import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEvent } from '@agents-io/protocol';
import { match, type Bindings } from './match.js';

/*
 * L3 projection fixtures (docs/design/conformance-fixtures §4a): how a north projection (core-slimming
 * G9: ACP, AG-UI) maps a session's events to its protocol's messages, as data. NDJSON: a header line
 * `{ "projection", "name", "description", "options"? }`, then `event` lines (a session event without
 * the fields the log stamps: `body` is enough) each followed by the `out` lines it must give, in
 * order, nothing more (`note` lines are skipped). Matching is exact (`match.ts`, placeholders
 * allowed). The projection itself is the implementation's: the runner only feeds and compares.
 */

/** The projections fixtures exist for. */
export const PROJECTIONS = ['acp', 'ag-ui'] as const;
export type ProjectionKind = (typeof PROJECTIONS)[number];

export interface ProjectionHeader {
  projection: ProjectionKind;
  name: string;
  description: string;
  /** What the projection is built with (ACP: `{ principal }`; AG-UI: `{ threadId, runId?, inputId? }`, and `fromSeq?` for a resume from that seq: the durable events up to it are what the reader has, given to the projection's resume). */
  options?: Record<string, unknown>;
}

export interface ProjectionStep {
  /** The 1-based line of the event. */
  line: number;
  event: SessionEvent;
  /** The outputs it must give, with their lines. */
  out: { line: number; value: unknown }[];
}

export interface ProjectionFixture {
  header: ProjectionHeader;
  steps: ProjectionStep[];
  file?: string;
}

const EPHEMERAL = new Set(['text.delta', 'item.progress', 'headline']);

/** A fixture's event as a session event: what the log stamps filled in (seq counts durable events from 1; an ephemeral one has the last durable seq). */
function eventOf(raw: Record<string, unknown>, seq: number, header: ProjectionHeader): SessionEvent {
  const body = raw.body as { t: string };
  const durability = (raw.durability as string | undefined) ?? (EPHEMERAL.has(body.t) ? 'ephemeral' : 'durable');
  return {
    v: 1,
    sessionKey: (header.options?.sessionKey as string | undefined) ?? 's',
    seq,
    harness: 'fake',
    generation: 0,
    visibility: 'participants',
    ts: 0,
    level: 'primary',
    audience: 'status',
    ...raw,
    durability,
  } as SessionEvent;
}

export function parseProjection(text: string, where = 'projection'): ProjectionFixture {
  let header: ProjectionHeader | undefined;
  const steps: ProjectionStep[] = [];
  let seq = 0;
  for (const [i, raw] of text.split('\n').entries()) {
    const l = raw.trim();
    if (!l) continue;
    const at = `${where}:${i + 1}`;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(l) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`${at}: not JSON: ${(e as Error).message}`);
    }
    if (!header) {
      const keys = Object.keys(v).filter((k) => !['projection', 'name', 'description', 'options'].includes(k));
      if (!PROJECTIONS.includes(v.projection as ProjectionKind) || typeof v.name !== 'string' || typeof v.description !== 'string' || keys.length) throw new Error(`${at}: a projection fixture starts with { "projection": ${PROJECTIONS.map((p) => `"${p}"`).join(' | ')}, "name", "description", "options"? }`);
      header = v as unknown as ProjectionHeader;
      continue;
    }
    const kinds = Object.keys(v);
    if (kinds.length !== 1) throw new Error(`${at}: one key per line (event, out or note)`);
    if ('note' in v) continue;
    if ('event' in v) {
      const e = v.event as Record<string, unknown>;
      if (!e || typeof e !== 'object' || typeof (e.body as { t?: unknown } | undefined)?.t !== 'string') throw new Error(`${at}: an event has a body with t`);
      const t = (e.body as { t: string }).t;
      if ((e.durability ?? (EPHEMERAL.has(t) ? 'ephemeral' : 'durable')) === 'durable') seq++;
      steps.push({ line: i + 1, event: eventOf(e, seq, header), out: [] });
      continue;
    }
    if ('out' in v) {
      const last = steps.at(-1);
      if (!last) throw new Error(`${at}: an out line comes after an event`);
      last.out.push({ line: i + 1, value: v.out });
      continue;
    }
    throw new Error(`${at}: unknown line ${kinds[0]} (event, out or note)`);
  }
  if (!header) throw new Error(`${where}: empty`);
  return { header, steps };
}

export function readProjection(path: string): ProjectionFixture {
  return { ...parseProjection(readFileSync(path, 'utf8'), path), file: path };
}

/** The `.ndjson` fixtures of one projection's directory, sorted. */
export function projectionFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Feed each event to `push` (the implementation's projection) and compare what it gives with the
 * fixture's `out` lines, exactly and in order; `check` is asked of every output too (its protocol's
 * schema). Throws naming the line on the first difference. Answers every output, in order.
 */
export function runProjection(f: ProjectionFixture, push: (e: SessionEvent) => unknown[], check?: (out: unknown) => string | undefined): unknown[] {
  const where = f.file ?? f.header.name;
  const bindings: Bindings = new Map();
  const all: unknown[] = [];
  for (const s of f.steps) {
    const got = push(s.event);
    all.push(...got);
    for (const [k, o] of got.entries()) {
      const bad = check?.(o);
      if (bad) throw new Error(`${where}:${s.line}: output ${k + 1} of the event fails its schema: ${bad}: ${JSON.stringify(o)}`);
      const want = s.out[k];
      if (!want) throw new Error(`${where}:${s.line}: the event gave ${got.length} outputs, the fixture has ${s.out.length}; output ${k + 1}: ${JSON.stringify(o)}`);
      const why = match(want.value, o, bindings, { exact: true });
      if (why !== undefined) throw new Error(`${where}:${want.line}: ${why}; got ${JSON.stringify(o)}`);
    }
    if (got.length < s.out.length) throw new Error(`${where}:${s.out[got.length]!.line}: the event at line ${s.line} gave ${got.length} outputs, the fixture has ${s.out.length}`);
  }
  return all;
}
