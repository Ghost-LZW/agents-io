import type { InboundEnvelope, InputRecord, KernelInputResult, ModuleCommandDef, ModuleCommandHandler, Origin } from '@agents-io/protocol';
import type { CommandResult, RouteDelivery } from '@agents-io/session';

/**
 * `/commands` typed into a chat with the deployment (Ingress `onCommand`): the owner operates
 * the session and its harness from the channel. Anyone else's `/text` is an ordinary message.
 * Topic commands without an agent (`/new`, `/topics`, `/switch`) stay with Ingress when the chat
 * keeps topics; here they only say why they do nothing when it does not. The kernel's commands
 * control the IO (`KERNEL_COMMANDS`); the ones that change what a session runs (`/agent`,
 * `/preset`, `/model`, `/effort`, `/plan`, `/bypass`, `/compact`) are the owner-commands module's
 * (`owner-commands.ts`, core-slimming G6 step 5), over the kernel's `KernelContext.runConfig`.
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
 * G6), in registration order (a command's `aliases` are its names too). A module that is off has
 * none here, so its `/name` is an ordinary message. `help` is `/help`'s text: the kernel's lines,
 * each preceded by the module commands' lines placed before it (`ModuleCommandDef.helpBefore`),
 * then the other module commands' lines.
 */
export class CommandTable {
  readonly help: string;
  private readonly names: ReadonlySet<string>;
  private readonly modules = new Map<string, ModuleCommand>();

  constructor(modules: readonly ModuleCommand[] = []) {
    for (const m of modules) {
      for (const name of [m.def.name, ...(m.def.aliases ?? [])]) {
        if (KERNEL_COMMAND_NAMES.includes(name)) throw new Error(`module ${m.module}: /${name} is a kernel command`);
        if (this.modules.has(name)) throw new Error(`module ${m.module}: /${name} is also module ${this.modules.get(name)!.module}'s`);
        this.modules.set(name, m);
      }
    }
    this.names = new Set([...KERNEL_COMMAND_NAMES, ...this.modules.keys()]);
    const placed = (c: KernelCommand) => modules.filter((m) => m.def.helpBefore !== undefined && c.names.includes(m.def.helpBefore)).map((m) => m.def.help);
    const rest = modules.filter((m) => m.def.helpBefore === undefined || !KERNEL_COMMAND_NAMES.includes(m.def.helpBefore)).map((m) => m.def.help);
    this.help = [...KERNEL_COMMANDS.flatMap((c) => [...placed(c), c.help]), ...rest].join('\n');
  }

  /** `/name` is a command here. */
  has(name: string): boolean {
    return this.names.has(name);
  }

  /** The active module whose command `/name` is (its name or an alias), if any. */
  module(name: string): ModuleCommand | undefined {
    return this.modules.get(name);
  }
}

/** The kernel's commands alone (no module active). */
export const KERNEL_COMMAND_TABLE = new CommandTable();

/** `/help` with no module active. */
export const COMMAND_HELP = KERNEL_COMMAND_TABLE.help;

/** The answer of `/new @agent`, `/topics`, `/switch` (and the owner commands' `/agent <name>`) in a chat that goes to one fixed session. */
export const FIXED_SESSION = 'This chat goes to one fixed session (policy.ownerSessionKey), so it has no topics or agents to switch; remove ownerSessionKey to use them.';

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
  /** The compaction command of the harness the session's next turn runs on (`HarnessAdapter.compact`), if it declares one. */
  compactCommand(sessionKey: string): string | undefined;
  /** The agents a chat may talk to (not task agents; the default agent's name when none is configured). */
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
    const operated = mod.def.ownerOnly !== false;
    if (operated && !(await h.allowed(key, a.origin))) return undefined;
    return mod.handler({
      name,
      args,
      sessionKey: key,
      ...(delivery.agent !== undefined ? { agent: delivery.agent } : {}),
      ...(topicConversation !== undefined ? { conversation: topicConversation } : {}),
      origin: a.origin,
      env: a.env,
      input: a.input,
      // The one text a harness gets as it is (CT-2): the kernel marks it, and only its harness's own compaction command.
      compact: async (): Promise<KernelInputResult> => {
        if (!operated && !(await h.allowed(key, a.origin))) return { ok: false, reason: 'forbidden' };
        const command = h.compactCommand(key);
        if (command === undefined) return { ok: false, reason: 'unsupported' };
        return h.input(delivery, { ...a.input, content: [{ type: 'text', text: command }], channelContext: { ...a.input.channelContext, nativeCommand: true } }, 'queue');
      },
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
    case 'new': {
      const conversation = topicConversation;
      const agents = h.agents();
      if (!conversation) return no(FIXED_SESSION);
      const [first, ...rest] = args.split(/\s+/);
      const wanted = (first ?? '').replace(/^@/, '');
      if (!agents.includes(wanted)) return no(`No agent ${wanted || '(none given)'}. Agents: ${agents.join(', ')}`);
      h.setConversationAgent(conversation, wanted);
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
