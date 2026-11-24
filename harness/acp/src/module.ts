import { Type, type Static } from '@sinclair/typebox';
import type { HarnessModule } from '@agents-io/protocol';
import { ACP_FLAVORS } from './flavors.js';
import { AcpHarness } from './harness.js';

/*
 * The ACP harness kind (`{ "use": "acp", "command": …, … }`): any Agent Client Protocol agent,
 * started as configured (never installed from a registry). Its config keys and how its adapter is
 * built. The daemon registers it in its bundle.
 */

/** A `use: "acp"` instance's own keys (beside `use`, `env`, `cwd`, `run`, `profiles`, `options`). */
const Instance = Type.Object({
  /** The agent program: a path (`~`, relative to the config file) or a name looked up on PATH. */
  command: Type.String({ minLength: 1 }),
  /** Its arguments, as written: other local users can read them (`ps`), so no secrets here. */
  args: Type.Optional(Type.Array(Type.String())),
  /** Its quirks, by name (`generic`, `claude`). Default: picked by the agent's `initialize` answer. */
  flavor: Type.Optional(Type.String({ minLength: 1 })),
  /** How the host's MCP endpoint reaches the agent: `http` or `stdio-bridge`. Default: `http` when the agent advertises it. */
  mcp: Type.Optional(Type.Union([Type.Literal('http'), Type.Literal('stdio-bridge')])),
  /** The harness's name in replies. */
  displayName: Type.Optional(Type.String({ minLength: 1 })),
  /** The session mode Plan mode selects (declares Plan mode before a session has shown it). */
  planMode: Type.Optional(Type.String({ minLength: 1 })),
  /** The command that compacts a session's context (default: `/compact` once the agent advertises it). */
  compact: Type.Optional(Type.String({ minLength: 1 })),
  /** Offer form elicitation, so the agent can ask questions. Default true. */
  elicitation: Type.Optional(Type.Boolean()),
  /** Authenticate with this method (one of the agent's `authMethods`) after `initialize`. */
  authMethod: Type.Optional(Type.String({ minLength: 1 })),
});

/** What an acp instance's entry resolves to (`HarnessInstance.launch`). */
export interface AcpHarnessLaunch {
  command: string;
  args?: string[];
  /** The agent's working directory: the instance's `cwd` (its sessions' too), else the daemon's. */
  cwd?: string;
  flavor?: string;
  mcp?: 'http' | 'stdio-bridge';
  displayName?: string;
  planMode?: string;
  compact?: string;
  elicitation?: boolean;
  authMethod?: string;
}

const pathish = (p: string) => p.startsWith('~') || p.startsWith('.') || p.includes('/');

export const acpHarnessModule: HarnessModule<AcpHarnessLaunch> = {
  kind: 'acp',
  schema: Instance,

  resolve(entry, ctx) {
    const x = entry as Static<typeof Instance> & { cwd?: string; profiles?: Record<string, Record<string, unknown>> };
    if (x.flavor !== undefined && !ACP_FLAVORS[x.flavor]) ctx.fail(`${ctx.where}.flavor: unknown ACP flavor ${JSON.stringify(x.flavor)} (known: ${Object.keys(ACP_FLAVORS).join(', ')})`);
    // A profile selects a session mode, and nothing else is the agent's to take.
    for (const [name, p] of Object.entries(x.profiles ?? {})) {
      const other = Object.keys(p).filter((k) => k !== 'mode');
      if (other.length) ctx.fail(`${ctx.where}.profiles.${name}: an acp profile has only \`mode\` (the session mode its turns run in), not ${other.map((k) => `\`${k}\``).join(', ')}`);
      if (p.mode !== undefined && (typeof p.mode !== 'string' || !p.mode)) ctx.fail(`${ctx.where}.profiles.${name}.mode: a session mode id (a non-empty string)`);
    }
    const launch: AcpHarnessLaunch = {
      command: pathish(x.command) ? ctx.path(x.command) : x.command,
      ...(x.args ? { args: x.args } : {}),
      ...(x.cwd ? { cwd: ctx.path(x.cwd) } : {}),
      ...(x.flavor ? { flavor: x.flavor } : {}),
      ...(x.mcp ? { mcp: x.mcp } : {}),
      ...(x.displayName ? { displayName: x.displayName } : {}),
      ...(x.planMode ? { planMode: x.planMode } : {}),
      ...(x.compact ? { compact: x.compact } : {}),
      ...(x.elicitation !== undefined ? { elicitation: x.elicitation } : {}),
      ...(x.authMethod ? { authMethod: x.authMethod } : {}),
    };
    return { launch };
  },

  create(init) {
    const x = init.launch;
    return new AcpHarness({
      command: x.command,
      ...(x.args ? { args: x.args } : {}),
      ...(x.cwd ? { cwd: x.cwd } : {}),
      env: init.env,
      id: init.name,
      profiles: init.profiles,
      ...(x.flavor ? { flavor: x.flavor } : {}),
      ...(x.mcp ? { mcp: x.mcp } : {}),
      ...(x.displayName ? { displayName: x.displayName } : {}),
      ...(x.planMode ? { planMode: x.planMode } : {}),
      ...(x.compact ? { compact: x.compact } : {}),
      ...(x.elicitation !== undefined ? { elicitation: x.elicitation } : {}),
      ...(x.authMethod ? { authMethod: x.authMethod } : {}),
      ...(init.blobs ? { blobs: init.blobs } : {}),
      log: init.log,
    });
  },
};
