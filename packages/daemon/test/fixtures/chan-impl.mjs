import { defaultChannelCaps, fakeEnvelope } from '@agents-io/testkit';

/** A minimal in-process channel plugin; records what it was given in globalThis.__chan[<id>:<account>]. */
export function makeAdapter(init, via) {
  const id = init.config?.id ?? 'plug';
  const rec = { via, init, closed: false, sent: [] };
  (globalThis.__chan ??= {})[`${id}:${init.account}`] = rec;
  return {
    id,
    caps: () => defaultChannelCaps,
    async start(ctx) {
      rec.ctx = ctx;
      rec.blobs = ctx.blobs;
      rec.startConfig = ctx.config;
      rec.inject = (p) => ctx.emit(fakeEnvelope({ channel: id, account: ctx.account, ...p }));
      await new Promise((r) => ctx.signal.addEventListener('abort', r, { once: true }));
    },
    async send(route, msg, op) {
      rec.sent.push({ route, msg, op });
      return { providerMessageId: `m${rec.sent.length}` };
    },
    async close() {
      rec.closed = true;
    },
  };
}
