import {
  HARNESS_BRIDGE_FEATURES,
  OpenResult,
  PROTOCOL_VERSION,
  ProbeResult,
  STEER_RESULTS,
  check,
  errors,
  type Decision,
  type HarnessAdapter,
  type HarnessCaps,
  type HarnessDeclares,
  type HarnessEvent,
  type HarnessOpenArgs,
  type HarnessSession,
  type InputRecord,
  type RunSpec,
  type SessionEnvSupport,
  type SteerResult,
} from '@agents-io/protocol';
import { AsyncQueue } from '../fakes.js';
import type { Bindings } from './match.js';
import { TranscriptReplay, teardownAnswers, type ReplayError } from './replay.js';
import type { Transcript } from './transcript.js';

/*
 * An `aio.jsonl-harness` transcript as an in-process `HarnessAdapter`: the frames the harness bridge
 * host (`@agents-io/harness-jsonl-bridge` `spawnHarness`) would write to the program go to the
 * replay, the frames the replay sends come back as the program's. A kernel scenario's
 * `harness{transcript}` (docs/design/conformance-fixtures §3) runs on it in the TS runner; the same
 * transcript, played by `aio-transcript-replay` as a `bridge` instance's program, is the same harness
 * out of process. Like the bridge host it probes once (the first `probe` or `open`), declares what
 * the program's answer to `probe` says, and has `dispose`.
 */

export interface TranscriptHarnessOptions {
  /** Labels whose inbound lines wait for `release` (`TranscriptReplay`). */
  gates?: readonly string[];
  /** Frames after the transcript's last line: an error (default) or answered (teardown). */
  afterEnd?: 'error' | 'answer';
  bindings?: Bindings;
  /** Sent in `probe`, as a `bridge` instance's (`instance`, `config`). */
  instance?: string;
  config?: unknown;
  id?: string;
}

export class TranscriptHarnessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TranscriptHarnessError';
  }
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

export class TranscriptHarness implements HarnessAdapter {
  readonly id: string;
  readonly replay: TranscriptReplay;
  private hello: ProbeResult | undefined;
  private helloing: Promise<ProbeResult> | undefined;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly sessions = new Map<string, TranscriptSession>();
  private ended = false;
  private halted = false;

  constructor(
    transcript: Transcript,
    private readonly o: TranscriptHarnessOptions = {},
  ) {
    if (transcript.header.protocol !== 'aio.jsonl-harness') throw new Error(`TranscriptHarness plays aio.jsonl-harness transcripts, not ${transcript.header.protocol}`);
    this.id = o.id ?? 'bridge';
    this.replay = new TranscriptReplay(transcript, {
      emit: (f) => this.onFrame(f),
      onError: (e) => this.failAll(e),
      exit: () => this.gone('the harness program exited'),
      ...(o.gates ? { gates: o.gates } : {}),
      ...(o.bindings ? { bindings: o.bindings } : {}),
      afterEnd: o.afterEnd === 'answer' ? teardownAnswers('aio.jsonl-harness') : 'error',
    }).start();
  }

  // ---- static declarations: the program's hello, like the bridge host's ----

  private get declared(): HarnessDeclares {
    return this.hello?.declares ?? {};
  }
  get displayName(): string | undefined {
    return this.declared.displayName;
  }
  get compact(): { readonly command: string } | undefined {
    return this.declared.compact;
  }
  get modes(): readonly 'plan'[] | undefined {
    return this.declared.modes;
  }
  get ownerProfileSwitch(): boolean | undefined {
    return this.declared.ownerProfileSwitch;
  }
  get ephemeralOpen(): boolean | undefined {
    return this.declared.ephemeralOpen;
  }
  get adopts(): boolean | undefined {
    return this.declared.adopts;
  }
  get sessionEnv(): SessionEnvSupport | undefined {
    return this.declared.sessionEnv;
  }

  async probe(): Promise<{ version: string; caps: HarnessCaps }> {
    const h = await this.connect();
    return { version: h.version, caps: h.caps };
  }

  async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    const h = await this.connect();
    this.sessions.get(args.sessionKey)?.end();
    const s = new TranscriptSession(this, args.sessionKey, args.generation, h.caps);
    this.sessions.set(args.sessionKey, s);
    try {
      const v = await this.call('open', openBody(args));
      if (v !== undefined && v !== null) {
        if (!check(OpenResult, v)) throw new TranscriptHarnessError('bad_result', `open answered ${JSON.stringify(v)}: ${errors(OpenResult, v).slice(0, 3).join('; ')}`);
        if (v.nativeId !== undefined) s.native = v.nativeId;
      }
    } catch (e) {
      s.end();
      throw e;
    }
    return s;
  }

  /** Like the bridge host's: the program is told to shut down; nothing starts it again. */
  async dispose(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.replay.outbound({ v: PROTOCOL_VERSION, type: 'shutdown' });
    for (const s of [...this.sessions.values()]) s.end();
  }

  private connect(): Promise<ProbeResult> {
    if (this.ended) return Promise.reject(new TranscriptHarnessError('closed', 'the harness program was shut down'));
    return (this.helloing ??= this.call('probe', { features: [...HARNESS_BRIDGE_FEATURES], ...(this.o.instance !== undefined ? { instance: this.o.instance } : {}), ...(this.o.config !== undefined ? { config: this.o.config } : {}) }).then((v) => {
      if (!check(ProbeResult, v)) throw new TranscriptHarnessError('bad_hello', `invalid probe answer: ${errors(ProbeResult, v).slice(0, 3).join('; ')}`);
      this.hello = v;
      return v;
    }));
  }

  /**
   * Stops the replay where it is (a runner stopping the kernel): every request from now on fails as
   * if the program had gone, so the host's teardown is not checked against the transcript.
   */
  halt(): void {
    this.halted = true;
    this.replay.stop();
    this.gone('the transcript replay was halted');
  }

  /** A request as the bridge host writes it (through JSON, as on the wire); its answer's `value`. */
  call(type: string, body: Record<string, unknown>): Promise<unknown> {
    if (this.halted) return Promise.reject(new TranscriptHarnessError('peer_closed', 'the transcript replay was halted', true));
    if (this.replay.error) return Promise.reject(new TranscriptHarnessError('peer_closed', this.replay.error.message, true));
    const id = `h${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.replay.outbound(JSON.parse(JSON.stringify({ v: PROTOCOL_VERSION, type, id, ...body })));
    });
  }

  private onFrame(raw: unknown): void {
    const f = raw as Record<string, unknown>;
    if (!f || typeof f !== 'object') return;
    switch (f.type) {
      case 'result': {
        const p = this.pending.get(String(f.id));
        if (!p) return;
        this.pending.delete(String(f.id));
        const err = f.error as { code?: string; message?: string; retryable?: boolean } | undefined;
        if (f.ok) p.resolve(f.value);
        else p.reject(new TranscriptHarnessError(err?.code ?? 'error', err?.message ?? 'harness request failed', err?.retryable ?? false));
        return;
      }
      case 'event': {
        const s = this.sessions.get(String(f.sessionKey));
        if (s && s.generation === f.generation) s.queue.push(f.event as HarnessEvent);
        return;
      }
      case 'nativeId': {
        const s = this.sessions.get(String(f.sessionKey));
        if (s) s.native = String(f.nativeId);
        return;
      }
      case 'closed': {
        const s = this.sessions.get(String(f.sessionKey));
        if (s && s.generation === f.generation) s.end();
        return;
      }
      case 'blob.stat':
      case 'blob.get':
        // No blob store here, as the bridge host without `blobs` answers.
        this.replay.outbound({ v: PROTOCOL_VERSION, type: 'result', id: f.id, ok: false, error: { code: 'unsupported', message: 'the host has no blob store', retryable: false } });
        return;
    }
  }

  private failAll(e: ReplayError): void {
    this.gone(`transcript replay failed: ${e.message}`);
  }

  private gone(why: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new TranscriptHarnessError('peer_closed', why, true));
    }
    for (const s of [...this.sessions.values()]) s.end();
  }

  forget(s: TranscriptSession): void {
    if (this.sessions.get(s.key) === s) this.sessions.delete(s.key);
  }
}

class TranscriptSession implements HarnessSession {
  readonly queue = new AsyncQueue<HarnessEvent>();
  readonly events: AsyncIterable<HarnessEvent> = this.queue;
  native: string | undefined;
  private closed = false;
  readonly cancelQueued?: (inputIds: string[]) => Promise<void>;
  readonly inject?: (inputs: InputRecord[]) => Promise<void>;

  constructor(
    private readonly h: TranscriptHarness,
    readonly key: string,
    readonly generation: number,
    caps: HarnessCaps,
  ) {
    if (caps.cancelQueued) this.cancelQueued = async (inputIds) => void (await this.request('cancelQueued', { inputIds }));
    if (caps.injectWithoutTurn) this.inject = async (inputs) => void (await this.request('inject', { inputs }));
  }

  nativeId(): string | undefined {
    return this.native;
  }

  private request(type: string, body: Record<string, unknown>): Promise<unknown> {
    return this.h.call(type, { sessionKey: this.key, ...body });
  }

  async startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void> {
    await this.request('startTurn', { turnId, inputs, ...(run ? { run } : {}) });
  }

  async steer(inputs: InputRecord[], expectedTurnId: string): Promise<SteerResult> {
    const v = await this.request('steer', { inputs, expectedTurnId });
    if (typeof v !== 'string' || !(STEER_RESULTS as readonly string[]).includes(v)) throw new TranscriptHarnessError('bad_result', `steer answered ${JSON.stringify(v)}`);
    return v as SteerResult;
  }

  async interrupt(turnId: string): Promise<void> {
    await this.request('interrupt', { turnId });
  }

  async respond(requestId: string, decision: Decision): Promise<void> {
    await this.request('respond', { requestId, decision });
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.request('close', { reason });
    } catch {
      // Gone or failed: the session is over here either way.
    } finally {
      this.end();
    }
  }

  end(): void {
    this.closed = true;
    this.queue.close();
    this.h.forget(this);
  }
}

/** The `open` frame's body, as the bridge host builds it (`harness/jsonl-bridge` `openBody`). */
function openBody(a: HarnessOpenArgs): Record<string, unknown> {
  return {
    sessionKey: a.sessionKey,
    generation: a.generation,
    cwd: a.cwd,
    ...(a.resume !== undefined ? { resume: a.resume } : {}),
    run: a.run,
    ...(a.mcp ? { mcp: a.mcp } : {}),
    ...(a.options ? { options: a.options } : {}),
    ...(a.env ? { env: a.env } : {}),
    ...(a.instructions !== undefined ? { instructions: a.instructions } : {}),
  };
}
