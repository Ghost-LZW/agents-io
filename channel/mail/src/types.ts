import type { SendMailOptions } from 'nodemailer';

export interface MailAuth {
  user: string;
  pass?: string;
  accessToken?: string;
}

export interface MailChannelConfig {
  /** Account id used in envelopes and routes. */
  account: string;
  imap: { host: string; port: number; secure: boolean; auth: MailAuth };
  smtp: { host: string; port: number; secure: boolean; auth?: { user: string; pass?: string } };
  /** Mailbox to watch. Default INBOX. */
  mailbox?: string;
  /** Address (optionally `Name <addr>`) used as From for outbound mail. */
  from: string;
  /** Poll interval when IDLE is unavailable or silent. Default 60s. */
  pollIntervalMs?: number;
  /** BCC our own mail back to this address so sent mail echoes into the mailbox (enables `declared`). */
  bccSelf?: boolean;
}

/** UID-based inbound checkpoint; the host persists it through `MailStore`. */
export interface MailCheckpoint {
  uidValidity: string;
  /** Highest UID that has been handed to the host. */
  uid: number;
}

/** What we remember about mail we sent (echo detection, idempotency). */
export interface SentRecord {
  operationId: string;
  as?: string;
  state: 'pending' | 'sent';
}

/** What we remember about mail we saw, so a reply route (which carries no address) can be resolved. */
export interface MessageMeta {
  /** Address replies go to (Reply-To, else From). */
  replyTo: string;
  /** From address of that message (absent on records written by older versions). */
  from?: string;
  subject: string;
  /** References chain of that message, plus the message itself. */
  references: string[];
  threadRoot: string;
}

/** Durable state the host provides. Everything is keyed within one account. */
export interface MailStore {
  getCheckpoint(mailbox: string): Promise<MailCheckpoint | undefined>;
  setCheckpoint(mailbox: string, cp: MailCheckpoint): Promise<void>;
  getSent(messageId: string): Promise<SentRecord | undefined>;
  putSent(messageId: string, rec: SentRecord): Promise<void>;
  getMeta(messageId: string): Promise<MessageMeta | undefined>;
  putMeta(messageId: string, meta: MessageMeta): Promise<void>;
}

export class MemoryMailStore implements MailStore {
  private checkpoints = new Map<string, MailCheckpoint>();
  private sent = new Map<string, SentRecord>();
  private meta = new Map<string, MessageMeta>();
  async getCheckpoint(mailbox: string) {
    return this.checkpoints.get(mailbox);
  }
  async setCheckpoint(mailbox: string, cp: MailCheckpoint) {
    this.checkpoints.set(mailbox, cp);
  }
  async getSent(messageId: string) {
    return this.sent.get(messageId);
  }
  async putSent(messageId: string, rec: SentRecord) {
    this.sent.set(messageId, rec);
  }
  async getMeta(messageId: string) {
    return this.meta.get(messageId);
  }
  async putMeta(messageId: string, meta: MessageMeta) {
    this.meta.set(messageId, meta);
  }
}

export interface AttachmentBlob {
  uid: number;
  index: number;
  filename?: string;
  contentType: string;
  content: Buffer;
}

/**
 * Where attachment bytes go. They are never inlined into envelopes. A sink that
 * returns a ref (e.g. a host `BlobStore`'s `sha256:<hex>`) turns the attachment into
 * an `image`/`file` block with that ref; one that returns nothing leaves a
 * `mail-attachment:<uid>/<index>` ref block.
 */
export interface BlobSink {
  put(blob: AttachmentBlob): Promise<string | void>;
}

export interface FetchedMail {
  uid: number;
  raw: Buffer;
}

/** The IMAP side, abstracted so tests need no network. */
export interface MailSource {
  /**
   * Runs until `signal` aborts, reconnecting on its own. Delivers messages with
   * uid greater than the checkpoint, in UID order, awaiting `onMessage` for each.
   * If `onMessage` rejects, the same message is retried after a backoff.
   */
  watch(args: {
    mailbox: string;
    signal: AbortSignal;
    checkpoint(): Promise<MailCheckpoint | undefined>;
    /** No usable checkpoint (first run or UIDVALIDITY change): start after this point. */
    baseline(cp: MailCheckpoint): Promise<void>;
    onMessage(mail: FetchedMail & { uidValidity: string }): Promise<void>;
    log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
  }): Promise<void>;
}

export interface MailTransport {
  sendMail(opts: SendMailOptions): Promise<unknown>;
}

export interface AuthVerdict {
  /** `dkim_pass` only when DMARC/DKIM aligned-passes for the From domain. */
  evidence: 'dkim_pass' | 'none';
  detail?: string;
}

export type MailVerifier = (raw: Buffer, fromDomain: string) => Promise<AuthVerdict>;
