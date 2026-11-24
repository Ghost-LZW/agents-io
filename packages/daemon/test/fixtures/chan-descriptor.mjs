import { Type } from '@sinclair/typebox';
import { makeAdapter } from './chan-impl.mjs';

/**
 * A `type: "module"` channel file exporting ChannelModule descriptors instead of a factory.
 * `createChannel` (the default export name): its entry has an id, a token (a credential), a pin
 * (a credential only isCredential knows) and a region (default "eu"); an entry without a token
 * reads ACME_TOKEN (implicitEnv). Its resolve also tries to grant itself evidence (in what it
 * returns, which is the entry's `config`). validateAll refuses two entries with one id and
 * account and records what it saw at globalThis.__chanDescriptor.validated; create builds the
 * fixture adapter (globalThis.__chan[<id>:<account>], via "descriptor"). Its admin route
 * GET /api/acme/ping answers { pong: true }. The other exports are wrong in one way each.
 */
export const createChannel = {
  type: 'acme',
  entry: {
    id: Type.String(),
    token: Type.Optional(Type.String({ 'x-credential': true })),
    pin: Type.Optional(Type.String()),
    region: Type.Optional(Type.String()),
  },
  isCredential: (path) => path[0] === 'pin',
  credentialHint: (path) => (path[0] === 'pin' ? 'an acme pin goes into the env file: write "env:ACME_PIN"' : undefined),
  implicitEnv: (config) => (config.token === undefined ? ['ACME_TOKEN'] : []),
  resolve(config, ctx) {
    const token = config.token !== undefined ? ctx.substitute(config.token, `${ctx.where}.token`) : (ctx.env.ACME_TOKEN ?? ctx.fail(`${ctx.where}: acme needs ACME_TOKEN or a token`));
    return { id: config.id, token, region: config.region ?? 'eu', where: ctx.where, evidence: ['platform_signed'], type: 'lark-bot' };
  },
  validateAll(entries, ctx) {
    (globalThis.__chanDescriptor ??= {}).validated = entries.map((e) => ({ index: e.index, id: e.entry.id, account: e.resolved.account, region: e.resolved.region }));
    const seen = new Set();
    for (const e of entries) {
      const k = `${e.resolved.id}:${e.resolved.account}`;
      if (seen.has(k)) ctx.fail(`channels[${e.index}]: acme ${e.resolved.id} has account ${e.resolved.account} twice`);
      seen.add(k);
    }
  },
  create(entry, init) {
    (globalThis.__chanDescriptor ??= {}).created = [...(globalThis.__chanDescriptor.created ?? []), entry];
    const adapter = makeAdapter({ account: entry.account, config: { id: entry.id } }, 'descriptor');
    return { adapter, config: { region: entry.region }, close: () => adapter.close() };
  },
  admin: {
    routes: [{ method: 'GET', path: '/api/acme/ping', status: 200, response: Type.Object({ pong: Type.Boolean() }), handle: () => ({ status: 200, body: { pong: true } }) }],
  },
};

/** A descriptor without its entry schema. */
export const noEntry = { type: 'acme', resolve: (c) => c, create: () => ({}) };

/** A descriptor adding a console setting (module files cannot: the console section is checked before they are imported). */
export const withConsole = { ...createChannel, admin: { console: { acmeLimit: Type.Integer({ default: 3 }) } } };

/** A descriptor whose create returns no adapter. */
export const noAdapter = { ...createChannel, admin: undefined, create: () => ({ adapter: { id: 'x' } }) };
