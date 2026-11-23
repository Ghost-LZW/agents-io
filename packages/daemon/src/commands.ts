import type { InboundEnvelope, InputRecord, ModuleCommandDef, ModuleCommandHandler, Origin } from '@agents-io/protocol';
import type { CommandResult, RouteDelivery } from '@agents-io/session';

/**
 * `/commands` typed into a chat with the deployment (Ingress `onCommand`): the owner operates
 * the session and its harness from the channel. Anyone else's `/text` is an ordinary message.
 * Topic commands without an agent (`/new`, `/topics`, `/switch`) stay with Ingress when the chat
 * keeps topics; here they only say why they do nothing when it does not.
 */

/** One line of the kernel's `/help` and the command names it covers. */
export interface KernelCommand {
  readonly names: readonly string[];
  readonly help: string;
}

/** The kernel's chat commands, in `/help` order. */
export const KERNEL_COMMANDS: readonly KernelCommand[] = [
  { names: ['help'], help: '/help — this list' },
  { names: ['status'], help: '/status — this conversation: session, agent, harness, model, what runs, what waits' },
  { names: ['stop'], help: '/stop [--clear] — stop the running turn (--clear also drops what is queued)' },
  { names: ['steer'], help: '/steer <text> — add to the running turn instead of queueing' },
  { names: ['answer'], help: '/answer <question-code> <answer> — answer a native Codex / Claude Code question' },
  { names: ['new'], help: '/new [@agent] [title] — a new topic (with @agent: talk to that agent from now on)' },
  { names: ['topics', 'switch'], help: '/topics, /switch <n> — list topics, go back to one' },
  { names: ['agent'], help: '/agent [name] — which agent this chat talks to; with a name, switch (new turns go to its current topic)' },
  { names: ['preset'], help: '/preset [name] — list the presets (harness, model, effort), or switch this session to one from the next turn (/preset default to undo)' },
  { names: ['model', 'effort'], help: '/model [name], /effort [level] — show, or set for this session from the next turn (/model default to undo)' },
  { names: ['plan'], help: '/plan [on|off] — show or set Codex Plan mode from the next turn' },
  { names: ['bypass'], help: '/bypass [on|off|default] — show or set Codex permissions for owner turns' },
  { names: ['compact'], help: '/compact — compact the harness context (Claude Code)' },
  { names: ['tui'], help: '/tui — how to open this session in the harness’s own terminal UI' },
];

/** Every name of the kernel's chat commands. */
export const KERNEL_COMMAND_NAMES: readonly string[] = KERNEL_COMMANDS.flatMap((c) => c.names);

/** A command of an active module (`ModuleManifest.commands`) and its handler (`ModuleInstance.commands`). */
export interface ModuleCommand {
  module: string;
  def: ModuleCommandDef;
  handler: ModuleCommandHandler;
}

/**
 * The chat commands a deployment answers: the kernel's, then the active modules' (core-slimming
 * G6), in registration order. A module that is off has none here, so its `/name` is an ordinary
 * message. `help` is `/help`'s text: the kernel's lines, then each module command's.
 */
export class CommandTable {
  readonly help: string;
  private readonly names: ReadonlySet<string>;
  private readonly modules = new Map<string, ModuleCommand>();

  constructor(modules: readonly ModuleCommand[] = []) {
    for (const m of modules) {
      if (KERNEL_COMMAND_NAMES.includes(m.def.name)) throw new Error(`module ${m.module}: /${m.def.name} is a kernel command`);
      if (this.modules.has(m.def.name)) throw new Error(`module ${m.module}: /${m.def.name} is also module ${this.modules.get(m.def.name)!.module}'s`);
      this.modules.set(m.def.name, m);
    }
    this.names = new Set([...KERNEL_COMMAND_NAMES, ...this.modules.keys()]);
    this.help = [...KERNEL_COMMANDS.map((c) => c.help), ...[...this.modules.values()].map((m) => m.def.help)].join('\n');
  }

  /** `/name` is a command here. */
  has(name: string): boolean {
    return this.names.has(name);
  }

  /** The active module whose command `/name` is, if any. */
  module(name: string): ModuleCommand | undefined {
    return this.modules.get(name);
  }
}

/** The kernel's commands alone (no module active). */
export const KERNEL_COMMAND_TABLE = new CommandTable();

/** `/help` with no module active. */
export const COMMAND_HELP = KERNEL_COMMAND_TABLE.help;

export interface SessionRun {
  harness: string;
  kind: string;
  /** The command that compacts its harness's context (`HarnessAdapter.compact`); absent: none. */
  compact?: string;
  /** Its harness has Plan mode (`HarnessAdapter.modes`). */
  plan: boolean;
  /** Its harness lets the owner switch the profile of their turns (`HarnessAdapter.ownerProfileSwitch`). */
  ownerProfileSwitch: boolean;
  preset?: string;
  stalePreset?: string;
  model?: string;
  effort?: string;
  mode?: 'default' | 'plan';
  profile?: 'bypass' | 'restricted';
  overridden: boolean;
}

export interface PresetView {
  name: string;
  harness: string;
  kind: string;
  model?: string;
  effort?: string;
  description?: string;
}

/** `claude (claude-code) · model opus · effort high` */
const runLine = (r: { harness: string; kind: string; model?: string; effort?: string }) =>
  `${r.harness} (${r.kind}) · model ${r.model ?? 'default'}${r.effort ? ` · effort ${r.effort}` : ''}`;

/** `/plan is available only on Codex (this session runs claude-code).`: the harnesses that declare it. */
const onlyOn = (command: string, names: string[], kind: string) =>
  names.length ? `${command} is available only on ${names.join(' or ')} (this session runs ${kind}).` : `${command} is not available on any harness configured here (this session runs ${kind}).`;

const FIXED_SESSION = 'This chat goes to one fixed session (policy.ownerSessionKey), so it has no topics or agents to switch; remove ownerSessionKey to use them.';

export interface CommandHost {
  /** May this origin operate the session (Policy.control, as for topic commands)? */
  allowed(sessionKey: string, origin: Origin): Promise<boolean>;
  status(sessionKey: string, delivery: RouteDelivery): string;
  interrupt(sessionKey: string, origin: Origin, clear: boolean): Promise<CommandResult>;
  /** Sessions of this flat conversation (its topics) with a turn running, the most recent first. */
  running(conversation: string): string[];
  /** Deliver an input to the session (the delivery's lane), with a mode. */
  input(delivery: RouteDelivery, input: InputRecord, mode: 'steer' | 'queue'): Promise<CommandResult>;
  /** The question code names its original session, even if the chat has switched topics. */
  answer(code: string, text: string, origin: Origin): Promise<CommandResult>;
  /** What the session's next turn runs: `preset` is the one set here, else the agent's; `stalePreset` one set here that is no longer configured. */
  run(sessionKey: string): SessionRun;
  /** The configured harnesses that declare Plan mode, or the owner's profile switch, by display name (each once). */
  offering(cap: 'plan' | 'ownerProfileSwitch'): string[];
  setRun(sessionKey: string, o: { preset?: string | null; model?: string | null; effort?: string | null; mode?: 'default' | 'plan'; profile?: 'bypass' | 'restricted' | null }): void;
  /** The configured presets, with the model and effort their instance gives when they set none. */
  presets(): PresetView[];
  agents(): string[];
  conversationAgent(conversation: string): string | undefined;
  setConversationAgent(conversation: string, agent: string): void;
  newTopic(agent: string, conversation: string, title: string | undefined): string;
  tuiHint(sessionKey: string): string;
}

export async function runCommand(
  h: CommandHost,
  a: { name: string; args: string; env: InboundEnvelope; origin: Origin; input: InputRecord; delivery: RouteDelivery },
  table: CommandTable = KERNEL_COMMAND_TABLE,
): Promise<{ ok: boolean; reply: string } | undefined> {
  const { name, args, delivery } = a;
  const key = delivery.sessionKey;
  const topicConversation = delivery.topic?.conversation;
  if (!table.has(name)) return undefined;
  const mod = table.module(name);
  if (mod) {
    // As the kernel's: only who may operate the session runs it (unless the module says anyone may); anyone else's is a message.
    if (mod.def.ownerOnly !== false && !(await h.allowed(key, a.origin))) return undefined;
    return mod.handler({
      name,
      args,
      sessionKey: key,
      ...(delivery.agent !== undefined ? { agent: delivery.agent } : {}),
      ...(topicConversation !== undefined ? { conversation: topicConversation } : {}),
      origin: a.origin,
      env: a.env,
      input: a.input,
    });
  }
  // The lane checks the question's resolver principal. A guest may answer a question
  // addressed to them even though they cannot operate owner-only chat commands.
  if (name === 'answer') {
    const split = args.search(/\s/);
    if (split < 0 || !args.slice(split).trim()) return { ok: false, reply: 'Usage: /answer <question-code> <answer>' };
    const r = await h.answer(args.slice(0, split), args.slice(split).trim(), a.origin);
    return r.ok ? { ok: true, reply: 'Answer submitted.' } : { ok: false, reply: `Answer not submitted: ${r.reason ?? 'refused'}.` };
  }
  // Plain topic commands in a chat that keeps topics: Ingress answers them.
  if ((name === 'new' && !args.startsWith('@')) || name === 'topics' || name === 'switch') {
    if (topicConversation) return undefined;
  }
  if (!(await h.allowed(key, a.origin))) return name === 'help' ? { ok: true, reply: 'Commands are for the owner of this deployment.' } : undefined;
  const ok = (reply: string) => ({ ok: true, reply });
  const no = (reply: string) => ({ ok: false, reply });
  const res = (r: CommandResult, done: string) => (r.ok ? ok(done) : no(`Not done: ${r.reason ?? 'refused'}.`));

  switch (name) {
    case 'help':
      return ok(table.help);
    case 'status':
      return ok(h.status(key, delivery));
    case 'stop': {
      // Lark's thinking bubble has a Stop that sends a plain `/stop`: it may belong to a topic left
      // running behind the current one, so with nothing running here the chat's running turn stops.
      const others = topicConversation ? h.running(topicConversation).filter((k) => k !== key) : [];
      const target = h.running(topicConversation ?? '').includes(key) || !others.length ? key : others[0]!;
      const r = await h.interrupt(target, a.origin, args === '--clear');
      if (!r.ok && /no_active_turn|stale_turn/.test(r.reason)) return ok('Nothing is running.');
      const where = target === key ? '' : ` (in another topic of this chat)`;
      return res(r, args === '--clear' ? `Stopped${where}; the queue is cleared.` : `Stopped${where}.`);
    }
    case 'steer': {
      if (!args) return no('Usage: /steer <text>');
      const r = await h.input(delivery, { ...a.input, content: [{ type: 'text', text: args }] }, 'steer');
      if (!r.ok) return no(`Not done: ${r.reason ?? 'refused'}.`);
      return ok(r.disposition === 'steer' ? 'Added to the running turn.' : 'Nothing was running: it starts a turn.');
    }
    case 'preset': {
      const cur = h.run(key);
      const presets = h.presets();
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
      h.setRun(key, { preset: args === 'default' ? null : args, model: null, effort: null });
      const next = h.run(key);
      const moved =
        next.harness !== cur.harness
          ? ` The harness changes (${cur.harness} → ${next.harness}); each keeps its own context, so ${next.harness} has not seen what was said on ${cur.harness}. /new starts a clean topic.`
          : '';
      return ok(`${args === 'default' ? 'Back to the agent’s own' : `Preset ${args}`} from the next turn: ${runLine(next)}.${moved}`);
    }
    case 'model':
    case 'effort': {
      const cur = h.run(key);
      if (!args) return ok(`${name === 'model' ? `model ${cur.model ?? '(harness default)'}` : `effort ${cur.effort ?? '(default)'}`} on ${cur.harness}${cur.overridden ? ' (set here)' : ''}`);
      const value = args === 'default' ? null : args;
      h.setRun(key, name === 'model' ? { model: value } : { effort: value });
      return ok(value === null ? `${name} back to the agent's default from the next turn.` : `${name} ${value} from the next turn.`);
    }
    case 'plan': {
      const cur = h.run(key);
      if (!cur.plan) return no(onlyOn('/plan', h.offering('plan'), cur.kind));
      if (!args) return ok(`Plan mode ${cur.mode === 'plan' ? 'on' : 'off'} for this session.`);
      if (args !== 'on' && args !== 'off') return no('Usage: /plan [on|off]');
      h.setRun(key, { mode: args === 'on' ? 'plan' : 'default' });
      return ok(`Plan mode ${args} from the next turn.`);
    }
    case 'bypass': {
      const cur = h.run(key);
      if (!cur.ownerProfileSwitch) return no(onlyOn('/bypass', h.offering('ownerProfileSwitch'), cur.kind));
      if (!args) return ok(`Bypass ${cur.profile ?? 'default'} for owner turns in this session.`);
      if (args !== 'on' && args !== 'off' && args !== 'default') return no('Usage: /bypass [on|off|default]');
      h.setRun(key, { profile: args === 'default' ? null : args === 'on' ? 'bypass' : 'restricted' });
      return ok(args === 'default' ? 'Bypass back to the agent policy from the next turn.' : `Bypass ${args} for owner turns from the next turn.`);
    }
    case 'compact': {
      const cur = h.run(key);
      if (cur.compact === undefined) return no(`/compact is not available on ${cur.kind} yet.`);
      const r = await h.input(delivery, { ...a.input, content: [{ type: 'text', text: cur.compact }], channelContext: { ...a.input.channelContext, nativeCommand: true } }, 'queue');
      return r.ok ? ok('Compacting (queued behind anything running).') : no(`Not done: ${r.reason ?? 'refused'}.`);
    }
    case 'agent':
    case 'new': {
      const conversation = topicConversation;
      const agents = h.agents();
      if (name === 'agent' && !args) return ok(`This chat talks to ${delivery.agent ?? '(default)'}. Agents: ${agents.join(', ')}`);
      if (!conversation) return no(FIXED_SESSION);
      const [first, ...rest] = args.split(/\s+/);
      const wanted = (first ?? '').replace(/^@/, '');
      if (!agents.includes(wanted)) return no(`No agent ${wanted || '(none given)'}. Agents: ${agents.join(', ')}`);
      h.setConversationAgent(conversation, wanted);
      if (name === 'agent') return ok(`This chat talks to ${wanted} now (its current topic, or a new one).`);
      const title = rest.join(' ').trim() || undefined;
      const topic = h.newTopic(wanted, conversation, title);
      return ok(`New topic with ${wanted}${title ? `: ${title}` : ''} (${topic}). Your next message starts it.`);
    }
    case 'topics':
    case 'switch':
      return no(FIXED_SESSION);
    case 'tui':
      return ok(h.tuiHint(key));
  }
  return undefined;
}
