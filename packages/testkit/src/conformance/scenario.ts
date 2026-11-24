import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  type AckState,
  type ChannelAdapter,
  type ConversationSpec,
  type HarnessAdapter,
  type InboundEnvelope,
  type RenderedMessage,
  type ReplyRoute,
  type SendOp,
} from '@agents-io/protocol';
import { FakeChannel, FakeHarness } from '../fakes.js';
import { match, substitute, type Bindings } from './match.js';
import { readTranscript, type Transcript } from './transcript.js';
import { TranscriptHarness } from './transcript-harness.js';

/*
 * L2 kernel scenarios (docs/design/conformance-fixtures §3): NDJSON, a header line, then input
 * lines and expectation lines, run in order. Ends are where frames enter or leave the kernel: the
 * channel (the reference channel adapter `fake`, its calls as the channel bridge's frames), clients
 * and hosts (the local socket's frames, raw), the session log (durable events in seq order), and the
 * attention projection. The runner here is the TS one: it plays every line against a kernel the
 * driver starts (`ScenarioDriver`), with testkit's fakes as the channel and the harness.
 */

export const SCENARIO_ENDS = ['channel', 'client', 'host', 'log', 'attention'] as const;
export type ScenarioEnd = (typeof SCENARIO_ENDS)[number];

export interface ScenarioHeader {
  scenario: string;
  description: string;
  /** The INVARIANTS ids it is a test of (`scripts/invariants.mjs` counts it as one). */
  invariants: string[];
  /** Merged over the reference config, key by key (`REFERENCE_CONFIG`). */
  config?: Record<string, unknown>;
  /** Default wait of each expectation, ms (default 5000). */
  timeoutMs?: number;
}

export type EmitStep =
  | { end: 'channel'; frame: { type: 'inbound'; id?: string; envelope: Record<string, unknown> } }
  | { end: 'client' | 'host'; conn?: string; frame: Record<string, unknown> }
  | { end: 'log'; session?: string; event: Record<string, unknown> };

export interface Expectation {
  end: ScenarioEnd;
  /** client / host: which connection (default `client` / `host`). */
  conn?: string;
  /** log / attention: which session (default `s`). */
  session?: string;
  /** The next item at this end (after the previous one matched there) that matches. */
  match?: unknown;
  /**
   * No item at this end matches, from here (after the item matched there last) until the item the
   * expectation labelled `until` matched (any end), or the end of the scenario. Checked at the end.
   */
  none?: unknown;
  /** none: where the window ends (a `label` of a later expectation). */
  until?: string;
  /**
   * log: the session's seqs, read from the start, are 1, 2, … with no gap. client / host: the seqs
   * of the session's durable `event` frames this connection received are consecutive (no gap, no
   * repeat), wherever they start.
   */
  gapless?: true;
  /** Match with no keys beyond the pattern's (`match.ts`). */
  exact?: boolean;
  /** Only the very next item at this end may match. */
  next?: boolean;
  /** Names this match for `after`. */
  label?: string;
  /** The item must have been observed after the item the labelled expectation matched (any end). */
  after?: string;
  timeoutMs?: number;
}

export type ScenarioStep =
  | { emit: EmitStep }
  | { clock: { advanceMs: number } }
  | { fault: { restart: true } }
  | { harness: { transcript: string; gate?: string[] } | { release: string } }
  | { expect: Expectation }
  | { note: string };

export interface Scenario {
  /** Where it was read from (relative transcript paths resolve against its directory). */
  file?: string;
  header: ScenarioHeader;
  steps: { line: number; step: ScenarioStep }[];
}

/** The config every scenario's kernel starts from: the owner `fake:alice`, local clients as `me`. */
export const REFERENCE_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({ policy: { owners: ['fake:alice'] }, local: { principal: 'me' } });

const ID = /^[A-Z]{2}-\d+[a-z]?$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function only(o: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${where}: unknown ${extra.join(', ')}`);
}

function checkHeader(v: unknown, where: string): ScenarioHeader {
  if (!isObject(v) || typeof v.scenario !== 'string') throw new Error(`${where}: line 1 must be the header {"scenario", "description", "invariants"}`);
  only(v, ['scenario', 'description', 'invariants', 'config', 'timeoutMs'], `${where}: header`);
  if (!v.scenario.trim()) throw new Error(`${where}: header: scenario must be a name`);
  if (typeof v.description !== 'string' || v.description.trim().length < 10) throw new Error(`${where}: header: description must say what it shows`);
  if (!Array.isArray(v.invariants) || !v.invariants.length || !v.invariants.every((i) => typeof i === 'string' && ID.test(i))) throw new Error(`${where}: header: invariants must be a non-empty list of ids like "IN-1"`);
  if (v.config !== undefined && !isObject(v.config)) throw new Error(`${where}: header: config must be an object`);
  if (v.timeoutMs !== undefined && !(Number.isInteger(v.timeoutMs) && (v.timeoutMs as number) > 0)) throw new Error(`${where}: header: timeoutMs must be a positive integer`);
  return v as unknown as ScenarioHeader;
}

function checkStep(v: unknown, where: string): ScenarioStep {
  if (!isObject(v) || Object.keys(v).length !== 1) throw new Error(`${where}: a line is one of {"emit"}, {"clock"}, {"fault"}, {"harness"}, {"expect"}, {"note"}`);
  const [kind, body] = Object.entries(v)[0]!;
  const w = `${where}: ${kind}`;
  switch (kind) {
    case 'note':
      if (typeof body !== 'string') throw new Error(`${w} must be a string`);
      return v as ScenarioStep;
    case 'clock':
      if (!isObject(body) || !Number.isInteger(body.advanceMs) || (body.advanceMs as number) < 0) throw new Error(`${w}: advanceMs must be a non-negative integer`);
      only(body, ['advanceMs'], w);
      return v as ScenarioStep;
    case 'fault':
      if (!isObject(body) || body.restart !== true) throw new Error(`${w}: the only fault is {"restart": true}`);
      only(body, ['restart'], w);
      return v as ScenarioStep;
    case 'harness':
      if (!isObject(body)) throw new Error(`${w} must be an object`);
      if (typeof body.release === 'string') only(body, ['release'], w);
      else {
        if (typeof body.transcript !== 'string') throw new Error(`${w}: needs transcript (a path) or release (a gate label)`);
        if (body.gate !== undefined && !(Array.isArray(body.gate) && body.gate.every((g) => typeof g === 'string' && g))) throw new Error(`${w}: gate must be a list of labels`);
        only(body, ['transcript', 'gate'], w);
      }
      return v as ScenarioStep;
    case 'emit': {
      if (!isObject(body) || !(['channel', 'client', 'host', 'log'] as unknown[]).includes(body.end)) throw new Error(`${w}: end must be channel, client, host or log`);
      if (body.end === 'log') {
        only(body, ['end', 'session', 'event'], w);
        if (!isObject(body.event) || !isObject(body.event.body)) throw new Error(`${w}: event must be a session event with a body`);
      } else if (body.end === 'channel') {
        only(body, ['end', 'frame'], w);
        if (!isObject(body.frame) || body.frame.type !== 'inbound' || !isObject(body.frame.envelope)) throw new Error(`${w}: a channel frame is {"type": "inbound", "envelope": {…}}`);
      } else {
        only(body, ['end', 'conn', 'frame'], w);
        if (!isObject(body.frame) || typeof body.frame.type !== 'string') throw new Error(`${w}: frame must be a frame with a type`);
      }
      if (body.session !== undefined && typeof body.session !== 'string') throw new Error(`${w}: session must be a string`);
      if (body.conn !== undefined && typeof body.conn !== 'string') throw new Error(`${w}: conn must be a string`);
      return v as ScenarioStep;
    }
    case 'expect': {
      if (!isObject(body) || !(SCENARIO_ENDS as readonly unknown[]).includes(body.end)) throw new Error(`${w}: end must be one of ${SCENARIO_ENDS.join(', ')}`);
      only(body, ['end', 'conn', 'session', 'match', 'none', 'until', 'gapless', 'exact', 'next', 'label', 'after', 'timeoutMs'], w);
      const what = ['match', 'none', 'gapless'].filter((k) => k in body);
      if (what.length !== 1) throw new Error(`${w}: needs exactly one of match, none, gapless`);
      if ('gapless' in body && (body.gapless !== true || !['log', 'client', 'host'].includes(body.end as string))) throw new Error(`${w}: gapless is true, at the log, client or host end`);
      if ('gapless' in body && body.end !== 'log' && typeof body.session !== 'string') throw new Error(`${w}: gapless at a connection names the session`);
      if (body.end === 'attention' && !('match' in body)) throw new Error(`${w}: the attention end takes match`);
      if ((body.end === 'log' || body.end === 'attention') && body.conn !== undefined) throw new Error(`${w}: conn is for client and host`);
      if (body.session !== undefined && (body.end === 'channel' || ((body.end === 'client' || body.end === 'host') && !('gapless' in body)))) throw new Error(`${w}: session is for log and attention (and gapless at a connection)`);
      if (body.until !== undefined && !('none' in body)) throw new Error(`${w}: until is for none`);
      if ('none' in body && (body.next !== undefined || body.label !== undefined || body.after !== undefined)) throw new Error(`${w}: none takes no next, label or after`);
      for (const k of ['conn', 'session', 'label', 'after', 'until'] as const) if (body[k] !== undefined && (typeof body[k] !== 'string' || !body[k])) throw new Error(`${w}: ${k} must be a string`);
      for (const k of ['exact', 'next'] as const) if (body[k] !== undefined && typeof body[k] !== 'boolean') throw new Error(`${w}: ${k} must be a boolean`);
      if (body.timeoutMs !== undefined && !(Number.isInteger(body.timeoutMs) && (body.timeoutMs as number) > 0)) throw new Error(`${w}: timeoutMs must be a positive integer`);
      return v as ScenarioStep;
    }
    default:
      throw new Error(`${where}: unknown line kind ${JSON.stringify(kind)}`);
  }
}

/** Parses a scenario's NDJSON (`where` names it in errors). Throws on anything that is not one. */
export function parseScenario(text: string, where = 'scenario'): Scenario {
  const lines = text.split('\n');
  let header: ScenarioHeader | undefined;
  const steps: Scenario['steps'] = [];
  const labels = new Set<string>();
  const untils: { label: string; at: string }[] = [];
  for (const [i, raw] of lines.entries()) {
    const l = raw.trim();
    if (!l) continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch (e) {
      throw new Error(`${where}:${i + 1}: not JSON (${(e as Error).message})`);
    }
    if (!header) {
      header = checkHeader(v, `${where}:${i + 1}`);
      continue;
    }
    const step = checkStep(v, `${where}:${i + 1}`);
    if ('expect' in step) {
      if (step.expect.after !== undefined && !labels.has(step.expect.after)) throw new Error(`${where}:${i + 1}: expect after ${JSON.stringify(step.expect.after)}: no earlier expectation has that label`);
      if (step.expect.label !== undefined) {
        if (labels.has(step.expect.label)) throw new Error(`${where}:${i + 1}: label ${JSON.stringify(step.expect.label)} is used twice`);
        labels.add(step.expect.label);
      }
      if (step.expect.until !== undefined) untils.push({ label: step.expect.until, at: `${where}:${i + 1}` });
    }
    steps.push({ line: i + 1, step });
  }
  if (!header) throw new Error(`${where}: empty`);
  for (const u of untils) if (!labels.has(u.label)) throw new Error(`${u.at}: expect until ${JSON.stringify(u.label)}: no expectation has that label`);
  return { header, steps };
}

export function readScenario(path: string): Scenario {
  return { ...parseScenario(readFileSync(path, 'utf8'), path), file: path };
}

/** The `.ndjson` scenarios in `dir` (not below it), sorted. */
export function scenarioFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
    .map((f) => join(dir, f));
}

// ---- running ------------------------------------------------------------------

/** What a driver's kernel offers the runner. */
export interface ScenarioKernel {
  /** The local client socket (client and host ends). */
  socketPath?: string;
  /** The host token (`host.hello`). */
  token?: string;
  /** The session's durable events, in seq order. */
  log(sessionKey: string): readonly unknown[];
  /** The session's attention projection now. */
  attention?(sessionKey: string): unknown;
  /** Appends an event to the session's log (the `log` end's emit: what the log stamps is left out). */
  append?(sessionKey: string, event: Record<string, unknown>): void;
  stop(): Promise<void>;
}

export interface ScenarioStart {
  /** The kernel's data directory: the same across restarts. */
  dir: string;
  /** `REFERENCE_CONFIG` with the header's `config` over it (the driver adds paths). */
  config: Record<string, unknown>;
  /**
   * The reference harness, or the transcript's in-process replay (`TranscriptHarness`). Undefined
   * when the driver plays transcripts itself (`playsTranscripts`) and there is one: see `transcript`.
   */
  harness: HarnessAdapter | undefined;
  /** The harness transcript this start plays (`harness{transcript}`), with its gates. */
  transcript?: { path: string; gate: readonly string[] };
  /** The reference channel (`fake`): the only channel. */
  channel: ChannelAdapter;
  /** 0 for the first start, then one more per `fault{restart}`. */
  restart: number;
}

export interface ScenarioDriver {
  start(o: ScenarioStart): Promise<ScenarioKernel>;
  /**
   * The driver plays `ScenarioStart.transcript` itself (e.g. `aio-transcript-replay` as a bridge
   * program): the runner makes no `TranscriptHarness`, cannot release gates (a scenario with gates
   * fails), and does not check the replay (the driver does).
   */
  playsTranscripts?: boolean;
  /** Moves the kernel's clock on; without it the runner waits that long. */
  advanceClock?(ms: number): Promise<void>;
}

export interface RunScenarioOptions {
  /** The data directory (default a fresh temp one, removed afterwards). */
  dir?: string;
  /** Default wait of each expectation (the header's wins), ms. Default 5000. */
  timeoutMs?: number;
  /** How long the end waits before checking what must not have happened, ms. Default 150. */
  settleMs?: number;
  /** Every item as it is observed (debugging a scenario). */
  trace?: (end: string, item: unknown) => void;
}

export class ScenarioError extends Error {
  override name = 'ScenarioError';
}

interface Item {
  value: unknown;
  /** Observation order across every end. */
  stamp: number;
}

class Stream {
  readonly items: Item[] = [];
  cursor = 0;
  /** `none` expectations, checked at the end. */
  readonly nones: { pattern: unknown; from: number; at: string; exact: boolean; until?: string }[] = [];
  constructor(readonly name: string) {}
}

/** The reference channel: testkit's FakeChannel, its calls recorded as channel bridge frames. */
class RecordingChannel extends FakeChannel {
  constructor(private readonly record: (frame: Record<string, unknown>) => void) {
    super('fake');
  }
  override async send(route: ReplyRoute, msg: RenderedMessage, op: SendOp) {
    this.record({ type: 'send', route, msg, op });
    return super.send(route, msg, op);
  }
  override async edit(route: ReplyRoute, providerMessageId: string, msg: RenderedMessage, op?: SendOp & { sequence: number }) {
    this.record({ type: 'edit', route, providerMessageId, msg, ...(op ? { op } : {}) });
    return super.edit(route, providerMessageId, msg);
  }
  override async finalize(route: ReplyRoute, providerMessageId: string, msg: RenderedMessage) {
    this.record({ type: 'finalize', route, providerMessageId, msg });
    return super.finalize(route, providerMessageId, msg);
  }
  override async acknowledge(route: ReplyRoute, messageId: string, state: AckState) {
    this.record({ type: 'acknowledge', route, messageId, state });
    return super.acknowledge(route, messageId, state);
  }
  override async history(env: InboundEnvelope, scope: string) {
    this.record({ type: 'history', envelope: env, scope });
    return super.history(env, scope);
  }
  override async createConversation(account: string, spec: ConversationSpec) {
    this.record({ type: 'createConversation', account, spec });
    return super.createConversation(account, spec);
  }
}

interface Conn {
  socket: Socket | undefined;
  helloed: boolean;
  stream: Stream;
}

/**
 * The channel end's answers to the frames a scenario emitted there: in emit order, but not ordered
 * against the kernel's calls to the channel (on a wire their order is a matter of timing: the
 * reference harness may answer before the emit returns).
 */
const CHANNEL_RESULTS = 'channel:results';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? 'nothing' : s.length > 300 ? `${s.slice(0, 297)}...` : s;
};

class Run {
  readonly bindings: Bindings = new Map();
  private stamp = 0;
  private readonly streams = new Map<string, Stream>();
  private readonly conns = new Map<string, Conn>();
  private readonly labels = new Map<string, number>();
  private kernel: ScenarioKernel | undefined;
  private restarts = 0;
  private transcript: { t: Transcript; path: string; gate: string[] } | undefined;
  private harness: HarnessAdapter | undefined;
  private readonly replays: { h: TranscriptHarness; stopped: boolean }[] = [];
  private readonly timeoutMs: number;
  private line = '';

  constructor(
    private readonly s: Scenario,
    private readonly driver: ScenarioDriver,
    private readonly dir: string,
    private readonly o: RunScenarioOptions,
  ) {
    this.timeoutMs = s.header.timeoutMs ?? o.timeoutMs ?? 5000;
  }

  private fail(msg: string): never {
    throw new ScenarioError(`${this.line}: ${msg}`);
  }

  private stream(name: string): Stream {
    let st = this.streams.get(name);
    if (!st) this.streams.set(name, (st = new Stream(name)));
    return st;
  }

  /** Adds an item to an end, after reading the logs (so what they had before it is stamped first). */
  private push(name: string, value: unknown): void {
    this.poll();
    this.stream(name).items.push({ value, stamp: ++this.stamp });
    this.o.trace?.(name, value);
  }

  /** Reads the logs of every session an expectation named so far. */
  private poll(): void {
    if (!this.kernel) return;
    for (const [name, st] of this.streams) {
      if (!name.startsWith('log:')) continue;
      const all = this.kernel.log(name.slice(4));
      for (let i = st.items.length; i < all.length; i++) {
        st.items.push({ value: all[i], stamp: ++this.stamp });
        this.o.trace?.(name, all[i]);
      }
    }
  }

  private checkReplays(): void {
    for (const r of this.replays) if (r.h.replay.error) this.fail(`the harness transcript ${this.transcriptName(r.h)}: ${r.h.replay.error.message}`);
  }

  private transcriptName(h: TranscriptHarness): string {
    return h.replay.transcript.header.scenario;
  }

  private async ensureKernel(): Promise<ScenarioKernel> {
    if (this.kernel) return this.kernel;
    const config = { ...REFERENCE_CONFIG, ...this.s.header.config };
    const channel = new RecordingChannel((f) => this.push('channel', f));
    let harness: HarnessAdapter | undefined;
    if (this.transcript && this.driver.playsTranscripts) {
      if (this.transcript.gate.length) this.fail(`the driver plays transcripts itself, so gates (${this.transcript.gate.join(', ')}) cannot be released`);
      harness = undefined;
    } else if (this.transcript) {
      const h = new TranscriptHarness(this.transcript.t, { gates: this.transcript.gate, afterEnd: 'answer' });
      this.replays.push({ h, stopped: false });
      harness = h;
    } else harness = new FakeHarness();
    this.harness = harness;
    const transcript = this.transcript ? { transcript: { path: this.transcript.path, gate: this.transcript.gate } } : {};
    this.kernel = await this.driver.start({ dir: this.dir, config, harness, channel, restart: this.restarts, ...transcript });
    this.channel = channel;
    return this.kernel;
  }

  private channel: RecordingChannel | undefined;

  private async connect(end: 'client' | 'host', name: string): Promise<Conn> {
    const k = await this.ensureKernel();
    const key = `${end}:${name}`;
    let c = this.conns.get(key);
    if (!c) this.conns.set(key, (c = { socket: undefined, helloed: false, stream: this.stream(key) }));
    if (c.socket && !c.socket.destroyed) return c;
    if (!k.socketPath) this.fail(`the kernel has no client socket for the ${end} end`);
    const socket = await new Promise<Socket>((res, rej) => {
      const s = createConnection(k.socketPath!);
      s.once('connect', () => res(s));
      s.once('error', rej);
    }).catch((e: Error) => this.fail(`cannot connect to ${k.socketPath}: ${e.message}`));
    const decoder = new FrameDecoder();
    const conn = c;
    socket.on('data', (chunk) => {
      for (const f of decoder.push(chunk)) this.push(key, f);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (conn.socket === socket) conn.socket = undefined;
    });
    c.socket = socket;
    c.helloed = false;
    return c;
  }

  private write(c: Conn, frame: Record<string, unknown>): void {
    c.socket!.write(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }) + '\n');
  }

  private async emit(e: EmitStep): Promise<void> {
    const frame = (() => {
      try {
        return substitute('frame' in e ? e.frame : e.event, this.bindings) as Record<string, unknown>;
      } catch (err) {
        return this.fail((err as Error).message);
      }
    })();
    if (e.end === 'log') {
      const k = await this.ensureKernel();
      if (!k.append) this.fail('the kernel does not take log events (emit end log)');
      k.append(e.session ?? 's', frame);
      return;
    }
    if (e.end === 'channel') {
      await this.ensureKernel();
      const envelope = { ...(frame.envelope as Record<string, unknown>) };
      const id = frame.id;
      try {
        const r = await this.channel!.inject(envelope as Partial<InboundEnvelope> & { text?: string });
        this.push(CHANNEL_RESULTS, { type: 'result', ...(id !== undefined ? { id } : {}), ok: true, value: r });
      } catch (err) {
        const x = err as { code?: string; message?: string };
        this.push(CHANNEL_RESULTS, { type: 'result', ...(id !== undefined ? { id } : {}), ok: false, error: { code: x.code ?? 'error', message: x.message ?? String(err) } });
      }
      return;
    }
    const name = e.conn ?? e.end;
    const c = await this.connect(e.end, name);
    if (e.end === 'host' && !c.helloed) {
      if (frame.type !== 'host.hello') this.write(c, { type: 'host.hello', id: `hello-${name}`, token: this.kernel!.token, name });
      c.helloed = true;
    }
    if (frame.type === 'host.hello' && frame.token === undefined) frame.token = this.kernel!.token;
    this.write(c, frame);
  }

  private streamOf(x: Expectation): Stream {
    if (x.end === 'log') return this.stream(`log:${x.session ?? 's'}`);
    if (x.end === 'channel') {
      // The answers to emitted frames are a stream of their own (`CHANNEL_RESULTS`).
      const p = (x.match ?? x.none) as { type?: unknown } | undefined;
      return this.stream(p && typeof p === 'object' && p.type === 'result' ? CHANNEL_RESULTS : 'channel');
    }
    return this.stream(`${x.end}:${x.conn ?? x.end}`);
  }

  /** An item of `st` in the none's window that matches its pattern (with the bindings as they are: a none binds nothing). */
  private violation(st: Stream, n: Stream['nones'][number]): string | undefined {
    const until = n.until !== undefined ? this.labels.get(n.until) : undefined;
    if (n.until !== undefined && until === undefined) return `${n.at}: until ${n.until}: that expectation never matched`;
    for (let i = n.from; i < st.items.length; i++) {
      const it = st.items[i]!;
      if (until !== undefined && it.stamp >= until) break;
      if (match(n.pattern, it.value, new Map(this.bindings), { exact: n.exact }) === undefined) return `${n.at}: expected no ${show(n.pattern)} at ${st.name}${n.until ? ` until ${n.until}` : ''}, got ${show(it.value)}`;
    }
    return undefined;
  }

  private async expect(x: Expectation): Promise<void> {
    const timeout = x.timeoutMs ?? this.timeoutMs;
    await this.ensureKernel();
    if (x.end === 'attention') {
      const k = this.kernel!;
      if (!k.attention) this.fail('the kernel has no attention end');
      const deadline = Date.now() + timeout;
      let why: string | undefined;
      for (;;) {
        this.checkReplays();
        const trial = new Map(this.bindings);
        why = match(x.match, k.attention(x.session ?? 's'), trial, { exact: x.exact ?? false });
        if (why === undefined) {
          for (const [n, v] of trial) this.bindings.set(n, v);
          return;
        }
        if (Date.now() > deadline) this.fail(`attention of ${x.session ?? 's'}: ${why}`);
        await sleep(5);
      }
    }
    const st = this.streamOf(x);
    if (x.gapless) {
      this.poll();
      if (x.end === 'log') {
        const seqs = this.kernel!.log(x.session ?? 's').map((e) => (e as { seq?: unknown }).seq);
        if (seqs.some((q, i) => q !== i + 1)) this.fail(`the log of ${x.session ?? 's'} is not gapless from 1: seqs ${show(seqs)}`);
        return;
      }
      const seqs = st.items.flatMap(({ value: f }) => {
        const e = (f as { type?: unknown; event?: { sessionKey?: unknown; durability?: unknown; seq?: unknown } }).event;
        return (f as { type?: unknown }).type === 'event' && e && e.sessionKey === x.session && e.durability === 'durable' ? [e.seq] : [];
      });
      if (seqs.some((q, i) => i > 0 && q !== (seqs[i - 1] as number) + 1)) this.fail(`the durable events of ${x.session} at ${st.name} are not consecutive: seqs ${show(seqs)}`);
      return;
    }
    if ('none' in x) {
      st.nones.push({ pattern: x.none, from: st.cursor, at: this.line, exact: x.exact ?? false, ...(x.until !== undefined ? { until: x.until } : {}) });
      return;
    }
    const after = x.after !== undefined ? this.labels.get(x.after)! : -1;
    const deadline = Date.now() + timeout;
    for (;;) {
      this.poll();
      this.checkReplays();
      for (let i = st.cursor; i < st.items.length; i++) {
        const it = st.items[i]!;
        const trial = new Map(this.bindings);
        if (it.stamp > after && match(x.match, it.value, trial, { exact: x.exact ?? false }) === undefined) {
          for (const [n, v] of trial) this.bindings.set(n, v);
          st.cursor = i + 1;
          if (x.label !== undefined) this.labels.set(x.label, it.stamp);
          return;
        }
        if (x.next) break;
      }
      if (Date.now() > deadline) {
        const seen = st.items.slice(st.cursor);
        const reasons = seen.slice(-8).map((it) => `  ${show(it.value)}\n    ${match(x.match, it.value, new Map(this.bindings), { exact: x.exact ?? false }) ?? (it.stamp <= after ? `observed before ${x.after}` : 'matches')}`);
        this.fail(`expected at ${st.name}${x.next ? ' (next)' : ''}${x.after ? ` after ${x.after}` : ''}: ${show(x.match)}\n` + (seen.length ? `got (${seen.length} since the last match, the last ${reasons.length} shown):\n${reasons.join('\n')}` : 'got nothing since the last match'));
      }
      await sleep(5);
    }
  }

  private async restart(): Promise<void> {
    await this.ensureKernel();
    await this.stopKernel();
    this.restarts++;
    await this.ensureKernel();
  }

  private async stopKernel(): Promise<void> {
    const k = this.kernel;
    if (!k) return;
    this.poll();
    for (const c of this.conns.values()) {
      c.socket?.destroy();
      c.socket = undefined;
      c.helloed = false;
    }
    // What a transcript got wrong before the stop counts; its teardown does not (the harness is halted first).
    this.checkReplays();
    for (const r of this.replays) {
      r.stopped = true;
      r.h.halt();
    }
    this.kernel = undefined;
    this.channel = undefined;
    await k.stop();
  }

  async run(): Promise<void> {
    const where = this.s.file ?? this.s.header.scenario;
    try {
      for (const { line, step } of this.s.steps) {
        this.line = `${where}:${line}`;
        if ('note' in step) continue;
        if ('harness' in step) {
          const h = step.harness;
          if ('release' in h) {
            const cur = this.harness instanceof TranscriptHarness ? this.harness : undefined;
            if (!cur) this.fail(`release ${h.release}: the running harness plays no transcript here`);
            cur.replay.release(h.release);
          } else {
            const path = this.s.file ? resolve(dirname(this.s.file), h.transcript) : h.transcript;
            this.transcript = { t: readTranscript(path), path, gate: h.gate ?? [] };
          }
          continue;
        }
        if ('clock' in step) {
          await this.ensureKernel();
          if (this.driver.advanceClock) await this.driver.advanceClock(step.clock.advanceMs);
          else await sleep(step.clock.advanceMs);
          continue;
        }
        if ('fault' in step) {
          await this.restart();
          continue;
        }
        if ('emit' in step) {
          await this.emit(step.emit);
          continue;
        }
        await this.expect(step.expect);
      }
      this.line = `${where}: at the end`;
      await this.ensureKernel();
      await sleep(this.o.settleMs ?? 150);
      this.poll();
      this.checkReplays();
      for (const st of this.streams.values()) {
        for (const n of st.nones) {
          const v = this.violation(st, n);
          if (v) throw new ScenarioError(v);
        }
      }
      for (const r of this.replays) {
        if (!r.stopped && !r.h.replay.done) this.fail(`the harness transcript ${this.transcriptName(r.h)} was not played to its end: it waits at its line ${r.h.replay.line}`);
      }
    } finally {
      await this.stopKernel().catch(() => undefined);
    }
  }
}

/** Plays a scenario against the kernel `driver` starts. Throws `ScenarioError` saying the line and why. */
export async function runScenario(scenario: Scenario | string, driver: ScenarioDriver, o: RunScenarioOptions = {}): Promise<{ bindings: Bindings }> {
  const s = typeof scenario === 'string' ? readScenario(scenario) : scenario;
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'aio-scenario-'));
  const run = new Run(s, driver, dir, o);
  try {
    await run.run();
  } finally {
    if (!o.dir) rmSync(dir, { recursive: true, force: true });
  }
  return { bindings: run.bindings };
}
