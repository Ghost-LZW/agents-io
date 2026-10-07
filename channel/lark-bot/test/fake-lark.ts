import type { ChannelContext, InboundEnvelope } from '@agents-io/protocol';
import { Readable } from 'node:stream';
import type { LarkApiResponse, LarkClientLike, LarkMessageItem, LarkDeps, LarkDispatcherLike, LarkEventHandler, LarkWsLike } from '../src/types.js';

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

export interface FakeCard {
  id: string;
  /** Latest full card JSON (create / card.update). */
  json: any;
  seq: number;
  ops: { op: string; sequence: number; uuid?: string; elementId?: string; body?: any }[];
}

export interface CotRecord {
  cotId: string;
  messageId: string;
  create: { params: any; data: any };
  events: { event_type: string; content: any }[];
  completed?: string;
}

/** In-memory Lark: REST client with uuid dedup, a dispatcher and a WS that never touches the network. */
export class FakeLark {
  readonly messages: PlatformMessage[] = [];
  readonly handlers = new Map<string, LarkEventHandler>();
  readonly byUuid = new Map<string, PlatformMessage>();
  readonly cards = new Map<string, FakeCard>();
  readonly cots: CotRecord[] = [];
  /** Codes to answer the next calls of an op with (`card.create`, `cardElement.content`, `cot.create`, `cot.put`, `message.patch`…). */
  readonly fail = new Map<string, number[]>();
  /** Every CardKit / CoT call in order, for asserting sequences. */
  readonly log: string[] = [];
  botOpenId = 'ou_bot';
  /** Messages other users sent, as `message.get` returns them (for quote lookups). */
  readonly foreign = new Map<string, LarkMessageItem>();
  /** `${messageId}/${fileKey}` → resource bytes and headers (`messageResource.get`). */
  readonly resources = new Map<string, { bytes: Buffer; headers?: Record<string, string>; hang?: boolean }>();
  /** `im.v1.file.create` / `image.create` calls, in order. */
  readonly uploads: { kind: 'file' | 'image'; fileType?: string; name?: string; bytes: number; key: string }[] = [];
  /** Contact users by id (`contact.v3.user.get`). */
  readonly users = new Map<string, { name: string }>();
  /** Calls of the inbound lookups, e.g. `resource:om_1/img_1:image`, `get:om_p`, `user:on_alice:union_id`. */
  readonly lookups: string[] = [];
  wsStarts = 0;
  wsFailuresLeft = 0;
  private seq = 0;
  private cardSeq = 0;

  private failing(op: string): { code: number; msg: string } | undefined {
    const codes = this.fail.get(op);
    const code = codes?.shift();
    // 0 in the list lets that call through.
    return code === undefined || code === 0 ? undefined : { code, msg: `injected ${op} failure` };
  }

  private mutate(op: string, cardId: string, sequence: number, uuid: string | undefined, apply: (c: FakeCard) => void, elementId?: string, body?: any) {
    this.log.push(`${op}${elementId ? `:${elementId}` : ''}`);
    const f = this.failing(op);
    if (f) return f;
    const c = this.cards.get(cardId);
    if (!c) return { code: 300100, msg: 'card not found' };
    if (sequence <= c.seq) return { code: 300317, msg: `sequence ${sequence} <= ${c.seq}` };
    c.seq = sequence;
    c.ops.push({ op, sequence, ...(uuid ? { uuid } : {}), ...(elementId ? { elementId } : {}), ...(body !== undefined ? { body } : {}) });
    apply(c);
    return { code: 0, data: {} };
  }

  /** Card JSON element by id, searched through panels. */
  static element(card: any, id: string): any {
    const walk = (els: any[]): any => {
      for (const e of els ?? []) {
        if (e.element_id === id) return e;
        const inner = walk(e.elements ?? []);
        if (inner) return inner;
      }
      return undefined;
    };
    return walk(card?.body?.elements ?? []);
  }

  readonly cardkitApi: NonNullable<LarkClientLike['cardkit']>['v1'] = {
    card: {
      create: async ({ data }) => {
        this.log.push('card.create');
        const f = this.failing('card.create');
        if (f) return f;
        const id = `card_${++this.cardSeq}`;
        this.cards.set(id, { id, json: JSON.parse(data.data), seq: 1, ops: [] });
        return { code: 0, data: { card_id: id } };
      },
      settings: async ({ data, path }) =>
        this.mutate('card.settings', path.card_id, data.sequence, data.uuid, (c) => {
          const s = JSON.parse(data.settings);
          c.json.config = { ...c.json.config, ...s.config };
        }, undefined, JSON.parse(data.settings)),
      update: async ({ data, path }) =>
        this.mutate('card.update', path.card_id, data.sequence, data.uuid, (c) => {
          c.json = JSON.parse(data.card.data);
        }),
      idConvert: async ({ data }) => {
        const m = this.find(data.message_id);
        const id = m && m.msg_type === 'interactive' ? JSON.parse(m.content)?.data?.card_id : undefined;
        return id ? { code: 0, data: { card_id: id } } : { code: 300100, msg: 'not a card entity' };
      },
    },
    cardElement: {
      content: async ({ data, path }) =>
        this.mutate('cardElement.content', path.card_id, data.sequence, data.uuid, (c) => {
          const e = FakeLark.element(c.json, path.element_id);
          if (e) e.content = data.content;
        }, path.element_id, data.content),
      update: async ({ data, path }) =>
        this.mutate('cardElement.update', path.card_id, data.sequence, data.uuid, (c) => {
          const e = FakeLark.element(c.json, path.element_id);
          if (e) Object.assign(e, JSON.parse(data.element));
        }, path.element_id, JSON.parse(data.element)),
      create: async ({ data, path }) =>
        this.mutate('cardElement.create', path.card_id, data.sequence, data.uuid, (c) => {
          const els: any[] = c.json.body.elements;
          const add = JSON.parse(data.elements);
          const at = els.findIndex((e) => e.element_id === data.target_element_id);
          if (data.type === 'append' || at < 0) els.push(...add);
          else els.splice(data.type === 'insert_after' ? at + 1 : at, 0, ...add);
        }, data.target_element_id, JSON.parse(data.elements)),
      delete: async ({ data, path }) =>
        this.mutate('cardElement.delete', path.card_id, data.sequence, data.uuid, (c) => {
          c.json.body.elements = c.json.body.elements.filter((e: any) => e.element_id !== path.element_id);
        }, path.element_id),
    },
  };

  /** Raw requests: bot info and the `message_cot` thinking bubble. */
  private async request(opts: { method: string; url: string; data?: any; params?: any }): Promise<unknown> {
    if (opts.url === '/open-apis/bot/v3/info') return { code: 0, bot: { open_id: this.botOpenId } };
    if (opts.url === '/open-apis/im/v1/message_cot' && opts.method === 'POST') {
      this.log.push('cot.create');
      const f = this.failing('cot.create');
      if (f) return f;
      const n = this.cots.length + 1;
      const rec: CotRecord = { cotId: `cot_${n}`, messageId: `om_cot${n}`, create: { params: opts.params, data: opts.data }, events: [] };
      this.cots.push(rec);
      return { code: 0, data: { cot_id: rec.cotId, message_id: rec.messageId } };
    }
    if (opts.url === '/open-apis/im/v1/message_cot' && opts.method === 'PUT') {
      this.log.push('cot.put');
      const f = this.failing('cot.put');
      if (f) return f;
      const rec = this.cots.find((c) => c.cotId === opts.data.cot_id && c.messageId === opts.data.message_id);
      if (!rec) return { code: 230002, msg: 'cot not found' };
      if (rec.completed) return { code: 230099, msg: 'COT already in terminal state' };
      if (opts.data.events.length > 50) return { code: 99992402, msg: 'too many events' };
      for (const e of opts.data.events) {
        rec.events.push({ event_type: e.event_type, content: JSON.parse(e.content) });
        if (e.event_type === 'RUN_FINISHED') rec.completed = 'finished';
      }
      return { code: 0, data: {} };
    }
    const done = /^\/open-apis\/im\/v1\/message_cot\/complete\/(.+)$/.exec(opts.url);
    if (done && opts.method === 'POST') {
      this.log.push('cot.complete');
      const rec = this.cots.find((c) => c.cotId === decodeURIComponent(done[1]!));
      if (rec) rec.completed = opts.params.reason;
      return { code: 0, data: {} };
    }
    throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: {} } });
  }

  readonly client: LarkClientLike = {
    cardkit: { v1: this.cardkitApi },
    im: {
      v1: {
        message: {
          create: async ({ data }) => this.record({ kind: 'create', chatId: data.receive_id }, data),
          reply: async ({ data, path }) =>
            this.record({ kind: 'reply', to: path.message_id, inThread: !!data.reply_in_thread }, data),
          patch: async ({ data, path }) => {
            const f = this.failing('message.patch');
            if (f) return f;
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
          get: async ({ path }): Promise<LarkApiResponse<{ items?: LarkMessageItem[] }>> => {
            this.lookups.push(`get:${path.message_id}`);
            const other = this.foreign.get(path.message_id);
            if (other) return { code: 0, data: { items: [other] } };
            const m = this.find(path.message_id);
            if (!m) return { code: 230011, msg: 'recalled' };
            return {
              code: 0,
              data: {
                items: [
                  {
                    message_id: m.id,
                    deleted: !!m.deleted,
                    msg_type: m.msg_type,
                    body: { content: m.content },
                    sender: { id: 'cli_x', id_type: 'app_id', sender_type: 'app' },
                  },
                ],
              },
            };
          },
        },
        file: {
          create: async ({ data }) => {
            const key = `file_v3_${this.uploads.length + 1}`;
            this.uploads.push({ kind: 'file', fileType: data.file_type, name: data.file_name, bytes: data.file.byteLength, key });
            // SDK 1.74 resolves upload calls to the unwrapped data.
            return { file_key: key };
          },
        },
        image: {
          create: async ({ data }) => {
            const key = `img_v3_${this.uploads.length + 1}`;
            this.uploads.push({ kind: 'image', bytes: data.image.byteLength, key });
            return { image_key: key };
          },
        },
        messageResource: {
          get: async ({ params, path }) => {
            this.lookups.push(`resource:${path.message_id}/${path.file_key}:${params.type}`);
            const r = this.resources.get(`${path.message_id}/${path.file_key}`);
            if (!r) throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });
            const stream = r.hang ? new Readable({ read() {} }) : Readable.from([r.bytes.subarray(0, 3), r.bytes.subarray(3)]);
            return { getReadableStream: () => stream, headers: { 'content-length': String(r.bytes.length), ...r.headers } };
          },
        },
      },
    },
    contact: {
      v3: {
        user: {
          get: async ({ path, params }) => {
            this.lookups.push(`user:${path.user_id}:${params?.user_id_type}`);
            const u = this.users.get(path.user_id);
            return u ? { code: 0, data: { user: { name: u.name } } } : { code: 41050, msg: 'no user authority' };
          },
        },
      },
    },
    request: (opts) => this.request(opts as never),
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

export function startAdapter(
  adapter: { start(ctx: ChannelContext): Promise<void> },
  opts: { emit?: ChannelContext['emit']; account?: string; blobs?: ChannelContext['blobs'] } = {},
) {
  const ctl = new AbortController();
  const envs: InboundEnvelope[] = [];
  const logs: string[] = [];
  const ctx: ChannelContext = {
    account: opts.account ?? 'acct',
    config: {},
    signal: ctl.signal,
    ...(opts.blobs ? { blobs: opts.blobs } : {}),
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
