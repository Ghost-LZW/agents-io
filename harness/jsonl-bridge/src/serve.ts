import type { Readable, Writable } from 'node:stream';
import {
  BlobBytes,
  BlobStat,
  HARNESS_DECLARATION_KEYS,
  HARNESS_HOST_FRAME_TYPES,
  HarnessHostFrame,
  PROTOCOL_VERSION,
  check,
  errors,
  type BlobAccess,
  type HarnessAdapter,
  type HarnessDeclares,
  type HarnessSession,
  type ProbeResult,
} from '@agents-io/protocol';
import { FrameLink, isObject, wireError } from './link.js';

/*
 * The program side of the harness bridge: serve an in-process `HarnessAdapter` as a JSONL program
 * on stdio, for the host's `bridge` harness kind (`spawnHarness`). What the adapter declares
 * statically and whether it has `detach` go into its answer to `probe`; its sessions' events go
 * out as `event` frames, its native ids as `nativeId` frames (with `nativeClient`'s command). A
 * program in another language speaks the same frames (`HarnessHostFrame` / `HarnessAdapterFrame`).
 */

/** What a served harness's factory gets (as `HarnessFactoryInit` for an in-process one). */
export interface ServedHarnessInit {
  /** The instance this program serves (`harnesses.<name>`), when the host says. */
  instance?: string;
  /** The instance entry's `config`, `"env:NAME"` values substituted; `undefined` when absent. */
  config: unknown;
  /** The host's blob store, read-only, over the connection (`blob.stat` / `blob.get`); absent when the host has no such frames. */
  blobs?: BlobAccess;
  /** To the host's log (a `log` frame). stdout is the protocol: never write to it. */
  log(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown): void;
}

export interface ServeHarnessOptions {
  input?: Readable;
  output?: Writable;
}

const HOST_FRAME_TYPES = new Set<string>(HARNESS_HOST_FRAME_TYPES);

/** What an adapter declares statically, as `ProbeResult.declares`. */
function declaresOf(a: HarnessAdapter): HarnessDeclares {
  return Object.fromEntries(HARNESS_DECLARATION_KEYS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) as HarnessDeclares;
}

interface Served {
  session: HarnessSession;
  generation: number;
  /** The native id last sent (`nativeId` frame). */
  native: string | undefined;
  /** Forwards the session's events; settles when they end. */
  pump: Promise<void>;
  /** The host closed it: its end is no news (`closed` is not sent). */
  closing: boolean;
}

/**
 * Serve a harness adapter (or the factory of one, called at the first `probe`) as a JSONL program:
 * answers `probe` with its caps and declarations, opens sessions and dispatches their requests,
 * forwards their events, detaches at `detach` and disposes at `shutdown` (closing what is still
 * open, unless it detached). Resolves after `shutdown` or when the input ends; rejects when the
 * factory throws.
 *
 * stdout is the protocol channel: the adapter must log through `init.log`, never `console.log`.
 */
export function serveHarness(harness: HarnessAdapter | ((init: ServedHarnessInit) => HarnessAdapter | Promise<HarnessAdapter>), opts: ServeHarnessOptions = {}): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  return new Promise<void>((resolve, reject) => {
    const sessions = new Map<string, Served>();
    const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
    let adapter: Promise<HarnessAdapter> | undefined;
    let detached = false;
    let finished = false;
    let nextId = 0;

    const link = new FrameLink(
      input,
      output,
      (raw) => onFrame(raw),
      (line) => log('warn', 'dropping malformed line from host', { line: line.slice(0, 200) }),
      () => void finish(),
    );

    function log(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) {
      link.send({ v: PROTOCOL_VERSION, type: 'log', level, msg, ...(data !== undefined ? { data } : {}) });
    }

    const reply = (id: string, ok: boolean, value?: unknown, error?: { code: string; message: string; retryable?: boolean }) =>
      link.send({ v: PROTOCOL_VERSION, type: 'result', id, ok, ...(ok ? { value: value ?? null } : { error }) });

    /** A request to the host (`blob.stat` / `blob.get`). */
    const ask = (type: string, body: Record<string, unknown>) =>
      new Promise<unknown>((res, rej) => {
        const id = `a${++nextId}`;
        pending.set(id, { resolve: res, reject: rej });
        if (!link.send({ v: PROTOCOL_VERSION, type, id, ...body })) {
          pending.delete(id);
          rej(new Error('host connection closed'));
        }
      });

    const blobs: BlobAccess = {
      stat: async (ref) => {
        const v = await ask('blob.stat', { ref });
        if (v === null || v === undefined) return undefined;
        if (!check(BlobStat, v)) throw new Error(`blob.stat answered ${errors(BlobStat, v).slice(0, 3).join('; ')}`);
        return v;
      },
      get: async (ref) => {
        const v = await ask('blob.get', { ref });
        if (!check(BlobBytes, v)) throw new Error(`blob.get answered ${errors(BlobBytes, v).slice(0, 3).join('; ')}`);
        return { bytes: new Uint8Array(Buffer.from(v.base64, 'base64')), mime: v.mime, ...(v.name !== undefined ? { name: v.name } : {}) };
      },
    };

    async function finish(err?: unknown): Promise<void> {
      if (finished) return;
      finished = true;
      for (const p of pending.values()) p.reject(new Error('host connection closed'));
      pending.clear();
      // Detached: what it runs carries on for the next host. Otherwise it stops (`dispose`).
      if (!detached && adapter) {
        const a = await adapter.catch(() => undefined);
        await Promise.all([...sessions.values()].map((s) => ((s.closing = true), s.session.close('shutdown').catch(() => undefined))));
        if (a && typeof a.dispose === 'function') await a.dispose().catch(() => undefined);
      }
      // Release stdin so a served process can exit; sockets are closed by the peer's end.
      input.destroy();
      if (output !== process.stdout && output !== input) output.end();
      if (err) reject(err);
      else resolve();
    }

    function onFrame(raw: unknown) {
      if (!isObject(raw) || typeof raw.type !== 'string') return log('warn', 'dropping frame without a type');
      if (!HOST_FRAME_TYPES.has(raw.type)) return log('debug', `ignoring unknown frame type ${raw.type}`);
      if (!check(HarnessHostFrame, raw)) {
        log('warn', `dropping invalid ${raw.type} frame`, { errors: errors(HarnessHostFrame, raw).slice(0, 3) });
        if (typeof raw.id === 'string' && raw.type !== 'result') reply(raw.id, false, undefined, { code: 'invalid_frame', message: `${raw.type} frame failed validation`, retryable: false });
        return;
      }
      const f = raw as HarnessHostFrame;
      if (f.type === 'shutdown') return void finish();
      if (f.type === 'result') {
        const p = pending.get(f.id);
        if (!p) return;
        pending.delete(f.id);
        if (f.ok) p.resolve(f.value);
        else p.reject(Object.assign(new Error(f.error?.message ?? 'host refused'), { code: f.error?.code }));
        return;
      }
      void dispatch(f).then(
        (value) => reply(f.id, true, value),
        (err: unknown) => reply(f.id, false, undefined, wireError(err, 'adapter_error')),
      );
    }

    function served(key: string): Served {
      const s = sessions.get(key);
      if (!s) throw Object.assign(new Error(`no open session ${key}`), { code: 'unknown_session' });
      return s;
    }

    /** Forward a session's events, and its native id whenever it changes; `closed` when it ends by itself. */
    async function pump(key: string, sv: Served, a: HarnessAdapter): Promise<void> {
      const nativeOf = () => {
        const n = sv.session.nativeId();
        if (n === undefined || n === sv.native) return;
        sv.native = n;
        const client = a.nativeClient?.(n);
        link.send({ v: PROTOCOL_VERSION, type: 'nativeId', sessionKey: key, nativeId: n, ...(client ? { client } : {}) });
      };
      try {
        for await (const event of sv.session.events) {
          if (detached) break;
          nativeOf();
          link.send({ v: PROTOCOL_VERSION, type: 'event', sessionKey: key, generation: sv.generation, event });
        }
        if (!detached) nativeOf();
      } catch (err) {
        log('error', `session ${key}: events failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!sv.closing && !detached && sessions.get(key) === sv) {
        sessions.delete(key);
        link.send({ v: PROTOCOL_VERSION, type: 'closed', sessionKey: key, generation: sv.generation });
      }
    }

    async function dispatch(f: Exclude<HarnessHostFrame, { type: 'result' | 'shutdown' }>): Promise<unknown> {
      if (f.type === 'probe') {
        adapter ??= (async () => {
          if (typeof harness !== 'function') return harness;
          const features = new Set(f.features ?? []);
          return harness({ ...(f.instance !== undefined ? { instance: f.instance } : {}), config: f.config, ...(features.has('blobs') ? { blobs } : {}), log });
        })();
        const a = await adapter.catch((err: unknown) => {
          log('fatal', `the harness could not be made: ${err instanceof Error ? err.message : String(err)}`);
          void finish(err);
          throw err;
        });
        const p = await a.probe();
        const hello: ProbeResult = { version: p.version, caps: p.caps, declares: declaresOf(a), methods: typeof a.detach === 'function' ? ['detach'] : [] };
        return hello;
      }
      if (!adapter) throw Object.assign(new Error('probe must come first'), { code: 'no_probe', retryable: true });
      const a = await adapter;
      switch (f.type) {
        case 'open': {
          const { v: _v, type: _t, id: _id, ...args } = f;
          // A newer open of a key replaces an older one.
          const old = sessions.get(f.sessionKey);
          if (old) {
            old.closing = true;
            sessions.delete(f.sessionKey);
            await old.session.close('replaced by a newer open').catch(() => undefined);
          }
          const session = await a.open(args);
          const sv: Served = { session, generation: f.generation, native: undefined, closing: false, pump: Promise.resolve() };
          sessions.set(f.sessionKey, sv);
          sv.pump = pump(f.sessionKey, sv, a);
          // What the session queued while opening (a `turn.adopted`) goes out before the answer.
          await new Promise((r) => setImmediate(r));
          const nativeId = session.nativeId();
          if (nativeId === undefined) return {};
          sv.native = nativeId;
          const client = a.nativeClient?.(nativeId);
          return { nativeId, ...(client ? { client } : {}) };
        }
        case 'startTurn':
          return served(f.sessionKey).session.startTurn(f.turnId, f.inputs, f.run);
        case 'steer':
          return served(f.sessionKey).session.steer(f.inputs, f.expectedTurnId);
        case 'cancelQueued': {
          const s = served(f.sessionKey).session;
          if (!s.cancelQueued) throw Object.assign(new Error('the session has no cancelQueued'), { code: 'unsupported' });
          return s.cancelQueued(f.inputIds);
        }
        case 'inject': {
          const s = served(f.sessionKey).session;
          if (!s.inject) throw Object.assign(new Error('the session has no inject'), { code: 'unsupported' });
          return s.inject(f.inputs);
        }
        case 'interrupt':
          return served(f.sessionKey).session.interrupt(f.turnId);
        case 'respond':
          return served(f.sessionKey).session.respond(f.requestId, f.decision);
        case 'close': {
          const sv = sessions.get(f.sessionKey);
          if (!sv) return undefined;
          sv.closing = true;
          sessions.delete(f.sessionKey);
          await sv.session.close(f.reason);
          // Its last events go out before the answer.
          await Promise.race([sv.pump, new Promise((r) => setTimeout(r, 5000))]);
          return undefined;
        }
        case 'detach': {
          if (typeof a.detach !== 'function') throw Object.assign(new Error('the harness has no detach'), { code: 'unsupported' });
          detached = true;
          await a.detach();
          return undefined;
        }
      }
    }
  });
}
