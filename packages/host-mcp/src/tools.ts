import { createHash } from 'node:crypto';
import { realpath, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  agentRouteKey,
  routeKey,
  type BlobStore,
  type ChannelAdapter,
  type ChannelCaps,
  type ContentBlock,
  type InboundEnvelope,
  type Origin,
  type Policy,
  type RenderedMessage,
  type ReplyRoute,
  type Tier,
  type Topic,
  type TurnContext,
  type TurnProvenance,
  type ModuleToolDef,
  type ModuleToolHandler,
  type Watch,
  type ScheduleDraft,
  type ScheduleView,
  type WatchDraft,
} from '@agents-io/protocol';
import { z } from 'zod';
import { TOOL_DEFS, TOOL_GROUPS, type ToolGroup } from './defs.js';
import {
  TOPIC_ALREADY_HERE,
  TOPIC_HANDED_ALREADY,
  handoverRefusal,
  type Delivery,
  type DeliveryRecord,
  type ExitVerdict,
  type Hub,
  type InboundRewrite,
  type Outbox,
  type Participant,
  type Schedule,
} from '@agents-io/session';
import {
  CHOICE_KEY,
  MENTIONS_KEY,
  OUTPUT_KEY,
  choiceActionId,
  mediaKind,
  mimeOf,
  parseChoiceActionId,
  type ChoiceData,
  type MentionsData,
} from './neutral.js';

/** Name of the `native` session event recording one output-tool message (see `OutputRecord`). */
export const OUTPUT_EVENT = 'agents-io.output';

/** One entry of get_channel_context `participants`: someone the agent can @ with `mention` (by `userId`). */
export interface ParticipantView {
  principal?: string;
  userId?: string;
  name?: string;
  channel?: string;
  isBot?: boolean;
}

/** Most entries get_channel_context lists as participants. */
export const MAX_PARTICIPANTS = 50;

/** Session log events send_file reads at a time while it catches up on the blob refs a session saw (SE-7). */
const SEEN_PAGE = 256;

/** SE-7: the blob refs one session's log shows it saw, each with the name it carried last; read up to `head`. */
interface SeenRefs {
  floor: number;
  head: number;
  refs: Map<string, string | undefined>;
}

/** The blocks that carry a blob: another block with a stray top-level `ref` (the schema does not forbid one) does not count. */
function blobBlocks(content: ContentBlock[] | undefined): Extract<ContentBlock, { ref: string }>[] {
  return (content ?? []).filter((c): c is Extract<ContentBlock, { ref: string }> => c.type === 'image' || c.type === 'file' || c.type === 'audio');
}

/** What a token authenticates: one harness binding (run) of one session. */
export interface ToolBinding {
  sessionKey: string;
  generation: number;
  harnessId?: string;
}

/** Per-call facts from the MCP request. */
export interface CallMeta {
  /** The harness's own tool-call id (Claude Code `_meta["claudecode/toolUseId"]`, …): the idempotency key. */
  toolCallId?: string;
  /** JSON-RPC request id, the fallback key when the harness sends no call id. */
  requestId?: string | number;
}

/** A tool call the host refuses or cannot complete; the message is shown to the model. */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** `native` payload of an `agents-io.output` event. */
export interface OutputRecord {
  tool: string;
  operationId: string;
  route: ReplyRoute;
  msg: RenderedMessage;
  choice?: ChoiceData;
  /** Where the sending turn's inputs came from (decision 4: tagged, never blocked). */
  provenance?: TurnProvenance;
}

export interface ChoiceRecord extends ChoiceData {
  sessionKey: string;
  turnId: string;
  route: ReplyRoute;
  answered: boolean;
}

export interface HostToolsOptions {
  hub: Hub;
  outbox: Outbox;
  policy: Required<Pick<Policy, 'outbound'>>;
  /**
   * U20: the exit check of an output tool's message (`kind: tool`, with its content), before it is recorded
   * as `agents-io.output`: `hold` = the host took it (settled `held`, nothing recorded, the agent is told
   * not to send it again), `deny` = refused like the outbound policy. `undefined`: no check applies.
   */
  exit?: (d: Delivery) => Promise<ExitVerdict | undefined> | undefined;
  /** The running turn of a session (`Lane.currentTurn()`), undefined when idle. */
  turn(sessionKey: string): TurnContext | undefined;
  /** The adapter that sends to a route: its channel and account (several Lark bots share the channel id). */
  adapter(route: ReplyRoute): ChannelAdapter | undefined;
  /** Where file bytes go; adapters read attachments back from the same store. */
  blobs: BlobStore;
  /** Working directory relative paths resolve against (the harness session's cwd). */
  cwd(sessionKey: string): string;
  /** Rendering tier of a route (default: the adapter's `caps.defaultTier`). */
  tier?(route: ReplyRoute): Tier | undefined;
  /** Route keys the owner preregistered (shown by get_channel_context). */
  routes?(): string[];
  /** Channels with no adapter whose ends read the event stream (default `['local']`). */
  eventOnlyChannels?: string[];
  /** Largest file send_file reads (default 30 MiB, Lark's upload limit). */
  maxFileBytes?: number;
  /** May this turn send this file? Default: inside the cwd, or anywhere for a `bypass` turn. */
  fileAccess?(args: { path: string; cwd: string; turn: TurnContext }): boolean | Promise<boolean>;
  /** Sender identity attached to sends (required by channels with `caps.declaresSender`). */
  as?(sessionKey: string): string | undefined;
  /** The agent a session runs: its address `<agent>/<sessionKey>` is what the agent acts as (watches). */
  agentOf?(sessionKey: string): string | undefined;
  /**
   * Watch control (dev-gateway `addWatch`/`removeWatch`/`listWatches`); absent = no watch tools of
   * the kernel's (a module may offer them: `TOOL_GROUP_DEFS.watch`, `watchToolHandlers`).
   */
  watches?: WatchControl;
  /**
   * Schedule control; absent = no schedule tools of the kernel's (a module may offer them:
   * `TOOL_GROUP_DEFS.schedules`, `scheduleToolHandlers`).
   */
  schedules?: ScheduleControl;
  /** The tools a session's agent has (its `tools` setting), for get_channel_context. */
  toolNames?(sessionKey: string): readonly string[] | undefined;
  /**
   * How many watches and schedules the session's agent keeps (created as `agentIdentity`), for
   * get_channel_context's `abilities` while a module offers those tools (the host passed no control
   * for them); with the control the count comes from its `list`.
   */
  kept?(sessionKey: string): { watches: number; schedules: number };
  /** Provenance of a session's turn (`Lane.provenance`), attached to every write the turn makes. */
  provenance?(sessionKey: string, turnId: string): TurnProvenance | undefined;
  /**
   * People who wrote in a session's conversations, most recent first (`Lane.participants`):
   * get_channel_context lists those of the current conversation after this turn's senders, so
   * the agent can @ anyone it has seen there, not only who spoke this turn. Absent: only this turn's.
   */
  participants?(sessionKey: string): Participant[];
  /** Topics of the caller's conversation (decision 6); absent = no session_* tools of the kernel's (a module may offer them: `TOOL_GROUP_DEFS.topics`). */
  topics?: TopicControl;
  /** Live (realtime voice) control (decision 11); absent = no live_* tools of the kernel's (a module may offer them: `TOOL_GROUP_DEFS.live`). */
  live?: LiveControl;
  /**
   * Tools of the host's active modules (core-slimming G6), offered after the kernel's own, in
   * this order; a module that is off is not here. Names are unique and none is a kernel tool's
   * (the kernel's six, `KERNEL_TOOL_NAMES`, and a group's whose control the host passed). A tool
   * that is one of `TOOL_GROUP_DEFS` is listed and checked as `TOOL_DEFS` has it. A module may
   * offer some of its tools only at times (`ModuleTools.offered`).
   */
  modules?: readonly ModuleTools[];
}

/** One module's tools: what the endpoint lists (`ModuleManifest.mcpTools`) and what runs them (`ModuleInstance.tools`). */
export interface ModuleTools {
  /** The module's id. */
  module: string;
  tools: readonly ModuleToolDef[];
  /** A handler for each of `tools`, by name. */
  handlers: Readonly<Record<string, ModuleToolHandler>>;
  /**
   * Which of `tools` the endpoint offers now (default: all of them), asked at every request to it
   * (`HostTools.withheld`): one it leaves out is neither listed nor callable in that request (the
   * daemon's `tools.live`: only while a running channel can open a live). A throw offers none.
   */
  offered?(): Iterable<string>;
}

/**
 * A module's tool as the endpoint lists it: its input schema as zod (what the MCP SDK registers):
 * its JSON Schema as zod (`moduleToolInput`), or, for one of `TOOL_GROUP_DEFS`, the zod shape
 * `TOOL_DEFS` has.
 */
export interface ModuleToolEntry {
  module: string;
  name: string;
  description: string;
  input: z.ZodRawShape | z.ZodType;
  readOnly: boolean;
}

/**
 * A module tool's input (`ModuleToolDef.input`, a JSON Schema object) as the zod schema the MCP
 * endpoint registers and checks calls against. Throws when it is not an object schema zod can read.
 */
export function moduleToolInput(def: Pick<ModuleToolDef, 'name' | 'input'>): z.ZodType {
  const t = (def.input as { type?: unknown } | undefined)?.type;
  if (t !== 'object') throw new Error(`tool ${JSON.stringify(def.name)}: input must be a JSON Schema object (type "object")`);
  try {
    return z.fromJSONSchema(def.input as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (e) {
    throw new Error(`tool ${JSON.stringify(def.name)}: input is not a JSON Schema the endpoint can read: ${(e as Error).message}`);
  }
}

/** What the live_* tools need from the host (decision 11). */
export interface LiveControl {
  /** Open a live on `channel` (default: the turn's reply channel) and attach it to this session's harness thread. */
  join(sessionKey: string, turn: TurnContext, a: { target: string; channel?: string; instructions?: string; voice?: string }): Promise<{ liveId: string; title: string; route: string }>;
  /** Speak in the session's live. `operationId` names the side effect (`explain`, EX-2); a retried call with the same one does not speak again. */
  say(sessionKey: string, text: string, a: { operationId: string; turnId: string }): Promise<void>;
  /** Ends the session's live; false when none runs. */
  leave(sessionKey: string): Promise<boolean>;
}

/**
 * What the session_* tools need from the host. The host moves the conversation's
 * current topic and hands the turn's triggering inputs to the topic now current.
 */
export interface TopicControl {
  /** The topics of the conversation this session is a topic of (newest activity first), or undefined when it is not a topic session. */
  list(sessionKey: string): Topic[] | undefined;
  /** Start a new topic (current from now on) and hand the turn's inputs to it, the summary first as a labelled context item; `operationId` is the tool call's (TP-1: a retry of it answers the same). */
  rotate(sessionKey: string, turn: TurnContext, a: { title: string; summary: string; operationId: string }): Promise<TopicHandover>;
  /** Make a parked topic current again (its harness session resumes natively) and hand the turn's inputs to it; `operationId` as for `rotate`. */
  switch(sessionKey: string, turn: TurnContext, a: { topicId: string; operationId: string }): Promise<TopicHandover>;
}

export interface TopicHandover {
  topic: Topic;
  previous?: Topic;
  /** Input ids as handed to the topic. */
  handed: string[];
}

/** What the watch tools need from the host; `Policy.watch` is applied behind `add`. */
export interface WatchControl {
  add(by: Origin, draft: WatchDraft): Promise<{ ok: true; watch: Watch } | { ok: false; code: string; message: string }>;
  remove(by: Origin, id: string): Promise<{ ok: true; removed: boolean } | { ok: false; code: string; message: string }>;
  list(sessionKey: string): Watch[];
}

/** What the schedule tools need from the host; `Policy.schedule` (limits) is applied behind `put`. */
export interface ScheduleControl {
  put(by: Origin, draft: ScheduleDraft): Promise<{ ok: true; schedule: Schedule } | { ok: false; code: string; message: string }>;
  remove(by: Origin, id: string): Promise<{ ok: true; removed: boolean } | { ok: false; code: string; message: string }>;
  list(sessionKey: string): Schedule[];
}

/** Declared identity of a session's agent: what its watches are created by. */
export const agentIdentity = (sessionKey: string) => `session:${sessionKey}`;

/**
 * The origin a session's agent acts with (creating watches): kind `agent`, evidence `daemon`
 * (this daemon runs it), `via` = its session address as a route key (`agent:<agent>:<sessionKey>`,
 * agent-messaging §4.1), declared = its session identity. No principal: watches stay created by
 * `session:<key>` (`Policy.watch` treats it as an agent, never an owner).
 */
export function agentOrigin(sessionKey: string, agent?: string): Origin {
  return { kind: 'agent', principal: null, evidence: 'daemon', declared: agentIdentity(sessionKey), via: agent !== undefined ? agentRouteKey({ agent, sessionKey }) : `agent:${sessionKey}`, adapter: 'agent' };
}

const WATCH_KINDS = ['dm', 'group', 'thread', 'meeting', 'mail', 'other'];
const WATCH_MODES = ['context', 'digest', 'trigger'];

/** Caps of an event-only end (the terminal): it prints whatever the stream says. */
const EVENT_ONLY_CAPS: ChannelCaps = {
  text: { maxChars: 100_000, markdown: 'full' },
  edit: false,
  buttons: false,
  media: { in: [], out: ['image', 'file', 'audio'] },
  voiceOut: 'none',
  threads: false,
  approvals: 'buttons',
  defaultTier: 'full',
  evidence: ['device_only'],
  declaresSender: false,
};

const MAX_OPTIONS = 10;
const NUMBERS = /^\s*#?\d+(?:\s*[,，、;\s]\s*#?\d+)*\s*$/;

const str = (v: unknown, what: string, opt = false): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (opt) return undefined;
    throw new ToolError(`${what} is required`);
  }
  if (typeof v !== 'string') throw new ToolError(`${what} must be a string`);
  return v;
};

/**
 * "current": the turn's reply route; for a turn without one (a live's delegated turn,
 * decision 11) the one route all its inputs reply to, if they share one.
 */
function currentRoute(turn: TurnContext): ReplyRoute | null {
  if (turn.replyRoute) return turn.replyRoute;
  const routes = turn.inputs.map((i) => i.replyRoute);
  const first = routes[0];
  return first && routes.every((r) => r && routeKey(r) === routeKey(first)) ? first : null;
}

/** The routes a turn knows: its reply route, the routes added to it, its inputs' reply routes. */
function knownRoutes(turn: TurnContext): ReplyRoute[] {
  return [turn.replyRoute, ...turn.deliveries, ...turn.inputs.map((i) => i.replyRoute)].filter((r): r is ReplyRoute => !!r);
}

/** A tool's `route` argument: "current" (or nothing) = the turn's reply route; otherwise a route key. */
function parseRoute(turn: TurnContext, spec: string | undefined): ReplyRoute {
  if (spec === undefined || spec === 'current' || spec === 'reply') {
    const r = currentRoute(turn);
    if (!r) throw new ToolError('this turn has no reply route; name a destination route key');
    return r;
  }
  const known = knownRoutes(turn).find((r) => routeKey(r) === spec);
  if (known) return known;
  const parts = spec.split(':');
  if (parts.length < 3 || parts.some((p) => !p)) throw new ToolError(`route must be "current" or a route key channel:account:conversation[:thread], got ${JSON.stringify(spec)}`);
  const [channel, account, ...rest] = parts;
  return { channel: channel!, account: account!, conversationId: rest.join(':') };
}

/**
 * The output tools, independent of MCP. Every call resolves the session's running
 * turn, checks the destination against `Policy.outbound`, delivers through the
 * Outbox (operationId from the tool call id, so a retried call never sends twice)
 * and records what was sent as an `agents-io.output` event; the Outbox adds
 * `delivery.settled`. Channel specifics stay in the adapters: tools only build a
 * neutral `RenderedMessage` (text fallback + attachments/actions/channelData).
 */
export class HostTools {
  private readonly choices = new Map<string, ChoiceRecord>();
  /** SE-7: per session, the refs its log showed so far, so a send by blob reads only what the log gained since. */
  private readonly seen = new Map<string, SeenRefs>();
  private readonly eventOnly: Set<string>;
  /** The active modules' tools by name, in catalog order (`HostToolsOptions.modules`). */
  private readonly moduleTools = new Map<string, { entry: ModuleToolEntry; def: ModuleToolDef; handler: ModuleToolHandler }>();
  /** The modules that say which of their tools they offer now (`ModuleTools.offered`). */
  private readonly offering: { names: readonly string[]; offered: () => Iterable<string> }[] = [];
  /**
   * The tool groups of `TOOL_DEFS` (`TOOL_GROUPS`) by tool name: over the host's control when it
   * passed one (`offered`), else over none (a direct `call` answers that the group is not available,
   * unless a module offers the tool).
   */
  private readonly groupTools = new Map<string, { handler: ModuleToolHandler; needsTurn: boolean; offered: boolean }>();

  constructor(private readonly o: HostToolsOptions) {
    this.eventOnly = new Set(o.eventOnlyChannels ?? ['local']);
    const groups: { readonly [G in ToolGroup]: [Record<string, ModuleToolHandler>, boolean] } = {
      watch: [watchToolHandlers(o.watches ? sessionWatches(o.watches, o.agentOf) : undefined), !!o.watches],
      schedules: [scheduleToolHandlers(o.schedules ? sessionSchedules(o.schedules, o.agentOf, o.policy) : undefined), !!o.schedules],
      live: [liveToolHandlers(o.live), !!o.live],
      topics: [topicToolHandlers(o.topics), !!o.topics],
    };
    for (const g of Object.keys(TOOL_GROUPS) as ToolGroup[]) {
      const [handlers, offered] = groups[g];
      for (const def of TOOL_GROUP_DEFS[g]) this.groupTools.set(def.name, { handler: handlers[def.name]!, needsTurn: def.needsTurn !== false, offered });
    }
    for (const m of o.modules ?? []) {
      for (const def of m.tools) {
        if (this.moduleTools.has(def.name)) throw new Error(`module ${m.module}: tool ${JSON.stringify(def.name)} is also module ${this.moduleTools.get(def.name)!.entry.module}'s`);
        const handler = m.handlers[def.name];
        if (typeof handler !== 'function') throw new Error(`module ${m.module}: tool ${JSON.stringify(def.name)} has no handler`);
        // One of host-mcp's own group definitions is listed and checked as TOOL_DEFS has it (its zod shape).
        const entry: ModuleToolEntry = { module: m.module, name: def.name, description: def.description, input: GROUP_SHAPES.get(def) ?? moduleToolInput(def), readOnly: def.readOnly === true };
        this.moduleTools.set(def.name, { entry, def, handler });
      }
      if (m.offered) this.offering.push({ names: m.tools.map((t) => t.name), offered: m.offered.bind(m) });
    }
  }

  /**
   * The active modules' tools the endpoint does not offer now (`ModuleTools.offered`): asked of
   * each module that says, at every call, so they come and go with what they need.
   */
  withheld(): Set<string> {
    const out = new Set<string>();
    for (const m of this.offering) {
      let now: Set<string>;
      try {
        now = new Set(m.offered());
      } catch {
        now = new Set();
      }
      for (const n of m.names) if (!now.has(n)) out.add(n);
    }
    return out;
  }

  /** The active modules' tools, in the order the endpoint lists them (after the kernel's). */
  moduleCatalog(): ModuleToolEntry[] {
    return [...this.moduleTools.values()].map((t) => t.entry);
  }

  /**
   * Provenance of the turn running in the binding's session, if any: what the host
   * sees with each write (output records, `onCall`). Since harnesses take their
   * environment per session, not per turn, this is how it reaches the host.
   */
  provenanceOf(b: ToolBinding): TurnProvenance | undefined {
    const turn = this.o.turn(b.sessionKey);
    return turn ? this.o.provenance?.(b.sessionKey, turn.turnId) : undefined;
  }

  /** Whether the watch tools are offered as the kernel's (the host passed `watches`; a module may offer them otherwise). */
  get hasWatches(): boolean {
    return !!this.o.watches;
  }
  /** Whether the schedule tools are offered as the kernel's (the host passed `schedules`; a module may offer them otherwise). */
  get hasSchedules(): boolean {
    return !!this.o.schedules;
  }

  /** Whether the live_* tools are offered as the kernel's (the host passed `live`; a module may offer them otherwise). */
  get hasLive(): boolean {
    return !!this.o.live;
  }

  /** Whether the session_* tools are offered as the kernel's (the host passed `topics`; a module may offer them otherwise). */
  get hasTopics(): boolean {
    return !!this.o.topics;
  }

  /** Run one tool. Returns the JSON text result; throws ToolError for anything the model should fix. */
  async call(b: ToolBinding, name: string, args: Record<string, unknown>, meta: CallMeta = {}): Promise<string> {
    // A group tool runs over the host's control when it passed one; else a module's tool of that name, if any.
    const g = this.groupTools.get(name);
    const mod = g?.offered ? undefined : this.moduleTools.get(name);
    const group = mod ? undefined : g;
    if ((group && !group.needsTurn) || (mod && mod.def.needsTurn === false)) {
      // A tool that needs no turn still gets the one running, if any (schedule_add: a route is "current" of it).
      const running = this.o.turn(b.sessionKey);
      const c = { sessionKey: b.sessionKey, args, ...(running ? { turn: running } : {}) };
      return json(group ? await group.handler(c) : await this.moduleTool(mod!.handler, c));
    }
    const turn = this.o.turn(b.sessionKey);
    if (!turn) throw new ToolError('no turn is running in this session: output tools only work while you are answering a message');
    const key = meta.toolCallId ?? `g${b.generation}:${turn.turnId}:rpc${meta.requestId ?? Math.random().toString(36).slice(2)}`;
    const operationId = `tool:${b.sessionKey}:${key}`;
    switch (name) {
      case 'get_channel_context':
        return json(this.channelContext(b, turn));
      case 'send_file':
        return json(await this.sendFile(b, turn, args, operationId));
      case 'ask_choice':
        return json(await this.askChoice(b, turn, args, operationId));
      case 'mention':
        return json(await this.mention(b, turn, args, operationId));
      case 'reply_to':
      case 'send_message':
        return json(await this.message(b, turn, name, args, operationId));
      default:
        if (group) return json(await group.handler({ sessionKey: b.sessionKey, turn, args, operationId }));
        if (mod) return json(await this.moduleTool(mod.handler, { sessionKey: b.sessionKey, turn, args, operationId }));
        throw new ToolError(`unknown tool ${name}`);
    }
  }

  /** Run a module's tool (`ModuleToolHandler`): its result as JSON (`null` for undefined); an error named `ToolError` is the model's to read. */
  private async moduleTool(handler: ModuleToolHandler, c: Parameters<ModuleToolHandler>[0]): Promise<unknown> {
    try {
      const r = await handler(c);
      return r === undefined ? null : r;
    } catch (e) {
      if (e instanceof ToolError) throw e;
      if (e instanceof Error && e.name === 'ToolError') throw new ToolError(e.message);
      throw e;
    }
  }

  // ---- context ----------------------------------------------------------------------------

  private caps(route: ReplyRoute): ChannelCaps {
    if (this.eventOnly.has(route.channel)) return EVENT_ONLY_CAPS;
    const a = this.o.adapter(route);
    if (!a) throw new ToolError(`no channel adapter for ${route.channel} (account ${route.account})`);
    return a.caps(route.account);
  }

  /**
   * Who the agent can address with mention: this turn's senders first, then (with
   * `participants`) the others seen in the current conversation, most recent first; at most
   * `MAX_PARTICIPANTS`. Ids are channel user ids (what an adapter turns into a mention).
   */
  private participants(turn: TurnContext, sessionKey: string): ParticipantView[] {
    const out = new Map<string, ParticipantView>();
    const add = (k: string | undefined, p: ParticipantView) => {
      if (!k || out.has(k) || out.size >= MAX_PARTICIPANTS) return;
      out.set(k, p);
    };
    for (const i of turn.inputs) {
      const ch = i.origin.adapter;
      const pid = i.origin.principal?.id;
      const ctxId = i.channelContext.senderId;
      const userId = typeof ctxId === 'string' ? ctxId : pid?.startsWith(`${ch}:`) ? pid.slice(ch.length + 1) : undefined;
      const name = typeof i.channelContext.senderName === 'string' ? i.channelContext.senderName : undefined;
      const isBot = i.channelContext.senderIsBot === true;
      add(userId ?? pid ?? name, { ...(pid ? { principal: pid } : {}), ...(userId ? { userId } : {}), ...(name ? { name } : {}), channel: ch, ...(isBot ? { isBot } : {}) });
    }
    const r = currentRoute(turn);
    if (r) {
      for (const p of this.o.participants?.(sessionKey) ?? []) {
        // Only people of this conversation: an id from another chat would not reach anyone here.
        if (p.channel !== r.channel || (p.conversationId !== undefined && p.conversationId !== r.conversationId)) continue;
        add(p.userId, { ...(p.principal ? { principal: p.principal } : {}), userId: p.userId, ...(p.name ? { name: p.name } : {}), channel: p.channel, ...(p.isBot ? { isBot: true } : {}) });
      }
    }
    return [...out.values()];
  }

  private channelContext(b: ToolBinding, turn: TurnContext) {
    const r = currentRoute(turn);
    const first = turn.inputs[0]?.channelContext ?? {};
    const pre = this.o.routes?.() ?? [];
    if (!r) return { turnId: turn.turnId, replyRoute: null, note: 'this turn has no reply route', preregisteredRoutes: pre };
    const caps = this.caps(r);
    return {
      turnId: turn.turnId,
      route: routeKey(r),
      channel: r.channel,
      conversationKind: first.conversationKind ?? null,
      tier: this.o.tier?.(r) ?? caps.defaultTier,
      caps: {
        markdown: caps.text.markdown,
        maxChars: caps.text.maxChars,
        buttons: caps.buttons,
        editsMessages: caps.edit,
        threads: caps.threads,
        mediaOut: caps.media.out,
        approvals: caps.approvals,
      },
      participants: this.participants(turn, b.sessionKey),
      // What you can do besides answering: the tools you have (send_message, schedule_add, watch_add, …).
      abilities: {
        tools: this.o.toolNames?.(b.sessionKey) ?? null,
        schedules: this.offers('schedule_list') ? { mine: this.o.schedules ? this.o.schedules.list(b.sessionKey).filter((x) => x.createdBy === agentIdentity(b.sessionKey)).length : (this.o.kept?.(b.sessionKey).schedules ?? 0) } : null,
        watches: this.offers('watch_list') ? { mine: this.o.watches ? this.o.watches.list(b.sessionKey).filter((x) => x.createdBy === agentIdentity(b.sessionKey)).length : (this.o.kept?.(b.sessionKey).watches ?? 0) } : null,
      },
      allowedDestinations: {
        current: routeKey(r),
        alsoThisTurn: turn.deliveries.map(routeKey),
        preregistered: pre,
        note: 'reply_to/send_message accept "current" or one of these route keys; anything else is denied by the host policy',
      },
      eventOnly: this.eventOnly.has(r.channel) || undefined,
    };
  }

  /** The endpoint offers this group tool now: over the host's control, or a module's (unless it withholds it now). */
  private offers(name: string): boolean {
    return this.groupTools.get(name)?.offered === true || (this.moduleTools.has(name) && !this.withheld().has(name));
  }

  // ---- destinations -----------------------------------------------------------------------

  /** "current" (or nothing) = the turn's reply route; otherwise a route key. */
  private parseRoute(turn: TurnContext, spec: string | undefined): ReplyRoute {
    return parseRoute(turn, spec);
  }

  private async allowed(b: ToolBinding, turn: TurnContext, tool: string, route: ReplyRoute): Promise<void> {
    const verdict = await this.o.policy.outbound({ from: turn, to: route });
    if (verdict === 'allow') return;
    const k = routeKey(route);
    const pre = this.o.routes?.() ?? [];
    this.o.hub.append(b.sessionKey, {
      ts: Date.now(),
      turnId: turn.turnId,
      level: 'detail',
      audience: 'status',
      durability: 'durable',
      visibility: 'operators',
      body: { t: 'notice', code: 'other', message: `${tool} to ${k} denied by outbound policy` },
    });
    const allowedList = [turn.replyRoute ? `this turn's reply route (${routeKey(turn.replyRoute)})` : undefined, pre.length ? `preregistered routes ${pre.join(', ')}` : undefined]
      .filter(Boolean)
      .join(' and ');
    throw new ToolError(`destination ${k} is not allowed by the host's outbound policy; allowed: ${allowedList || 'none'}. Do not retry with another destination unless the user asks for it.`);
  }

  private async deliver(b: ToolBinding, turn: TurnContext, tool: string, route: ReplyRoute, msg: RenderedMessage, operationId: string, choice?: ChoiceData): Promise<DeliveryRecord> {
    const prior = this.o.outbox.get(operationId);
    const body: RenderedMessage = { ...msg, channelData: { ...(msg.channelData as object | undefined), [OUTPUT_KEY]: { tool } } };
    if (!prior && this.o.exit) {
      // U20: asked before anything is recorded; the same operationId again (a retried call) is not asked again.
      const d = { operationId, sessionKey: b.sessionKey, turnId: turn.turnId, route, from: turn, kind: 'tool' as const, content: body };
      const p = this.o.exit(d);
      const v = p === undefined ? undefined : await p;
      if (v?.verdict === 'hold') {
        this.o.outbox.hold(d, v.reason);
        throw new ToolError(`宿主拿走了这条，没有发出${v.reason ? `（${v.reason}）` : ''}。不要再发。`);
      }
      if (v && v.verdict !== 'allow') throw new ToolError(`destination ${routeKey(route)} is not allowed by the host's outbound policy${v.reason ? ` (${v.reason})` : ''}. Do not retry with another destination unless the user asks for it.`);
    }
    if (prior?.status === 'held') throw new ToolError(`the host took this message; it was not sent${prior.reason ? ` (${prior.reason})` : ''}. Do not send it again.`);
    if (!prior) {
      const provenance = this.o.provenance?.(b.sessionKey, turn.turnId);
      const rec: OutputRecord = { tool, operationId, route, msg: body, ...(choice ? { choice } : {}), ...(provenance ? { provenance } : {}) };
      this.o.hub.append(b.sessionKey, {
        ts: Date.now(),
        turnId: turn.turnId,
        level: 'primary',
        audience: 'answer',
        durability: 'durable',
        visibility: 'participants',
        body: { t: 'native', name: OUTPUT_EVENT },
        native: rec,
      });
    }
    let rec: DeliveryRecord;
    const d = { operationId, sessionKey: b.sessionKey, turnId: turn.turnId, route, kind: 'tool' as const, exitChecked: true };
    if (this.eventOnly.has(route.channel)) {
      // The terminal and other stream ends render the output event themselves.
      rec = await this.o.outbox.deliver(d, async () => ({ providerMessageId: operationId }));
    } else {
      const adapter = this.o.adapter(route);
      if (!adapter) throw new ToolError(`no channel adapter for ${route.channel} (account ${route.account})`);
      const as = this.o.as?.(b.sessionKey);
      rec = await this.o.outbox.send(adapter, { ...d, msg: body, ...(as !== undefined ? { as } : {}) });
    }
    if (rec.status !== 'delivered') throw new ToolError(`delivery to ${routeKey(route)} ${rec.status}${rec.error ? `: ${rec.error}` : ''}`);
    return rec;
  }

  private sent(rec: DeliveryRecord, extra: Record<string, unknown> = {}) {
    return { ok: true, delivered: routeKey(rec.route), operationId: rec.operationId, ...(rec.providerMessageId && rec.providerMessageId !== rec.operationId ? { messageId: rec.providerMessageId } : {}), ...extra };
  }

  // ---- tools ------------------------------------------------------------------------------

  private async sendFile(b: ToolBinding, turn: TurnContext, args: Record<string, unknown>, operationId: string) {
    const path = str(args.path, 'path', true);
    const blob = str(args.blob, 'blob', true);
    const caption = str(args.caption, 'caption', true);
    let name = str(args.name, 'name', true);
    if (!path === !blob) throw new ToolError('give exactly one of path (a file on disk) or blob (a blob ref such as sha256:…)');
    const route = this.parseRoute(turn, undefined);
    await this.allowed(b, turn, 'send_file', route);
    let ref: string;
    let mime: string;
    let size: number;
    if (path) {
      const cwd = this.o.cwd(b.sessionKey);
      const abs = isAbsolute(path) ? path : resolve(cwd, path);
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        throw new ToolError(`file not found: ${path} (relative paths resolve against ${cwd})`);
      }
      const st = await stat(real);
      if (!st.isFile()) throw new ToolError(`${path} is not a regular file`);
      const max = this.o.maxFileBytes ?? 30 * 1024 * 1024;
      if (st.size === 0) throw new ToolError(`${path} is empty`);
      if (st.size > max) throw new ToolError(`${path} is ${st.size} bytes; the limit is ${max}`);
      const access = this.o.fileAccess;
      const ok = access ? await access({ path: real, cwd, turn }) : turn.run.profile === 'bypass' || inside(real, await realpath(cwd).catch(() => cwd));
      if (!ok) throw new ToolError(`${path} is outside the working directory and this turn may not send it`);
      name ??= basename(real);
      mime = mimeOf(name);
      const bytes = new Uint8Array(await readFile(real));
      size = bytes.byteLength;
      ref = await this.o.blobs.put(bytes, { mime, name });
    } else {
      // SE-7: the store is shared by every session, so a ref is only this session's to send when it saw it.
      // One it did not reads like a missing one: the answer does not say whether the store has it.
      const seen = this.seenBlob(b.sessionKey, turn, blob!);
      if (!seen) throw new ToolError(`unknown blob ${blob}`);
      let got;
      try {
        got = await this.o.blobs.get(blob!);
      } catch {
        throw new ToolError(`unknown blob ${blob}`);
      }
      ref = blob!;
      mime = got.mime;
      // The name this session saw, not the store's: the store keeps the name the bytes first came
      // with, which may be another session's (the same statement under its private name).
      name ??= seen.name ?? 'file';
      size = got.bytes.byteLength;
    }
    const caps = this.caps(route);
    const kind = mediaKind(mime);
    const sendAs = caps.media.out.includes(kind) ? kind : caps.media.out.includes('file') ? 'file' : undefined;
    if (!sendAs) throw new ToolError(`${route.channel} cannot send files (caps.media.out is empty)`);
    // An image the channel can only send as a file goes as a generic file.
    const sendMime = sendAs === kind ? mime : 'application/octet-stream';
    const msg: RenderedMessage = { text: caption ?? '', attachments: [{ ref, mime: sendMime, name }] };
    const rec = await this.deliver(b, turn, 'send_file', route, msg, operationId);
    return this.sent(rec, { name, mime: sendMime, bytes: size, ref });
  }

  /**
   * SE-7: where a blob ref appeared in this session, newest first: a content block of one of its
   * inputs (this turn's, or any its log admitted, context and handed-over inputs included) or an
   * attachment it sent (`agents-io.output`, a send_file by path too). Answers the name it carried
   * there, undefined when the session never saw the ref. Log history trimmed away no longer counts.
   */
  private seenBlob(sessionKey: string, turn: TurnContext, ref: string): { name?: string } | undefined {
    const named = (name: string | undefined) => (name ? { name } : {});
    for (const i of [...turn.inputs].reverse()) {
      const hit = blobBlocks(i.content).find((c) => c.ref === ref);
      if (hit) return named(hit.name);
    }
    const refs = this.seenRefs(sessionKey);
    return refs.has(ref) ? named(refs.get(ref)) : undefined;
  }

  /**
   * SE-7: the refs this session's log shows it saw, read once and from then on only the events the
   * log gained since, a page at a time: a long-lived session's log is long, and a ref it never saw
   * would otherwise read all of it on every call. A later event's name replaces an earlier one's (the
   * newest wins); a floor that moved means trimmed history, so what is left is read again.
   */
  private seenRefs(sessionKey: string): Map<string, string | undefined> {
    const log = this.o.hub.log;
    const floor = log.floor(sessionKey);
    let s = this.seen.get(sessionKey);
    if (!s || s.floor !== floor) this.seen.set(sessionKey, (s = { floor, head: floor, refs: new Map() }));
    const head = log.head(sessionKey);
    while (s.head < head) {
      const page = log.read(sessionKey, s.head, SEEN_PAGE);
      if (!page.length) break;
      for (const e of page) {
        const body = e.body;
        // An output only as deliver wrote it (participants): the lane writes a harness's own native events as
        // operators or internal (visibilityOf), so one a harness happens to name agents-io.output does not count.
        const found =
          body.t === 'input.admitted'
            ? blobBlocks(body.input?.content)
            : body.t === 'native' && body.name === OUTPUT_EVENT && e.visibility === 'participants'
              ? ((e.native as OutputRecord | undefined)?.msg.attachments ?? [])
              : [];
        // Backwards, so that within one event the first block's name stands, as for this turn's inputs.
        for (const a of [...found].reverse()) s.refs.set(a.ref, a.name);
      }
      s.head = page[page.length - 1]!.seq;
    }
    return s.refs;
  }

  private async askChoice(b: ToolBinding, turn: TurnContext, args: Record<string, unknown>, operationId: string) {
    const question = str(args.question, 'question')!;
    const options = args.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS || options.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new ToolError(`options must be 2 to ${MAX_OPTIONS} non-empty strings`);
    }
    const multi = args.multi === true;
    const route = this.parseRoute(turn, undefined);
    await this.allowed(b, turn, 'ask_choice', route);
    const choiceId = `ch_${createHash('sha256').update(operationId).digest('hex').slice(0, 10)}`;
    const opts = (options as string[]).map((x) => x.trim());
    const caps = this.caps(route);
    const numbered = opts.map((x, i) => `${i + 1}. ${x}`).join('\n');
    const how = this.eventOnly.has(route.channel)
      ? `Answer with /choose ${choiceId} <number>${multi ? '[,<number>…]' : ''}`
      : multi
        ? 'Reply with the numbers of your choices, e.g. 1,3'
        : 'Reply with the number of your choice';
    const choice: ChoiceData = { choiceId, question, options: opts, multi };
    const msg: RenderedMessage = caps.buttons
      ? { text: question, actions: opts.map((label, i) => ({ id: choiceActionId(choiceId, i + 1), label })), channelData: { [CHOICE_KEY]: choice } }
      : { text: `${question}\n\n${numbered}\n\n${how}`, channelData: { [CHOICE_KEY]: choice } };
    const existing = this.choices.get(choiceId);
    this.choices.set(choiceId, existing ?? { ...choice, sessionKey: b.sessionKey, turnId: turn.turnId, route, answered: false });
    const rec = await this.deliver(b, turn, 'ask_choice', route, msg, operationId, choice);
    return this.sent(rec, {
      choiceId,
      note: 'The question is shown to the user now. Their answer is NOT returned here: it arrives as your next input, an [event choice] with this choiceId and the selected option(s) (or a plain-text reply). End your turn now with a short line saying you are waiting; do not call ask_choice again for the same question.',
    });
  }

  private async mention(b: ToolBinding, turn: TurnContext, args: Record<string, unknown>, operationId: string) {
    const ids = args.user_ids;
    const text = str(args.text, 'text')!;
    if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string' || !x)) throw new ToolError('user_ids must be a non-empty array of user id strings');
    const route = this.parseRoute(turn, undefined);
    await this.allowed(b, turn, 'mention', route);
    const people = this.participants(turn, b.sessionKey);
    const targets = (ids as string[]).map((raw) => {
      const id = raw.startsWith(`${route.channel}:`) ? raw.slice(route.channel.length + 1) : raw;
      const p = people.find((x) => x.userId === id || x.principal === raw);
      // The adapter turns `id` into a platform at-tag, so hand it the channel's own user id:
      // a principal of a host that rewrote it (`lb:<uuid>`) would resolve to nothing and the
      // mention would silently degrade to plain `@name` text.
      return { id: p?.userId ?? id, ...(p?.name ? { name: p.name } : {}) };
    });
    const data: MentionsData = { targets, text };
    const fallback = `${targets.map((t) => `@${t.name ?? t.id}`).join(' ')} ${text}`;
    const rec = await this.deliver(b, turn, 'mention', route, { text: fallback, channelData: { [MENTIONS_KEY]: data } }, operationId);
    return this.sent(rec, { mentioned: targets.map((t) => t.id) });
  }

  private async message(b: ToolBinding, turn: TurnContext, tool: 'reply_to' | 'send_message', args: Record<string, unknown>, operationId: string) {
    const text = str(args.text, 'text')!;
    const spec = str(args.route, 'route');
    let route = this.parseRoute(turn, spec);
    if (tool === 'send_message') {
      const { replyToMessageId: _r, ...rest } = route;
      route = rest;
    } else {
      const mid = str(args.message_id, 'message_id', true);
      if (mid) route = { ...route, replyToMessageId: mid };
    }
    await this.allowed(b, turn, tool, route);
    this.caps(route); // fails clearly when there is no adapter for the channel
    const rec = await this.deliver(b, turn, tool, route, { text }, operationId);
    return this.sent(rec);
  }

  // ---- answers coming back ----------------------------------------------------------------

  /** A choice this gateway asked (memory first, then the session logs: survives a restart). */
  choice(choiceId: string): ChoiceRecord | undefined {
    const hit = this.choices.get(choiceId);
    if (hit) return hit;
    const log = this.o.hub.log;
    for (const sk of log.sessions()) {
      for (const e of log.read(sk, 0)) {
        if (e.body.t !== 'native' || e.body.name !== OUTPUT_EVENT) continue;
        const r = e.native as OutputRecord | undefined;
        if (r?.choice?.choiceId !== choiceId) continue;
        const rec: ChoiceRecord = { ...r.choice, sessionKey: sk, turnId: e.turnId ?? '', route: r.route, answered: false };
        this.choices.set(choiceId, rec);
        return rec;
      }
    }
    return undefined;
  }

  /** The `choice` event block for an answer. Numbers are 1-based. Throws ToolError for a bad answer. */
  choiceAnswer(choiceId: string, numbers: number[], via: 'button' | 'reply' | 'command'): { sessionKey: string; content: ContentBlock[] } {
    const c = this.choice(choiceId);
    if (!c) throw new ToolError(`unknown choice ${choiceId}`);
    const picked = [...new Set(numbers)];
    if (!picked.length || picked.some((n) => !Number.isInteger(n) || n < 1 || n > c.options.length)) {
      throw new ToolError(`choose between 1 and ${c.options.length}`);
    }
    if (!c.multi && picked.length > 1) throw new ToolError('this question takes one answer');
    const stale = c.answered;
    c.answered = true;
    return {
      sessionKey: c.sessionKey,
      content: [
        {
          type: 'event',
          name: 'choice',
          data: {
            choiceId,
            question: c.question,
            selected: picked.map((n) => ({ n, label: c.options[n - 1]! })),
            multi: c.multi,
            via,
            ...(stale ? { alreadyAnswered: true } : {}),
          },
        },
      ],
    };
  }

  /**
   * `IngressOptions.rewrite`: a click on an ask_choice button, or a plain numbered
   * reply on the route where a choice is still open, becomes a `choice` event for
   * the session that asked.
   */
  rewriteInbound({ env }: { env: InboundEnvelope; origin: Origin; sessionKey: string }): InboundRewrite | undefined {
    const c0 = env.content[0];
    if (env.content.length === 1 && c0?.type === 'event' && c0.name === 'action' && typeof c0.data.actionId === 'string') {
      const a = parseChoiceActionId(c0.data.actionId);
      if (!a) return undefined;
      let numbers: number[];
      if (a.n === 'form') {
        const fv = c0.data.formValue as Record<string, unknown> | undefined;
        const raw = fv ? Object.values(fv).flat() : [];
        numbers = raw.map((x) => Number(x)).filter((n) => Number.isFinite(n));
      } else numbers = [a.n];
      try {
        return this.choiceAnswer(a.choiceId, numbers, 'button');
      } catch (e) {
        return { content: [{ type: 'text', text: `[choice click ignored: ${(e as Error).message}]` }] };
      }
    }
    if (!env.replyRoute || !env.content.length || env.content.some((c) => c.type !== 'text' && !(c.type === 'quote'))) return undefined;
    const text = env.content
      .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .split('\n')
      .filter((l) => l.trim() && !/^subject:/i.test(l.trim()))
      .join(' ');
    if (!NUMBERS.test(text)) return undefined;
    const here = routeKey(env.replyRoute);
    const open = [...this.choices.values()].filter((c) => !c.answered && routeKey(c.route) === here).at(-1);
    if (!open) return undefined;
    const numbers = text.match(/\d+/g)!.map(Number);
    try {
      return this.choiceAnswer(open.choiceId, numbers, 'reply');
    } catch {
      return undefined; // not a valid answer: leave the text as it is
    }
  }

  /** Local clients: enrich a `choice` event (`{choiceId, selected: [n…]}`) into the full answer. */
  normalizeLocal(content: ContentBlock[]): ContentBlock[] {
    return content.flatMap((c) => {
      if (c.type !== 'event' || c.name !== 'choice' || typeof c.data.choiceId !== 'string') return [c];
      const sel = Array.isArray(c.data.selected) ? c.data.selected : [c.data.selected];
      const numbers = sel.map((x) => (typeof x === 'object' && x ? Number((x as { n?: unknown }).n) : Number(x)));
      return this.choiceAnswer(c.data.choiceId, numbers, 'command').content;
    });
  }
}

// ---- the tool groups: watches, schedules, live (decision 11), topics (decision 6) --------------

type WatchToolName = (typeof TOOL_GROUPS.watch)[number];
type ScheduleToolName = (typeof TOOL_GROUPS.schedules)[number];
type LiveToolName = (typeof TOOL_GROUPS.live)[number];
type TopicToolName = (typeof TOOL_GROUPS.topics)[number];

/** The zod shape of each of `TOOL_GROUP_DEFS`, by the definition object: what an endpoint registers for a module's tool that is one. */
const GROUP_SHAPES = new Map<ModuleToolDef, z.ZodRawShape>();

/** A group tool of `TOOL_DEFS` as a module tool definition (`TOOL_GROUP_DEFS`): its `input` the JSON Schema of its zod shape. */
function groupDef(name: WatchToolName | ScheduleToolName | LiveToolName | TopicToolName, needsTurn: boolean): ModuleToolDef {
  const def = TOOL_DEFS[name];
  const { $schema: _s, ...input } = z.toJSONSchema(z.object(def.input), { target: 'draft-7', io: 'input' });
  const out: ModuleToolDef = Object.freeze({ name, description: def.description, input: input as unknown as ModuleToolDef['input'], ...('readOnly' in def && def.readOnly ? { readOnly: true } : {}), needsTurn });
  GROUP_SHAPES.set(out, def.input);
  return out;
}

/**
 * The tool groups of `TOOL_DEFS` beyond the kernel's own (`TOOL_GROUPS`) as module tool definitions
 * (core-slimming G6), for a module that offers a group: it declares these objects as its
 * `mcpTools` and runs them with `watchToolHandlers` / `scheduleToolHandlers` / `liveToolHandlers` /
 * `topicToolHandlers` (the daemon's `tools.watch`, `tools.schedules`, `tools.live`, `tools.topics`).
 * An endpoint lists and checks a module's tool that is one of these objects (the same object)
 * exactly as `TOOL_DEFS` has it, so what a model is offered does not depend on who offers the
 * group. `input` is the JSON Schema of the zod shape, for what reads a manifest. The watch and
 * schedule tools and `session_list` need no turn (`schedule_add` gets the running one, if any).
 */
export const TOOL_GROUP_DEFS: { readonly [G in ToolGroup]: readonly ModuleToolDef[] } = Object.freeze({
  watch: Object.freeze(TOOL_GROUPS.watch.map((n) => groupDef(n, false))),
  schedules: Object.freeze(TOOL_GROUPS.schedules.map((n) => groupDef(n, false))),
  live: Object.freeze(TOOL_GROUPS.live.map((n) => groupDef(n, true))),
  topics: Object.freeze(TOOL_GROUPS.topics.map((n) => groupDef(n, n !== 'session_list'))),
});

/**
 * What the watch tools need: the watches of a session as its agent (the daemon's
 * `KernelContext.watches`). `Policy.watch` is applied behind `add`.
 */
export interface SessionWatches {
  /** Create or replace a watch as the session's agent (`agentOrigin`), delivering into the session (`draft.target`). */
  add(sessionKey: string, draft: WatchDraft): Promise<{ ok: true; watch: Watch } | { ok: false; code: string; message: string }>;
  /** Remove a watch as the session's agent. */
  remove(sessionKey: string, id: string): Promise<{ ok: true; removed: boolean } | { ok: false; code: string; message: string }>;
  /** The watches delivering into the session. */
  list(sessionKey: string): Watch[];
}

/** A host's `WatchControl` as `SessionWatches`: the session's agent acts as `agentOrigin(sessionKey, agentOf(sessionKey))`. */
export function sessionWatches(w: WatchControl, agentOf?: (sessionKey: string) => string | undefined): SessionWatches {
  const by = (sessionKey: string) => agentOrigin(sessionKey, agentOf?.(sessionKey));
  return { add: (key, d) => w.add(by(key), d), remove: (key, id) => w.remove(by(key), id), list: (key) => w.list(key) };
}

/**
 * The watch tools (`watch_add`, `watch_remove`, `watch_list`) over `w`: a watch always delivers into
 * the calling session, and an agent removes only watches it created. Without `w` each says watches
 * are not available.
 */
export function watchToolHandlers(w: SessionWatches | undefined): Record<WatchToolName, ModuleToolHandler> {
  const tool = (name: WatchToolName): ModuleToolHandler => (c) => watchTool(w, c.sessionKey, name, c.args);
  return { watch_add: tool('watch_add'), watch_remove: tool('watch_remove'), watch_list: tool('watch_list') };
}

/**
 * What the schedule tools need: the schedules of a session as its agent (the daemon's
 * `KernelContext.schedules`). The owner's limits (`policy.scheduleLimit`, `scheduleMinMinutes`) and
 * whose a schedule is (SC-3) are applied behind `add` and `remove`; so is the route: a schedule that
 * names one is set only while a turn of the session runs that may send there (`Policy.outbound`).
 */
export interface SessionSchedules {
  /** Set or replace a schedule as the session's agent (`agentOrigin`); `turn` is the session's running turn, when one runs. */
  add(sessionKey: string, draft: ScheduleDraft, turn: TurnContext | undefined): Promise<{ ok: true; schedule: ScheduleView } | { ok: false; code: string; message: string }>;
  /** Remove a schedule as the session's agent (one it set). */
  remove(sessionKey: string, id: string): Promise<{ ok: true; removed: boolean } | { ok: false; code: string; message: string }>;
  /** The schedules of the session: turns into it, and the ones it set. */
  list(sessionKey: string): ScheduleView[];
}

/** The refusal of a schedule's route the session's turn may not send to (SC-3). */
export const scheduleRouteRefusal = (route: ReplyRoute) => `the host policy does not let you send to ${routeKey(route)}; use "current" or a preregistered route`;

/**
 * A host's `ScheduleControl` as `SessionSchedules`: the session's agent acts as
 * `agentOrigin(sessionKey, agentOf(sessionKey))`, and a schedule's route is checked with `policy`
 * for the running turn first.
 */
export function sessionSchedules(c: ScheduleControl, agentOf: ((sessionKey: string) => string | undefined) | undefined, policy: Required<Pick<Policy, 'outbound'>>): SessionSchedules {
  const by = (sessionKey: string) => agentOrigin(sessionKey, agentOf?.(sessionKey));
  return {
    add: async (key, d, turn) => {
      if (d.route) {
        if (!turn) return { ok: false, code: 'forbidden', message: 'a route can only be given while you are answering a message ("current" is that conversation)' };
        if ((await policy.outbound({ from: turn, to: d.route })) !== 'allow') return { ok: false, code: 'forbidden', message: scheduleRouteRefusal(d.route) };
      }
      return c.put(by(key), d);
    },
    remove: (key, id) => c.remove(by(key), id),
    list: (key) => c.list(key),
  };
}

/**
 * The schedule tools (`schedule_add`, `schedule_remove`, `schedule_list`) over `s`: a schedule's turn
 * always goes to the calling session, a route is "current" (the running turn's) or a route key, and
 * an agent removes only schedules it set. Without `s` each says schedules are not available.
 */
export function scheduleToolHandlers(s: SessionSchedules | undefined): Record<ScheduleToolName, ModuleToolHandler> {
  const tool = (name: ScheduleToolName): ModuleToolHandler => (c) => scheduleTool(s, c.sessionKey, name, c.args, c.turn);
  return { schedule_add: tool('schedule_add'), schedule_remove: tool('schedule_remove'), schedule_list: tool('schedule_list') };
}

/** The live tools (`live_join`, `live_say`, `live_leave`) over `live`; without it each says live sessions are not available. */
export function liveToolHandlers(live: LiveControl | undefined): Record<LiveToolName, ModuleToolHandler> {
  const tool = (name: LiveToolName): ModuleToolHandler => (c) => liveTool(live, c.sessionKey, c.turn!, name, c.args, c.operationId!);
  return { live_join: tool('live_join'), live_say: tool('live_say'), live_leave: tool('live_leave') };
}

/**
 * The topic tools (`session_rotate`, `session_list`, `session_switch`) over `control`: TP-1's rules
 * first (`handoverRefusal`; once per turn, a retry answers the same), then `control` with the call's
 * operationId (the daemon's kernel applies them again). Without `control` each says topics are not available.
 */
export function topicToolHandlers(control: TopicControl | undefined): Record<TopicToolName, ModuleToolHandler> {
  /** Session + turn → what its session_rotate / session_switch did (a retried call answers the same; a second handover is refused). */
  const handovers = new Map<string, { key: string; result: Record<string, unknown> }>();
  return {
    session_rotate: (c) => handover(control, handovers, c.sessionKey, c.turn!, 'session_rotate', c.args, c.operationId!),
    session_list: (c) => sessionList(control, c.sessionKey),
    session_switch: (c) => handover(control, handovers, c.sessionKey, c.turn!, 'session_switch', c.args, c.operationId!),
  };
}

async function liveTool(live: LiveControl | undefined, sessionKey: string, turn: TurnContext, name: LiveToolName, args: Record<string, unknown>, operationId: string) {
  if (!live) throw new ToolError('live sessions are not available in this deployment');
  try {
    switch (name) {
      case 'live_join': {
        const target = str(args.target, 'target')!;
        const r = await live.join(sessionKey, turn, {
          target,
          ...(str(args.channel, 'channel', true) ? { channel: args.channel as string } : {}),
          ...(str(args.instructions, 'instructions', true) ? { instructions: args.instructions as string } : {}),
          ...(str(args.voice, 'voice', true) ? { voice: args.voice as string } : {}),
        });
        return {
          ok: true,
          ...r,
          note: 'You are now in the live session by voice. What people say there reaches you as delegated turns (inputs marked live=true); your answer in such a turn is spoken by the voice side, so keep it short and plain. The voice side may paraphrase wrongly: send results that matter as text (send_message to "current") as well. Call live_leave when asked to leave.',
        };
      }
      case 'live_say':
        await live.say(sessionKey, str(args.text, 'text')!, { operationId, turnId: turn.turnId });
        return { ok: true };
      case 'live_leave':
        return { ok: true, left: await live.leave(sessionKey) };
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`${name} failed: ${(e as Error).message}`);
  }
}

async function watchTool(w: SessionWatches | undefined, sessionKey: string, name: WatchToolName, args: Record<string, unknown>) {
  if (!w) throw new ToolError('watches are not available on this host');
  const me = agentIdentity(sessionKey);
  const view = (x: Watch) => ({ ...x, mine: x.createdBy === me });
  if (name === 'watch_list') return { ok: true, session: sessionKey, watches: w.list(sessionKey).map(view) };
  if (name === 'watch_remove') {
    const id = str(args.id, 'id')!;
    const existing = w.list(sessionKey).find((x) => x.id === id);
    if (existing && existing.createdBy !== me) throw new ToolError(`watch ${id} was created by ${existing.createdBy}; you may only remove watches you created`);
    const r = await w.remove(sessionKey, id);
    if (!r.ok) throw new ToolError(r.code === 'forbidden' ? `you may only remove watches you created (${r.message})` : r.message);
    return { ok: true, removed: r.removed, id };
  }
  // watch_add: the target is always the caller's own session.
  if (args.target !== undefined || args.sessionKey !== undefined) throw new ToolError('watch_add has no target: a watch always delivers to your own session; remove the target argument');
  const src = args.source as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') throw new ToolError('source is required: { channel, account?, conversation?, conversationKind?, senders? }');
  const channel = str(src.channel, 'source.channel')!;
  const kind = str(src.conversationKind, 'source.conversationKind', true);
  if (kind && !WATCH_KINDS.includes(kind)) throw new ToolError(`source.conversationKind must be one of ${WATCH_KINDS.join(', ')}`);
  const mode = str(args.mode, 'mode')!;
  if (!WATCH_MODES.includes(mode)) throw new ToolError(`mode must be one of ${WATCH_MODES.join(', ')}`);
  const senders = Array.isArray(src.senders) ? (src.senders as unknown[]).map(String) : undefined;
  const keywords = Array.isArray(args.keywords) ? (args.keywords as unknown[]).map(String) : undefined;
  const mentions = Array.isArray(args.mentions) ? (args.mentions as unknown[]).map(String) : undefined;
  const every = typeof args.digest_every_minutes === 'number' ? args.digest_every_minutes : undefined;
  const maxItems = typeof args.digest_max_items === 'number' ? args.digest_max_items : undefined;
  if (mode === 'digest' && every === undefined) throw new ToolError('digest mode needs digest_every_minutes');
  const expiresIn = typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
  const id = str(args.id, 'id', true);
  const note = str(args.note, 'note', true);
  const account = str(src.account, 'source.account', true);
  const conversation = str(src.conversation, 'source.conversation', true);
  const draft: WatchDraft = {
    ...(id ? { id } : {}),
    source: { channel, ...(account ? { account } : {}), ...(conversation ? { conversation } : {}), ...(kind ? { conversationKind: kind as never } : {}), ...(senders?.length ? { senders } : {}) },
    ...(keywords?.length || mentions?.length ? { filter: { ...(keywords?.length ? { keywords } : {}), ...(mentions?.length ? { mentions } : {}) } } : {}),
    target: { sessionKey: sessionKey },
    mode: mode as WatchDraft['mode'],
    ...(mode === 'digest' ? { digest: { everyMs: Math.round(every! * 60_000), ...(maxItems ? { maxItems } : {}) } } : {}),
    ...(expiresIn ? { expiresAt: Date.now() + Math.round(expiresIn * 60_000) } : {}),
    ...(note ? { note } : {}),
  };
  const r = await w.add(sessionKey, draft);
  if (!r.ok) {
    const what = [channel, account, conversation ?? kind].filter(Boolean).join(':');
    if (r.code === 'forbidden' && /not allowed to watch/.test(r.message))
      throw new ToolError(`the source ${what} is not on the owner's watch allowlist, so you cannot watch it; ask the owner to add it (policy.watchAllowlist) or to create the watch themselves`);
    throw new ToolError(r.message);
  }
  return { ok: true, watch: view(r.watch) };
}

async function scheduleTool(s: SessionSchedules | undefined, sessionKey: string, name: ScheduleToolName, args: Record<string, unknown>, turn: TurnContext | undefined) {
  if (!s) throw new ToolError('schedules are not available on this host');
  const me = agentIdentity(sessionKey);
  const view = (x: ScheduleView) => ({ ...x, nextAt: x.nextAt === null ? null : new Date(x.nextAt).toISOString(), mine: x.createdBy === me });
  if (name === 'schedule_list') return { ok: true, session: sessionKey, schedules: s.list(sessionKey).map(view) };
  if (name === 'schedule_remove') {
    const id = str(args.id, 'id')!;
    const r = await s.remove(sessionKey, id);
    if (!r.ok) throw new ToolError(r.message);
    return { ok: true, removed: r.removed, id };
  }
  // schedule_add: a turn goes to the caller's own session; a route is "current" or one this turn may use.
  if (args.target !== undefined || args.sessionKey !== undefined) throw new ToolError('schedule_add has no target: a schedule always belongs to your own session; remove the target argument');
  const w = (args.when ?? {}) as Record<string, unknown>;
  const when =
    w.cron !== undefined
      ? { cron: str(w.cron, 'when.cron')!, ...(w.tz !== undefined ? { tz: str(w.tz, 'when.tz')! } : {}) }
      : w.every_minutes !== undefined
        ? { everyMinutes: Number(w.every_minutes) }
        : w.at !== undefined
          ? { at: typeof w.at === 'number' ? w.at : str(w.at, 'when.at')! }
          : undefined;
  if (!when) throw new ToolError('when is { at } (once), { cron, tz? } or { every_minutes }');
  const action = str(args.action, 'action', true) ?? 'turn';
  if (action !== 'turn' && action !== 'message') throw new ToolError('action is turn or message');
  const spec = str(args.route, 'route', true);
  let route: ReplyRoute | undefined;
  if (spec !== undefined || action === 'message') {
    if (!turn) throw new ToolError('a route can only be given while you are answering a message ("current" is that conversation)');
    // Whether this turn may send there is checked behind `add` (SC-3), for every caller.
    route = parseRoute(turn, spec);
  }
  const until = str(args.until, 'until', true);
  const untilMs = until !== undefined ? Date.parse(until) : undefined;
  if (untilMs !== undefined && !Number.isFinite(untilMs)) throw new ToolError('until is an ISO 8601 time');
  const draft: ScheduleDraft = {
    ...(args.id !== undefined ? { id: str(args.id, 'id')! } : {}),
    when,
    action,
    ...(action === 'turn' ? { target: { sessionKey } } : {}),
    ...(route ? { route } : {}),
    text: str(args.text, 'text')!,
    ...(args.missed !== undefined ? { missed: str(args.missed, 'missed') as 'once' | 'skip' } : {}),
    ...(untilMs !== undefined ? { until: untilMs } : {}),
    ...(args.note !== undefined ? { note: str(args.note, 'note')! } : {}),
  };
  const r = await s.add(sessionKey, draft, turn);
  if (!r.ok) throw new ToolError(r.message);
  return { ok: true, schedule: view(r.schedule) };
}

function topicsOf(control: TopicControl | undefined, sessionKey: string): { control: TopicControl; topics: Topic[] } {
  if (!control) throw new ToolError('topics are not available on this host');
  const topics = control.list(sessionKey);
  if (!topics) throw new ToolError('this conversation does not keep topics (its binding does not use session "topic", or it is threaded): session_rotate / session_switch are not available here; just answer');
  return { control, topics };
}

function sessionList(control: TopicControl | undefined, sessionKey: string) {
  const { topics } = topicsOf(control, sessionKey);
  return {
    ok: true,
    topics: topics.map((t) => ({
      topicId: t.id,
      title: t.title ?? null,
      current: t.state === 'current',
      ...(t.sessionKey === sessionKey ? { you: true } : {}),
      summary: t.summary ?? null,
      lastActiveAt: new Date(t.lastActiveAt).toISOString(),
    })),
    note: 'Newest activity first; `you` marks the topic this session is. session_switch({topicId}) resumes a parked topic with its full earlier context; session_rotate({title, summary}) starts a new one.',
  };
}

async function handover(
  c: TopicControl | undefined,
  handovers: Map<string, { key: string; result: Record<string, unknown> }>,
  sessionKey: string,
  turn: TurnContext,
  tool: 'session_rotate' | 'session_switch',
  args: Record<string, unknown>,
  operationId: string,
) {
  const hk = `${sessionKey}\u0000${turn.turnId}`;
  const prior = handovers.get(hk);
  if (prior?.key === operationId) return prior.result;
  if (prior) throw new ToolError(TOPIC_HANDED_ALREADY);
  const { control, topics } = topicsOf(c, sessionKey);
  // TP-1's refusals before the arguments are read (the kernel's handover applies them again, for every caller).
  const refusal = handoverRefusal(topics.find((t) => t.sessionKey === sessionKey), turn.inputs);
  if (refusal) throw new ToolError(refusal);
  let r: TopicHandover;
  if (tool === 'session_rotate') {
    const title = str(args.title, 'title')!.trim();
    const summary = str(args.summary, 'summary')!.trim();
    if (!title) throw new ToolError('title is required');
    if (!summary) throw new ToolError('summary is required: what the new topic should know from this one (or "none")');
    r = await control.rotate(sessionKey, turn, { title, summary, operationId });
  } else {
    const topicId = str(args.topicId ?? args.topic_id, 'topicId')!;
    const target = topics.find((t) => t.id === topicId);
    if (!target) throw new ToolError(`no topic ${topicId} in this conversation; session_list shows the topic ids`);
    if (target.sessionKey === sessionKey) throw new ToolError(TOPIC_ALREADY_HERE);
    r = await control.switch(sessionKey, turn, { topicId, operationId });
  }
  const label = `"${r.topic.title ?? r.topic.id}"`;
  const short = r.topic.title ?? (tool === 'session_rotate' ? 'new topic' : 'earlier topic');
  const result = {
    ok: true,
    topic: { topicId: r.topic.id, title: r.topic.title ?? null },
    ...(r.previous ? { previous: { topicId: r.previous.id, title: r.previous.title ?? null } } : {}),
    handed: r.handed.length,
    note:
      (tool === 'session_rotate'
        ? `The conversation moved to the new topic ${label}. The user's message has been handed to it, with your summary as context, and that topic's session answers it there.`
        : `The conversation is back in topic ${label}; its session resumes with its full earlier context and answers the user's message there.`) +
      ` Do NOT answer the message in this turn: end the turn now, writing nothing more (at most one short line such as "→ ${short}").`,
  };
  handovers.set(hk, { key: operationId, result });
  for (const k of handovers.keys()) {
    if (handovers.size <= 1000) break;
    handovers.delete(k);
  }
  return result;
}

function inside(p: string, dir: string): boolean {
  const r = relative(dir, p);
  // `..notes` is a name inside `dir`; only `..` itself or a `../` prefix leaves it.
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

function json(v: unknown): string {
  return JSON.stringify(v);
}
