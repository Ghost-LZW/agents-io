import { Type } from '@sinclair/typebox';
import type { ChannelModule } from '@agents-io/protocol';
import { spawnChannel } from './host.js';

/*
 * The bridge channel type (`{ "type": "bridge", "command": …, … }`): an out-of-process channel
 * spoken to over JSONL stdio (`spawnChannel`), how private channels attach. Its config keys, the
 * rules for its channel ids and how its adapter is built. The daemon registers it in its bundle.
 */

/** A `bridge` entry's own keys (`env` and `config` env-substituted, `cwd` a resolved path once resolved). */
export type BridgeChannelEntry = { type: 'bridge'; id?: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; config?: unknown };

/** The program an entry runs: entries sharing a channel id must run the same one (channel-stamping F4). */
const programOf = (entry: BridgeChannelEntry) => JSON.stringify([entry.command, entry.args ?? []]);

/** A command-line flag naming a secret (`--token`, `--api-key=`): the next argument (or its value) is one. */
const SECRET_FLAG = /^--?[\w-]*(secret|password|passwd|token|api[-_]?key|credential|auth)[\w-]*$/i;

export const bridgeChannelModule: ChannelModule<BridgeChannelEntry> = {
  type: 'bridge',
  entry: {
    /**
     * The channel id: every `hello` must declare it as `adapterId`, else the peer is refused
     * (`bad_hello`) and restarted with backoff. Not a built-in id (`lark-bot`, `mail`, `local`);
     * bridge entries sharing an id must run the same `command` / `args` (one program, several
     * accounts). Without it the first hello's id is pinned (and checked the same way).
     */
    id: Type.Optional(Type.String({ minLength: 1 })),
    command: Type.String(),
    args: Type.Optional(Type.Array(Type.String())),
    /** The peer's environment: every value is a credential (write "env:NAME"). */
    env: Type.Optional(Type.Record(Type.String(), Type.String(), { 'x-credential': true })),
    cwd: Type.Optional(Type.String()),
    config: Type.Optional(Type.Unknown()),
  },

  // An argument after a secret-looking flag, or the value of `--flag=value`: other local users can read argv (ps).
  isCredential(path, entry) {
    if (path[0] !== 'args' || path.length !== 2) return false;
    const args: unknown[] = Array.isArray(entry.args) ? entry.args : [];
    const i = Number(path[1]);
    const prev = args[i - 1];
    const self = args[i];
    if (typeof prev === 'string' && SECRET_FLAG.test(prev)) return true;
    return typeof self === 'string' && self.includes('=') && SECRET_FLAG.test(self.slice(0, self.indexOf('=')));
  },
  // Not the env file: the peer's own env, which the command line does not show.
  credentialHint: (path) => (path[0] === 'args' ? 'a secret on the bridge command line is visible to other local users (ps); pass it in the bridge env ("env": { "NAME": "env:NAME" })' : undefined),

  resolve: (entry, ctx) => ({
    ...entry,
    ...(entry.cwd ? { cwd: ctx.path(entry.cwd) } : {}),
    ...(entry.env ? { env: ctx.substitute(entry.env, 'bridge.env') as Record<string, string> } : {}),
    ...(entry.config !== undefined ? { config: ctx.substitute(entry.config, 'bridge.config') } : {}),
  }),

  // One program (command and args) is one adapter.
  owner: programOf,
  // Without `id`, the first hello's.
  idOf: (entry) => entry.id,

  // One channel id belongs to one adapter, only accounts differ (channel-stamping F4). A bridge's id
  // without `id` is only known once connected; the gateway checks that one.
  validateAll(bridges, ctx) {
    const programs = new Map<string, { program: string; index: number }>();
    for (const { index, resolved: ch } of bridges) {
      if (ch.id === undefined) continue;
      if (ctx.reservedIds.includes(ch.id)) ctx.fail(`channels[${index}]: bridge id ${JSON.stringify(ch.id)} is a built-in channel id; a bridge cannot use it`);
      const program = programOf(ch);
      const prior = programs.get(ch.id);
      if (prior && prior.program !== program) ctx.fail(`channels[${prior.index}] and channels[${index}] run different programs under one channel id ${JSON.stringify(ch.id)}; one channel id belongs to one adapter (entries sharing it differ only in account)`);
      programs.set(ch.id, { program, index });
    }
  },

  async create(entry, init) {
    const b = await spawnChannel({
      command: entry.command,
      account: entry.account,
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.env ? { env: entry.env } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      ...(entry.config !== undefined ? { config: entry.config } : {}),
      // A peer that fails its first hello is retried with the restart backoff instead of failing the daemon.
      retryFirstConnect: true,
      ...(entry.id !== undefined ? { id: entry.id, expectId: entry.id } : {}),
      onState: init.onState,
      acceptId: init.acceptId,
    });
    // Without `id`, the channel id is the first hello's: unknown until the peer connected.
    return { adapter: b, config: entry.config, close: () => b.close(), idKnown: () => entry.id !== undefined || b.state().connected };
  },
};
