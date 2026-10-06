import type { Readable, Writable } from 'node:stream';
import {
  ChannelHostFrame,
  PROTOCOL_VERSION,
  check,
  errors,
  type ChannelAdapter,
  type ChannelContext,
  type ChannelHello,
} from '@agents-io/protocol';
import { FrameLink, isObject } from './link.js';

export interface ServeOptions {
  input?: Readable;
  output?: Writable;
}

const HOST_FRAME_TYPES = new Set([
  'hello', 'send', 'edit', 'finalize', 'retract', 'speak', 'typing', 'reconcile', 'result', 'shutdown',
]);
const OPTIONAL_METHODS = ['edit', 'finalize', 'retract', 'speak', 'typing', 'reconcile'] as const;

/**
 * Serve an in-process adapter as a JSONL process: answers `hello`, runs
 * `adapter.start` with a context whose `emit` sends `inbound` frames, and
 * dispatches host requests to the adapter's methods. Resolves after `shutdown`
 * or when the input ends; rejects if `adapter.start` throws.
 *
 * stdout is the protocol channel: adapters must log through `ctx.log`, never `console.log`.
 */
export function serveChannel(adapter: ChannelAdapter, opts: ServeOptions = {}): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  return new Promise<void>((resolve, reject) => {
    const ctl = new AbortController();
    const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
    let account: string | undefined;
    let running: Promise<void> | undefined;
    let nextId = 0;
    let finished = false;

    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true;
      ctl.abort();
      for (const p of pending.values()) p.reject(new Error('host connection closed'));
      pending.clear();
      // Release stdin so a served process can exit; sockets are closed by the peer's end.
      input.destroy();
      if (output !== process.stdout && output !== input) output.end();
      void Promise.resolve(running).then(
        () => (err ? reject(err) : resolve()),
        (e) => reject(err ?? e),
      );
    };

    const link = new FrameLink(
      input,
      output,
      (raw) => onFrame(raw),
      (line) => log('warn', 'dropping malformed line from host', { line: line.slice(0, 200) }),
      () => finish(),
    );

    function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) {
      link.send({ v: PROTOCOL_VERSION, type: 'log', level, msg, data });
    }

    const reply = (id: string, ok: boolean, value?: unknown, error?: { code: string; message: string; retryable?: boolean }) =>
      link.send({ v: PROTOCOL_VERSION, type: 'result', id, ok, value, error });

    const ctxFor = (acct: string, config: unknown): ChannelContext => ({
      account: acct,
      config,
      signal: ctl.signal,
      log,
      emit: (envelope) =>
        new Promise((res, rej) => {
          const id = `a${++nextId}`;
          pending.set(id, {
            resolve: (v) => {
              if (isObject(v) && typeof v.accepted === 'boolean') res(v as { accepted: boolean; inputId?: string });
              else rej(new Error('host returned a malformed inbound result'));
            },
            reject: rej,
          });
          if (!link.send({ v: PROTOCOL_VERSION, type: 'inbound', id, envelope })) {
            pending.delete(id);
            rej(new Error('host connection closed'));
          }
        }),
    });

    function onFrame(raw: unknown) {
      if (!isObject(raw) || typeof raw.type !== 'string') return log('warn', 'dropping frame without a type');
      if (!HOST_FRAME_TYPES.has(raw.type)) return log('debug', `ignoring unknown frame type ${raw.type}`);
      if (!check(ChannelHostFrame, raw)) {
        log('warn', `dropping invalid ${raw.type} frame`, { errors: errors(ChannelHostFrame, raw).slice(0, 3) });
        if (typeof raw.id === 'string' && raw.type !== 'result')
          reply(raw.id, false, undefined, { code: 'invalid_frame', message: `${raw.type} frame failed validation`, retryable: false });
        return;
      }
      if (raw.type === 'shutdown') return finish();
      if (raw.type === 'result') {
        const p = pending.get(raw.id);
        if (!p) return;
        pending.delete(raw.id);
        if (raw.ok) p.resolve(raw.value);
        else p.reject(new Error(raw.error?.message ?? 'host rejected inbound'));
        return;
      }
      const id = raw.id;
      if (raw.type === 'hello') {
        // A repeated hello re-answers but never restarts the adapter.
        account ??= raw.account;
        const hello: ChannelHello = {
          adapterId: adapter.id,
          caps: adapter.caps(raw.account),
          methods: OPTIONAL_METHODS.filter((m) => typeof adapter[m] === 'function'),
        };
        reply(id, true, hello);
        if (!running) {
          running = adapter.start(ctxFor(raw.account, raw.config));
          running.catch((err) => {
            log('error', `adapter.start failed: ${err instanceof Error ? err.message : String(err)}`);
            finish(err);
          });
        }
        return;
      }
      if (!account) return void reply(id, false, undefined, { code: 'no_hello', message: 'hello must come first', retryable: true });
      void dispatch(raw).then(
        (value) => reply(id, true, value),
        (err: unknown) =>
          reply(id, false, undefined, {
            code: typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'adapter_error',
            message: err instanceof Error ? err.message : String(err),
            retryable: (err as { retryable?: unknown })?.retryable === true,
          }),
      );
    }

    async function dispatch(f: Exclude<ChannelHostFrame, { type: 'hello' | 'result' | 'shutdown' }>): Promise<unknown> {
      const method = (name: (typeof OPTIONAL_METHODS)[number]) => {
        const fn = adapter[name];
        if (!fn) throw Object.assign(new Error(`adapter does not implement ${name}`), { code: 'unsupported' });
        return fn.bind(adapter) as (...a: never[]) => Promise<unknown>;
      };
      switch (f.type) {
        case 'send':
          return adapter.send(f.route, f.msg, f.op);
        case 'edit':
          return method('edit')(...([f.route, f.providerMessageId, f.msg, f.op] as never[]));
        case 'finalize':
          return method('finalize')(...([f.route, f.providerMessageId, f.msg] as never[]));
        case 'retract':
          return method('retract')(...([f.route, f.providerMessageId, f.outcome] as never[]));
        case 'speak':
          return method('speak')(...([f.route, f.utterance] as never[]));
        case 'typing':
          return method('typing')(...([f.route, f.on] as never[]));
        case 'reconcile':
          return method('reconcile')(...([f.route, f.providerMessageId] as never[]));
      }
    }
  });
}
