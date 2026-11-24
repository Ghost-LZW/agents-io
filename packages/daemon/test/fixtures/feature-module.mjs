import { Type } from '@sinclair/typebox';

/**
 * Feature modules of someone else's, as a config file's `modules` entry loads them (a
 * ModuleManifest each). `manifest` (the default export name) has settings, a feature, a tool and a
 * command; what it gets (its kernel context, its settings) goes to globalThis.__feature[config.key].
 * The other exports are wrong in one way each.
 */
export const manifest = {
  id: 'acme.greet',
  kind: 'feature',
  config: {
    section: 'acmeGreet',
    schema: { key: Type.String(), greeting: Type.Optional(Type.String()) },
    // A built-in module's default: an entry turns its module on whatever this says.
    defaultEnabled: false,
    resolve(raw, ctx) {
      if (raw.greeting === 'bad') ctx.fail(`${ctx.where}.greeting: not that one`);
      return { key: raw.key, greeting: raw.greeting === undefined ? 'hello' : ctx.substitute(raw.greeting, `${ctx.where}.greeting`), where: ctx.where, owners: ctx.valueAt('policy.owners') };
    },
  },
  features: ['acme.greet'],
  mcpTools: [{ name: 'acme_greet', description: 'Answer the configured greeting.', input: Type.Object({ to: Type.String() }) }],
  commands: [{ name: 'greet', help: '/greet — say the configured greeting' }],
  setup(k, config) {
    const rec = { k, config, started: false, stopped: false };
    (globalThis.__feature ??= {})[config.key] = rec;
    return {
      tools: { acme_greet: (call) => ({ said: `${config.greeting}, ${call.args.to}` }) },
      commands: { greet: async () => ({ ok: true, reply: `${config.greeting} from acme` }) },
      status: () => ({ greeting: config.greeting }),
      start() {
        rec.started = true;
      },
      stop() {
        rec.stopped = true;
      },
    };
  },
};

/** Without settings: on whenever its entry is there; its kernel context goes to globalThis.__feature.bare. */
export const bare = {
  id: 'acme.bare',
  kind: 'feature',
  setup(k) {
    (globalThis.__feature ??= {}).bare = { k };
    return {};
  },
};

/** Not a manifest. */
export const notManifest = 42;

/** No setup. */
export const noSetup = { id: 'acme.nosetup', kind: 'feature' };

/** A built-in module's id. */
export const builtinId = { id: 'topic-title', kind: 'feature', setup: () => ({}) };

/** A built-in module's tool. */
export const builtinTool = { id: 'acme.tools', kind: 'feature', mcpTools: [{ name: 'watch_add', description: 'Add a watch.', input: Type.Object({}) }], setup: () => ({}) };
