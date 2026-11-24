import type { KernelContext, KernelSessionRun, ModuleCommandDef, ModuleCommandHandler, ModuleManifest } from '@agents-io/protocol';
import { FIXED_SESSION } from './commands.js';

/*
 * The owner's run-config chat commands, as a built-in feature module (core-slimming G6 step 5;
 * `bundle.ts` registers it, nothing else in the daemon imports it): `/agent` (which agent a flat
 * conversation talks to), `/preset`, `/model`, `/effort` (what the session's next turns run),
 * `/plan`, `/bypass` (Plan mode, the profile of the owner's turns: where the harness declares them,
 * `HarnessAdapter.modes` / `ownerProfileSwitch`) and `/compact` (the harness's own compaction
 * command, `HarnessAdapter.compact`), and their line of `/status`. A host-level feature (decision
 * 16): on unless `ownerCommands: { enabled: false }`; off, these `/names` are ordinary messages and
 * `/status` has no Plan line. What is set stays the kernel's (`KernelContext.runConfig`: kept in its
 * records, applied over the agent's policy's plan, also while this module is off), and so do the
 * presets as configured (`presets`, an agent's `preset`, `run.start` `overrides.preset`) and the
 * IO-control commands (`/help`, `/status`, `/stop`, `/steer`, `/answer`, `/new`, `/topics`,
 * `/switch`, `/tui`). Every reply is as it was when the kernel answered these commands (CT-2).
 */

/** The `ownerCommands` section of the config file: only `enabled` (the daemon's). */
export interface OwnerCommandsSection {
  enabled?: boolean;
}

/** What the section resolves to: nothing of its own. */
export type OwnerCommandsConfig = Record<string, never>;

/** Their `/help` lines come before `/tui`'s, where they always were. */
const COMMANDS: readonly ModuleCommandDef[] = [
  { name: 'agent', help: '/agent [name] — which agent this chat talks to; with a name, switch (new turns go to its current topic)', helpBefore: 'tui' },
  { name: 'preset', help: '/preset [name] — list the presets (harness, model, effort), or switch this session to one from the next turn (/preset default to undo)', helpBefore: 'tui' },
  { name: 'model', aliases: ['effort'], help: '/model [name], /effort [level] — show, or set for this session from the next turn (/model default to undo)', helpBefore: 'tui' },
  { name: 'plan', help: '/plan [on|off] — show or set Codex Plan mode from the next turn', helpBefore: 'tui' },
  { name: 'bypass', help: '/bypass [on|off|default] — show or set Codex permissions for owner turns', helpBefore: 'tui' },
  { name: 'compact', help: '/compact — compact the harness context (Claude Code)', helpBefore: 'tui' },
];

export const ownerCommandsModule: ModuleManifest<OwnerCommandsConfig> = {
  id: 'owner-commands',
  kind: 'feature',
  needs: ['kernel:runConfig', 'kernel:agents', 'kernel:router'],
  config: {
    section: 'ownerCommands',
    schema: {},
    // On, as the commands were before they were a module: a file without the section has them.
    defaultEnabled: true,
    resolve: () => ({}),
  },
  commands: COMMANDS,
  setup: (k) => ({
    commands: ownerCommandHandlers(k),
    hooks: { statusLines: (sessionKey) => [planLine(k.runConfig.get(sessionKey))] },
  }),
};

/** `/status`'s line: `Plan mode off · bypass default (agent policy)`. */
const planLine = (run: KernelSessionRun) =>
  `Plan mode ${run.plan ? (run.mode === 'plan' ? 'on' : 'off') : 'unavailable'} · bypass ${run.profile ?? 'default (agent policy)'}`;

/** `claude (claude-code) · model opus · effort high` */
const runLine = (r: { harness: string; kind: string; model?: string; effort?: string }) =>
  `${r.harness} (${r.kind}) · model ${r.model ?? 'default'}${r.effort ? ` · effort ${r.effort}` : ''}`;

/** `/plan is available only on Codex (this session runs claude-code).`: the harnesses that declare it. */
const onlyOn = (command: string, names: string[], kind: string) =>
  names.length ? `${command} is available only on ${names.join(' or ')} (this session runs ${kind}).` : `${command} is not available on any harness configured here (this session runs ${kind}).`;

const ok = (reply: string) => ({ ok: true, reply });
const no = (reply: string) => ({ ok: false, reply });

/** The handlers, by command name (`/effort` is `model`'s alias). */
function ownerCommandHandlers(k: KernelContext): Record<string, ModuleCommandHandler> {
  return {
    agent: async (c) => {
      const agents = k.agents.names();
      if (!c.args) return ok(`This chat talks to ${c.agent ?? '(default)'}. Agents: ${agents.join(', ')}`);
      if (!c.conversation) return no(FIXED_SESSION);
      const wanted = (c.args.split(/\s+/)[0] ?? '').replace(/^@/, '');
      if (!agents.includes(wanted)) return no(`No agent ${wanted || '(none given)'}. Agents: ${agents.join(', ')}`);
      k.router.setConversationAgent(c.conversation, wanted);
      return ok(`This chat talks to ${wanted} now (its current topic, or a new one).`);
    },
    preset: async (c) => {
      const { args, sessionKey: key } = c;
      const cur = k.runConfig.get(key);
      const presets = k.runConfig.presets();
      const none = 'No presets configured (config `presets`).';
      if (!args) {
        if (!presets.length) return ok(`${none} This session runs ${runLine(cur)}.`);
        return ok(
          [
            `This session: ${cur.preset ? `preset ${cur.preset}, ` : ''}${runLine(cur)}${cur.overridden ? ' (set here)' : ''}`,
            ...(cur.stalePreset ? [`(preset ${cur.stalePreset} set here is no longer configured; the agent's own runs)`] : []),
            ...presets.map((p) => `- ${p.name}: ${runLine(p)}${p.description ? ` — ${p.description}` : ''}`),
            '/preset <name> switches this session from the next turn; /preset default goes back to the agent’s own.',
          ].join('\n'),
        );
      }
      if (args !== 'default' && !presets.some((p) => p.name === args)) return no(presets.length ? `No preset ${args}. Presets: ${presets.map((p) => p.name).join(', ')}` : none);
      // A preset brings its own model and effort: what /model and /effort set here goes with the old one.
      k.runConfig.set(key, { preset: args === 'default' ? null : args, model: null, effort: null });
      const next = k.runConfig.get(key);
      const moved =
        next.harness !== cur.harness
          ? ` The harness changes (${cur.harness} → ${next.harness}); each keeps its own context, so ${next.harness} has not seen what was said on ${cur.harness}. /new starts a clean topic.`
          : '';
      return ok(`${args === 'default' ? 'Back to the agent’s own' : `Preset ${args}`} from the next turn: ${runLine(next)}.${moved}`);
    },
    // `/model` and `/effort`.
    model: async (c) => {
      const { name, args, sessionKey: key } = c;
      const cur = k.runConfig.get(key);
      if (!args) return ok(`${name === 'model' ? `model ${cur.model ?? '(harness default)'}` : `effort ${cur.effort ?? '(default)'}`} on ${cur.harness}${cur.overridden ? ' (set here)' : ''}`);
      const value = args === 'default' ? null : args;
      k.runConfig.set(key, name === 'model' ? { model: value } : { effort: value });
      return ok(value === null ? `${name} back to the agent's default from the next turn.` : `${name} ${value} from the next turn.`);
    },
    plan: async (c) => {
      const { args, sessionKey: key } = c;
      const cur = k.runConfig.get(key);
      if (!cur.plan) return no(onlyOn('/plan', k.runConfig.offering('plan'), cur.kind));
      if (!args) return ok(`Plan mode ${cur.mode === 'plan' ? 'on' : 'off'} for this session.`);
      if (args !== 'on' && args !== 'off') return no('Usage: /plan [on|off]');
      k.runConfig.set(key, { mode: args === 'on' ? 'plan' : 'default' });
      return ok(`Plan mode ${args} from the next turn.`);
    },
    bypass: async (c) => {
      const { args, sessionKey: key } = c;
      const cur = k.runConfig.get(key);
      if (!cur.ownerProfileSwitch) return no(onlyOn('/bypass', k.runConfig.offering('ownerProfileSwitch'), cur.kind));
      if (!args) return ok(`Bypass ${cur.profile ?? 'default'} for owner turns in this session.`);
      if (args !== 'on' && args !== 'off' && args !== 'default') return no('Usage: /bypass [on|off|default]');
      k.runConfig.set(key, { profile: args === 'default' ? null : args === 'on' ? 'bypass' : 'restricted' });
      return ok(args === 'default' ? 'Bypass back to the agent policy from the next turn.' : `Bypass ${args} for owner turns from the next turn.`);
    },
    compact: async (c) => {
      const cur = k.runConfig.get(c.sessionKey);
      if (cur.compact === undefined) return no(`/compact is not available on ${cur.kind} yet.`);
      const r = await c.compact();
      return r.ok ? ok('Compacting (queued behind anything running).') : no(`Not done: ${r.reason ?? 'refused'}.`);
    },
  };
}
