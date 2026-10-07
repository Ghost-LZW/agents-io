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
  get(payload: {
    path: { message_id: string };
    /** `card_msg_content_type: 'user_card_content'` returns a card's real JSON (the default is an "upgrade your client" stub for CardKit cards). */
    params?: { user_id_type?: 'user_id' | 'union_id' | 'open_id'; card_msg_content_type?: string };
  }): Promise<LarkApiResponse<{ items?: LarkMessageItem[] }>>;
}

/** One item of `im.v1.message.get` (fields the adapter reads). */
export interface LarkMessageItem {
  message_id?: string;
  msg_type?: string;
  deleted?: boolean;
  chat_id?: string;
  sender?: { id: string; id_type: string; sender_type: string };
  body?: { content: string };
  mentions?: { key: string; id: string; id_type: string; name: string }[];
}

/**
 * `im.v1.messageResource.get` as typed by `@larksuiteoapi/node-sdk` 1.74: `type` is
 * `image` (images) or `file` (files, audio, video). The response is a byte stream.
 */
export interface LarkMessageResourceApi {
  get(payload: {
    params: { type: string };
    path: { message_id: string; file_key: string };
  }): Promise<{ getReadableStream: () => NodeJS.ReadableStream & { destroy?(): void }; headers: any }>;
}

/** `contact.v3.user.get` (only what the adapter reads; needs contact:user.base:readonly). */
export interface LarkContactUserApi {
  get(payload: {
    path: { user_id: string };
    params?: { user_id_type?: 'user_id' | 'union_id' | 'open_id' };
  }): Promise<LarkApiResponse<{ user?: { name?: string; en_name?: string; nickname?: string } }>>;
}

export interface LarkApiResponse<T = unknown> {
  code?: number;
  msg?: string;
  data?: T;
}

/** `cardkit.v1` as typed by `@larksuiteoapi/node-sdk` 1.74 (only the methods the adapter calls). */
export interface LarkCardKitApi {
  card: {
    create(payload: { data: { type: string; data: string } }): Promise<LarkApiResponse<{ card_id?: string }>>;
    settings(payload: { data: { settings: string; uuid?: string; sequence: number }; path: { card_id: string } }): Promise<LarkApiResponse>;
    update(payload: {
      data: { card: { type: 'card_json'; data: string }; uuid?: string; sequence: number };
      path: { card_id: string };
    }): Promise<LarkApiResponse>;
    idConvert(payload: { data: { message_id: string } }): Promise<LarkApiResponse<{ card_id?: string }>>;
  };
  cardElement: {
    /** Streams a markdown/plain_text element's full text (typewriter while streaming_mode is on). */
    content(payload: {
      data: { uuid?: string; content: string; sequence: number };
      path: { card_id: string; element_id: string };
    }): Promise<LarkApiResponse>;
    /** Replaces one element. `element` is the element JSON, serialised. */
    update(payload: {
      data: { uuid?: string; element: string; sequence: number };
      path: { card_id: string; element_id: string };
    }): Promise<LarkApiResponse>;
    create(payload: {
      data: {
        type: 'insert_before' | 'insert_after' | 'append';
        target_element_id?: string;
        uuid?: string;
        sequence: number;
        /** JSON array of elements, serialised. */
        elements: string;
      };
      path: { card_id: string };
    }): Promise<LarkApiResponse>;
    delete(payload: { data: { uuid?: string; sequence: number }; path: { card_id: string; element_id: string } }): Promise<LarkApiResponse>;
  };
}

/** Upload result: the SDK 1.74 returns the key unwrapped (`{ file_key }`); the raw API wraps it in `data`. */
export type LarkUploadResponse<K extends string> = ({ [k in K]?: string } & { code?: number; msg?: string; data?: { [k in K]?: string } }) | null;

/** `im.v1.file.create` (multipart; at most 30 MB, not empty). */
export interface LarkFileApi {
  create(payload: {
    data: { file_type: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'; file_name: string; duration?: number; file: Buffer };
  }): Promise<LarkUploadResponse<'file_key'>>;
}

/** `im.v1.image.create` (multipart; at most 10 MB; `message` images can be sent in chats). */
export interface LarkImageApi {
  create(payload: { data: { image_type: 'message' | 'avatar'; image: Buffer } }): Promise<LarkUploadResponse<'image_key'>>;
}

export interface LarkClientLike {
  /**
   * `messageResource` is optional so narrow test clients need not provide it (media then keep `lark-file:` refs).
   * `file` / `image` upload host blobs for outbound attachments; absent → such attachments fail to send.
   */
  im: { v1: { message: LarkMessageApi; messageResource?: LarkMessageResourceApi; file?: LarkFileApi; image?: LarkImageApi } };
  /** Contact lookups for sender names; absent → names stay unset. */
  contact?: { v3: { user: LarkContactUserApi } };
  /** CardKit. Absent on a client that predates it: process cards then use message patch. */
  cardkit?: { v1: LarkCardKitApi };
  /**
   * Raw OpenAPI call (bot info, the `message_cot` thinking bubble, which the SDK has no
   * method for). Resolves to the response body; rejects on HTTP errors.
   */
  request(opts: { method: string; url: string; data?: unknown; params?: unknown; timeout?: number }): Promise<unknown>;
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
  action?: { value?: unknown; tag?: string; name?: string; option?: string; options?: string[]; form_value?: unknown };
  context?: { open_message_id?: string; open_chat_id?: string };
}
