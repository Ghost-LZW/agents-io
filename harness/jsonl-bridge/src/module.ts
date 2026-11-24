import { Type, type Static } from '@sinclair/typebox';
import type { HarnessModule } from '@agents-io/protocol';
import { spawnHarness } from './host.js';

/*
 * The bridge harness kind (`{ "use": "bridge", "command": …, … }`): a harness in another process,
 * any language, spoken to over JSONL stdio (`spawnHarness`). Its config keys and how its adapter is
 * built. The daemon registers it in its bundle.
 */

/** A `use: "bridge"` instance's own keys (beside `use`, `env`, `cwd`, `run`, `profiles`, `options`). */
const Instance = Type.Object({
  /** The program: a path (`~`, relative to the config file) or a name looked up on PATH. */
  command: Type.String({ minLength: 1 }),
  /** Its arguments, as written: other local users can read them (`ps`), so no secrets here. */
  args: Type.Optional(Type.Array(Type.String())),
  /** Sent to the program in `probe` (`config`); `"env:NAME"` values are substituted. */
  config: Type.Optional(Type.Unknown()),
});

/** What a bridge instance's entry resolves to (`HarnessInstance.launch`). */
export interface BridgeHarnessLaunch {
  command: string;
  args?: string[];
  /** The program's working directory: the instance's `cwd` (its sessions' too), else the daemon's. */
  cwd?: string;
  config?: unknown;
}

const pathish = (p: string) => p.startsWith('~') || p.startsWith('.') || p.includes('/');

export const bridgeHarnessModule: HarnessModule<BridgeHarnessLaunch> = {
  kind: 'bridge',
  schema: Instance,
  // The program maps profiles to its own settings: every open carries the instance's.
  profilesInOpen: true,
  // What it declares is the program's to say, in its hello.
  probeAtStart: true,

  resolve(entry, ctx) {
    const x = entry as Static<typeof Instance> & { cwd?: string };
    // `"env:NAME"` in `config` (it goes to the program on its stdin, never on a command line); a missing variable makes the instance unavailable.
    const sub = (v: unknown, at: string): unknown => {
      if (typeof v === 'string' && v.startsWith('env:')) return ctx.secrets.value(v.slice(4), at) ?? v;
      if (Array.isArray(v)) return v.map((e, i) => sub(e, `${at}[${i}]`));
      if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, sub(e, `${at}.${k}`)]));
      return v;
    };
    const launch: BridgeHarnessLaunch = {
      command: pathish(x.command) ? ctx.path(x.command) : x.command,
      ...(x.args ? { args: x.args } : {}),
      ...(x.cwd ? { cwd: ctx.path(x.cwd) } : {}),
      ...(x.config !== undefined ? { config: sub(x.config, `${ctx.where}.config`) } : {}),
    };
    return { launch };
  },

  create(init) {
    const x = init.launch;
    return spawnHarness({
      command: x.command,
      ...(x.args ? { args: x.args } : {}),
      ...(x.cwd ? { cwd: x.cwd } : {}),
      env: init.env,
      id: init.name,
      instance: init.name,
      ...(x.config !== undefined ? { config: x.config } : {}),
      ...(init.blobs ? { blobs: init.blobs } : {}),
      log: init.log,
    });
  },
};
