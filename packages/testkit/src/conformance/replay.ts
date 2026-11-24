import { match, substitute, type Bindings } from './match.js';
import { matchModeOf, type RuntimeExit, type Transcript } from './transcript.js';

/*
 * Plays a harness transcript as the harness (docs/design/conformance-fixtures §2.3): one cursor
 * through the lines, in order. An `emit_inbound` line is sent (after its `afterMs`; a gated label
 * waits for `release`), with its bindings substituted; an `expect_outbound` line waits for the
 * next frame the side under test sends and compares it (`match.ts`: exact for a recording, subset
 * when `metadata.match` says so). Frames that come early wait their turn; one that differs, or
 * comes after the last line, is an error and the replay stops. `runtime_exit` ends it.
 */

export interface ReplayError {
  kind: 'mismatch' | 'exhausted' | 'emit';
  /** The transcript line (from 1, the header being line 1). */
  line: number;
  label?: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

/** What a peer answers to frames after the transcript's last line (teardown), by protocol. */
export type AfterEnd = 'error' | ((frame: unknown) => unknown[]);

export interface ReplayOptions {
  /** Sends a frame to the side under test. */
  emit(frame: unknown): void;
  /** The transcript reached `runtime_exit`. */
  exit?(status: RuntimeExit['status'], error?: unknown): void;
  /** The replay stopped on an error (also in `error`). */
  onError?(e: ReplayError): void;
  /** Labels whose inbound lines wait for `release(label)`. */
  gates?: readonly string[];
  /** Bindings to start with (`workspace`, …). */
  bindings?: Bindings;
  /** How outbound frames compare (default: the transcript's `metadata.match`). */
  match?: 'exact' | 'subset';
  /** Frames after the last line: an error (default), or answered with what this returns (teardown). */
  afterEnd?: AfterEnd;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TranscriptReplay {
  readonly bindings: Bindings;
  error: ReplayError | undefined;
  private cursor = 0;
  private readonly queue: unknown[] = [];
  private wake: (() => void) | undefined;
  private readonly gates: Set<string>;
  private readonly released = new Set<string>();
  private readonly reachedGates = new Set<string>();
  private readonly gateWaiters = new Map<string, (() => void)[]>();
  private readonly doneWaiters: (() => void)[] = [];
  private stopped = false;
  private exited = false;
  private started = false;

  constructor(
    readonly transcript: Transcript,
    private readonly o: ReplayOptions,
  ) {
    this.bindings = new Map(o.bindings ?? []);
    this.gates = new Set(o.gates ?? []);
  }

  /** Starts playing: the lines before the first expected frame are sent now. */
  start(): this {
    if (!this.started) {
      this.started = true;
      void this.run();
    }
    return this;
  }

  /** A frame the side under test sent. */
  outbound(frame: unknown): void {
    if (this.stopped) return;
    this.queue.push(frame);
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }

  /** Lets the inbound lines labelled `label` go (now, or when the replay gets there). */
  release(label: string): void {
    this.released.add(label);
    for (const w of this.gateWaiters.get(label)?.splice(0) ?? []) w();
  }

  /** The replay is holding (or held) a line labelled `label`. */
  reached(label: string): boolean {
    return this.reachedGates.has(label);
  }

  /** Every line was played (or `runtime_exit` reached). */
  get done(): boolean {
    return this.exited || this.cursor >= this.transcript.entries.length;
  }

  /** The line the replay is at (from 1, header included), for messages. */
  get line(): number {
    return this.cursor + 2;
  }

  /** Resolves once every line was played, or the replay stopped on an error. */
  whenDone(): Promise<void> {
    if (this.done || this.error) return Promise.resolve();
    return new Promise((r) => this.doneWaiters.push(r));
  }

  /** Stops playing (the side under test went away). */
  stop(): void {
    this.stopped = true;
    const w = this.wake;
    this.wake = undefined;
    w?.();
    for (const ws of this.gateWaiters.values()) for (const g of ws.splice(0)) g();
    this.settleDone();
  }

  private settleDone(): void {
    for (const w of this.doneWaiters.splice(0)) w();
  }

  private fail(e: ReplayError): void {
    if (this.error) return;
    this.error = e;
    this.o.onError?.(e);
    this.settleDone();
  }

  private async next(): Promise<unknown> {
    while (!this.queue.length && !this.stopped) await new Promise<void>((r) => (this.wake = r));
    return this.queue.shift();
  }

  private async run(): Promise<void> {
    const entries = this.transcript.entries;
    const exact = (this.o.match ?? matchModeOf(this.transcript)) === 'exact';
    while (!this.stopped && !this.error && !this.exited && this.cursor < entries.length) {
      const e = entries[this.cursor]!;
      const line = this.line;
      if (e.type === 'emit_inbound') {
        if (e.label && this.gates.has(e.label) && !this.released.has(e.label)) {
          this.reachedGates.add(e.label);
          await new Promise<void>((r) => this.gateWaiters.set(e.label!, [...(this.gateWaiters.get(e.label!) ?? []), r]));
          if (this.stopped) break;
        }
        if (e.afterMs) await sleep(e.afterMs);
        if (this.stopped) break;
        let frame: unknown;
        try {
          frame = substitute(e.frame, this.bindings, { unbound: 'name' });
        } catch (err) {
          this.fail({ kind: 'emit', line, ...(e.label ? { label: e.label } : {}), message: `line ${line}: ${(err as Error).message}` });
          break;
        }
        this.cursor++;
        this.o.emit(frame);
        // Let the side under test take it before the next line.
        await Promise.resolve();
      } else if (e.type === 'expect_outbound') {
        const actual = await this.next();
        if (this.stopped) break;
        const why = match(e.frame, actual, this.bindings, { exact });
        if (why) {
          this.fail({ kind: 'mismatch', line, ...(e.label ? { label: e.label } : {}), message: `line ${line}${e.label ? ` (${e.label})` : ''}: ${why}`, expected: e.frame, actual });
          break;
        }
        this.cursor++;
      } else {
        this.exited = true;
        this.cursor++;
        this.o.exit?.(e.status, e.error);
      }
    }
    if (this.done) this.settleDone();
    // After the last line: what comes is teardown, answered or refused.
    while (!this.stopped && !this.error && !this.exited) {
      const f = await this.next();
      if (this.stopped) break;
      const after = this.o.afterEnd ?? 'error';
      if (after === 'error') {
        this.fail({ kind: 'exhausted', line: entries.length + 2, message: `a frame after the transcript's last line (${entries.length + 1}): ${JSON.stringify(f)?.slice(0, 200)}`, actual: f });
        break;
      }
      for (const a of after(f)) this.o.emit(a);
    }
  }
}

/**
 * What a peer of `protocol` answers to frames after the transcript ended: requests get an empty
 * success, everything else nothing (harness bridge: a result `ok`; JSON-RPC: `result: {}`).
 */
export function teardownAnswers(protocol: string): (frame: unknown) => unknown[] {
  return (frame) => {
    const f = frame as Record<string, unknown> | null;
    if (!f || typeof f !== 'object' || f.id === undefined) return [];
    if (protocol === 'aio.jsonl-harness') return typeof f.type === 'string' && f.type !== 'result' ? [{ v: f.v ?? 1, type: 'result', id: f.id, ok: true }] : [];
    return typeof f.method === 'string' ? [{ id: f.id, result: {} }] : [];
  };
}
