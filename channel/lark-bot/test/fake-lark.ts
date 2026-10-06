import type { ChannelContext, InboundEnvelope } from '@agents-io/protocol';
import type { LarkApiResponse, LarkClientLike, LarkDeps, LarkDispatcherLike, LarkEventHandler, LarkWsLike } from '../src/types.js';

export interface PlatformMessage {
  id: string;
  uuid?: string;
  msg_type: string;
  content: string;
  receive: { kind: 'create'; chatId: string } | { kind: 'reply'; to: string; inThread: boolean };
  patches: string[];
  updates: { msg_type: string; content: string }[];
  deleted?: boolean;
}

/** In-memory Lark: REST client with uuid dedup, a dispatcher and a WS that never touches the network. */
export class FakeLark {
  readonly messages: PlatformMessage[] = [];
  readonly handlers = new Map<string, LarkEventHandler>();
  readonly byUuid = new Map<string, PlatformMessage>();
  botOpenId = 'ou_bot';
  wsStarts = 0;
  wsFailuresLeft = 0;
  private seq = 0;

  readonly client: LarkClientLike = {
    im: {
      v1: {
        message: {
          create: async ({ data }) => this.record({ kind: 'create', chatId: data.receive_id }, data),
          reply: async ({ data, path }) =>
            this.record({ kind: 'reply', to: path.message_id, inThread: !!data.reply_in_thread }, data),
          patch: async ({ data, path }) => {
            const m = this.find(path.message_id);
            if (!m) return { code: 230002, msg: 'not found' };
            if (m.msg_type !== 'interactive') return { code: 230001, msg: 'not a card' };
            m.patches.push(data.content);
            return { code: 0, data: {} };
          },
          update: async ({ data, path }) => {
            const m = this.find(path.message_id);
            if (!m) return { code: 230002, msg: 'not found' };
            m.updates.push(data);
            return { code: 0, data: {} };
          },
          get: async ({ path }): Promise<LarkApiResponse<{ items?: { deleted?: boolean; message_id?: string }[] }>> => {
            const m = this.find(path.message_id);
            if (!m) return { code: 230011, msg: 'recalled' };
            return { code: 0, data: { items: [{ message_id: m.id, deleted: !!m.deleted }] } };
          },
        },
      },
    },
    request: async () => ({ code: 0, bot: { open_id: this.botOpenId } }),
  };

  readonly dispatcher: LarkDispatcherLike = {
    register: (handles) => {
      for (const [k, v] of Object.entries(handles)) this.handlers.set(k, v);
      return this;
    },
  };

  readonly ws: LarkWsLike = {
    start: async () => {
      this.wsStarts++;
      if (this.wsFailuresLeft-- > 0) throw new Error('connect refused');
    },
    close: () => {},
  };

  readonly deps: LarkDeps = {
    createClient: () => this.client,
    createWs: () => this.ws,
    createDispatcher: () => this.dispatcher,
  };

  private find(id: string) {
    return this.messages.find((m) => m.id === id);
  }

  private record(
    receive: PlatformMessage['receive'],
    data: { msg_type: string; content: string; uuid?: string },
  ): LarkApiResponse<{ message_id?: string }> {
    if (data.uuid) {
      const prior = this.byUuid.get(data.uuid);
      if (prior) return { code: 0, data: { message_id: prior.id } };
    }
    const m: PlatformMessage = {
      id: `om_${++this.seq}`,
      msg_type: data.msg_type,
      content: data.content,
      receive,
      patches: [],
      updates: [],
      ...(data.uuid ? { uuid: data.uuid } : {}),
    };
    this.messages.push(m);
    if (data.uuid) this.byUuid.set(data.uuid, m);
    return { code: 0, data: { message_id: m.id } };
  }

  /** Deliver a flattened event the way `EventDispatcher` would. */
  fire(event: string, data: unknown): Promise<unknown> {
    const h = this.handlers.get(event);
    if (!h) throw new Error(`no handler for ${event}`);
    return Promise.resolve(h(data));
  }
}

export function startAdapter(adapter: { start(ctx: ChannelContext): Promise<void> }, opts: { emit?: ChannelContext['emit']; account?: string } = {}) {
  const ctl = new AbortController();
  const envs: InboundEnvelope[] = [];
  const logs: string[] = [];
  const ctx: ChannelContext = {
    account: opts.account ?? 'acct',
    config: {},
    signal: ctl.signal,
    emit: opts.emit ?? (async (env) => (envs.push(env), { accepted: true, inputId: `i${envs.length}` })),
    log: (l, m) => logs.push(`${l}: ${m}`),
  };
  const done = adapter.start(ctx);
  return { ctl, envs, logs, done, ctx };
}

export const tick = () => new Promise((r) => setTimeout(r, 5));

export function messageEvent(over: {
  id?: string;
  type?: string;
  content?: unknown;
  chatType?: 'p2p' | 'group';
  root?: string;
  parent?: string;
  thread?: string;
  mentions?: { key: string; id: { open_id?: string }; name: string }[];
  sender?: { union_id?: string; open_id?: string };
  senderType?: string;
  eventId?: string;
} = {}) {
  return {
    event_id: over.eventId ?? `ev_${over.id ?? 'om_in1'}`,
    sender: {
      sender_id: over.sender ?? { union_id: 'on_alice', open_id: 'ou_alice' },
      sender_type: over.senderType ?? 'user',
    },
    message: {
      message_id: over.id ?? 'om_in1',
      create_time: '1700000000000',
      chat_id: 'oc_chat',
      chat_type: over.chatType ?? 'p2p',
      message_type: over.type ?? 'text',
      content: JSON.stringify(over.content ?? { text: 'hello' }),
      ...(over.root ? { root_id: over.root } : {}),
      ...(over.parent ? { parent_id: over.parent } : {}),
      ...(over.thread ? { thread_id: over.thread } : {}),
      ...(over.mentions ? { mentions: over.mentions } : {}),
    },
  };
}
