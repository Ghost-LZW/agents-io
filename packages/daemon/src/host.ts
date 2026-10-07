import { timingSafeEqual } from 'node:crypto';
import { PROTOCOL_VERSION, type HostHelloResult, type HostRequestFrame, type InboundReadResult, type InboundEnvelope, type InputRecord, type Origin } from '@agents-io/protocol';
import { RouterError, type CalloutAnswer, type HostQueue, type PushSubscription, type Router } from '@agents-io/session';
import type { LogFn, Outcome } from './gateway.js';
import type { HostFrames, Peer } from './local-server.js';
import type { DaemonRecords } from './records.js';
import type { Runs } from './runs.js';

/*
 * The host side of the local socket (docs/HOSTS.md §4). Every host frame needs
 * `host.hello` with the daemon's token first. Any number of authenticated
 * connections may use the request frames (the CLI's `aio run`, `aio tail`,
 * `aio send` are such connections); a connection becomes THE host — at most one
 * at a time — when its hello asks to push-consume the inbound queue (`consumer`)
 * or to answer callouts (`callouts: true`). While the host is connected the
 * router's host table is active even with `onHostDown: "suspend"`, callouts go to
 * it, and runs whose own connection is gone report `run.ended` to it.
 */

/** `host.hello` answer (protocol `HostHelloResult`). */
export type HelloResult = HostHelloResult;

/** `inbound.read` answer (protocol `InboundReadResult`). */
export type { InboundReadResult };

export interface HostServiceDeps {
  token: string;
  router: Router;
  queue: HostQueue;
  records: DaemonRecords;
  runs: Runs;
  deliver(hostName: string, f: Extract<HostRequestFrame, { type: 'deliver' }>): Promise<Outcome>;
  log: LogFn;
  /** How long a pushed `inbound` waits for the host's result before it is retried (default 30 s). */
  pushTimeoutMs?: number;
  /** Delay before a refused push is retried (default 1 s). */
  pushRetryMs?: number;
}

/** Origin of what a host connection sends (client frames, run inputs). */
export function hostOrigin(name: string): Origin {
  return { kind: 'system', principal: { id: `host:${name}`, labels: ['host'] }, evidence: 'device_only', via: `host:${name}`, adapter: 'host' };
}

export const isHostOrigin = (o: Origin) => o.kind === 'system' && o.adapter === 'host';

export class HostService implements HostFrames {
  private host: { peer: Peer; name: string; consumer?: string; callouts: boolean; push?: PushSubscription } | undefined;
  private readonly token: Buffer;

  constructor(private readonly d: HostServiceDeps) {
    this.token = Buffer.from(d.token);
  }

  /** The connected host, if any. */
  hostPeer(): Peer | undefined {
    return this.host?.peer;
  }

  hostName(): string | undefined {
    return this.host?.name;
  }

  /** The connected host's name and role, if any. */
  info(): { name: string; consumer?: string; callouts: boolean } | undefined {
    const h = this.host;
    return h ? { name: h.name, callouts: h.callouts, ...(h.consumer !== undefined ? { consumer: h.consumer } : {}) } : undefined;
  }

  async handle(peer: Peer, f: HostRequestFrame): Promise<Outcome> {
    switch (f.type) {
      case 'host.hello':
        return this.hello(peer, f);
      case 'bindings.put':
        try {
          const r = this.d.router.putHostTable(f.table);
          const st = this.d.router.hostTable();
          return ok({ ...r, active: st?.active ?? false, ...(st?.suspended ? { suspended: st.suspended } : {}) });
        } catch (e) {
          if (e instanceof RouterError) return fail(e.code, e.message);
          throw e;
        }
      case 'bindings.get':
        return ok({ config: this.d.router.configTable() ?? null, host: this.d.router.hostTable() ?? null, hostConnected: this.d.router.hostConnected });
      case 'run.start':
        return this.d.runs.start(peer, f, peer.auth!.origin(`run:${f.runId}`));
      case 'run.cancel':
        return this.d.runs.cancel(f.runId, f.reason);
      case 'deliver':
        return this.d.deliver(peer.auth!.name, f);
      case 'input.verify':
        return ok(this.d.records.verify(f.channelRef));
      case 'inbound.read': {
        if (!f.consumer) return fail('invalid_frame', 'consumer is empty');
        const items = await this.d.queue.read(f.consumer, {
          ...(f.after !== undefined ? { after: f.after } : {}),
          ...(f.limit !== undefined ? { limit: f.limit } : {}),
          waitMs: Math.min(Math.max(0, f.waitMs ?? 0), 300_000),
          signal: peer.signal,
        });
        return ok<InboundReadResult>({ items, acked: this.d.queue.cursor(f.consumer), head: this.d.queue.head() });
      }
      case 'inbound.ack':
        if (!f.consumer) return fail('invalid_frame', 'consumer is empty');
        return ok({ consumer: f.consumer, acked: this.d.queue.ack(f.consumer, f.cursor) });
      case 'explain': {
        const e = this.d.router.explain(f.inputId);
        return e ? ok(e) : fail('unknown_input', `no routing record for ${f.inputId} (unknown, or older than the retention)`);
      }
    }
  }

  private hello(peer: Peer, f: Extract<HostRequestFrame, { type: 'host.hello' }>): Outcome {
    if (peer.auth) return fail('already_authenticated', `this connection is already ${peer.auth.name}`);
    const given = Buffer.from(f.token);
    if (given.length !== this.token.length || !timingSafeEqual(given, this.token)) {
      this.d.log('warn', `host.hello from ${JSON.stringify(f.name)} with a wrong token`);
      return fail('unauthorized', 'wrong token (read it from the token file next to the socket)');
    }
    const name = f.name.trim();
    if (!name) return fail('invalid_frame', 'name is empty');
    const role = f.consumer !== undefined || f.callouts === true;
    if (role && this.host && !this.host.peer.signal.aborted) return fail('host_connected', `host ${this.host.name} is connected; at most one host (consumer / callouts) at a time`);
    if (f.consumer !== undefined && !f.consumer) return fail('invalid_frame', 'consumer is empty');
    peer.auth = { name, origin: () => hostOrigin(name) };
    if (role) {
      this.host = { peer, name, callouts: f.callouts === true, ...(f.consumer !== undefined ? { consumer: f.consumer } : {}) };
      this.d.router.setHostConnected(true);
      if (f.consumer !== undefined) this.host.push = this.startPush(peer, f.consumer);
      this.d.log('info', `host ${name} connected${f.consumer !== undefined ? `, consuming as ${f.consumer}` : ''}${f.callouts ? ', answering callouts' : ''}`);
    }
    const st = this.d.router.hostTable();
    return ok<HelloResult>({
      name,
      protocol: PROTOCOL_VERSION,
      host: role,
      bindings: { version: st?.table.version ?? null, active: st?.active ?? false, ...(st?.suspended ? { suspended: st.suspended } : {}) },
      ...(f.consumer !== undefined ? { inbound: { consumer: f.consumer, acked: this.d.queue.cursor(f.consumer), head: this.d.queue.head() } } : {}),
    });
  }

  /** Push-consume: one `inbound` at a time; the cursor moves when the host answers `{ accepted: true }`. */
  private startPush(peer: Peer, consumer: string): PushSubscription {
    return this.d.queue.subscribe(
      consumer,
      async (item) => {
        const r = await peer.request({ type: 'inbound', item }, this.d.pushTimeoutMs ?? 30_000);
        return r.ok && (r.value as { accepted?: unknown } | undefined)?.accepted === true;
      },
      { retryMs: this.d.pushRetryMs ?? 1000 },
    );
  }

  gone(peer: Peer): void {
    this.d.runs.peerGone(peer);
    if (this.host?.peer !== peer) return;
    this.host.push?.close();
    this.d.log('info', `host ${this.host.name} disconnected`);
    this.host = undefined;
    this.d.router.setHostConnected(false);
  }

  /** The router's `routeCallout`: ask the connected host (the router applies the rule's timeout). */
  async routeCallout(bindingId: string, input: InputRecord, envelope: InboundEnvelope): Promise<CalloutAnswer> {
    const h = this.host;
    if (!h) throw new Error('no host connected');
    if (!h.callouts) throw new Error(`host ${h.name} does not answer callouts`);
    const r = await h.peer.request({ type: 'policy', hook: 'route', args: { bindingId, input, envelope } }, 60_000);
    if (!r.ok) throw new Error(`${r.error?.code ?? 'error'}: ${r.error?.message ?? ''}`);
    return r.value as CalloutAnswer;
  }

  /** Close the host connection's push loop (daemon stop). */
  close(): void {
    this.host?.push?.close();
  }
}

function ok<T>(value: T): Outcome {
  return { ok: true, value };
}

function fail(code: string, message = code): Outcome {
  return { ok: false, code, message };
}
