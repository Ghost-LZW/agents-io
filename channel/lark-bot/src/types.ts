/** Narrow views of the Lark SDK, so tests (and hosts) can inject a client without network. */

export interface LarkMessageApi {
  create(payload: {
    data: { receive_id: string; msg_type: string; content: string; uuid?: string };
    params: { receive_id_type: 'chat_id' | 'open_id' | 'union_id' | 'user_id' | 'email' };
  }): Promise<LarkApiResponse<{ message_id?: string }>>;
  reply(payload: {
    data: { content: string; msg_type: string; reply_in_thread?: boolean; uuid?: string };
    path: { message_id: string };
  }): Promise<LarkApiResponse<{ message_id?: string }>>;
  /** Patch an interactive card (`PATCH /im/v1/messages/:id`). Cards only. */
  patch(payload: { data: { content: string }; path: { message_id: string } }): Promise<LarkApiResponse>;
  /** Replace a text/post message (`PUT /im/v1/messages/:id`). */
  update(payload: {
    data: { msg_type: string; content: string };
    path: { message_id: string };
  }): Promise<LarkApiResponse>;
  get(payload: { path: { message_id: string } }): Promise<LarkApiResponse<{ items?: { deleted?: boolean; message_id?: string }[] }>>;
}

export interface LarkApiResponse<T = unknown> {
  code?: number;
  msg?: string;
  data?: T;
}

export interface LarkClientLike {
  im: { v1: { message: LarkMessageApi } };
  /** Raw OpenAPI call (used for `GET /open-apis/bot/v3/info`). Resolves to the response body. */
  request(opts: { method: string; url: string; data?: unknown; params?: unknown }): Promise<unknown>;
}

export interface LarkWsLike {
  /** Resolves once the first connection attempt is made; the SDK reconnects on its own afterwards. */
  start(params: { eventDispatcher: LarkDispatcherLike }): Promise<void>;
  close(params?: { force?: boolean }): void;
  /** Present on the SDK's WSClient; used by the setup probe to confirm a live connection. */
}

export type LarkEventHandler = (data: any) => unknown;

export interface LarkDispatcherLike {
  register(handles: Record<string, LarkEventHandler>): unknown;
}

export interface LarkConnectionParams {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  encryptKey?: string;
  verificationToken?: string;
}

/** Everything that touches the network goes through here; tests replace it. */
export interface LarkDeps {
  createClient(p: LarkConnectionParams): LarkClientLike;
  createWs(p: LarkConnectionParams): LarkWsLike;
  createDispatcher(p: LarkConnectionParams): LarkDispatcherLike;
}

/** Flattened `im.message.receive_v1` payload as delivered by `EventDispatcher` (header + event merged). */
export interface RawMessageEvent {
  event_id?: string;
  create_time?: string;
  sender?: { sender_id?: { union_id?: string; user_id?: string; open_id?: string }; sender_type?: string; tenant_key?: string };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: { key: string; id?: { union_id?: string; user_id?: string; open_id?: string }; name?: string }[];
  };
}

/** Flattened `card.action.trigger` payload. */
export interface RawCardActionEvent {
  event_id?: string;
  token?: string;
  operator?: { open_id?: string; user_id?: string; union_id?: string; name?: string };
  action?: { value?: unknown; tag?: string; name?: string; option?: string; form_value?: unknown };
  context?: { open_message_id?: string; open_chat_id?: string };
}
