import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DaemonRecords } from './records.js';

/*
 * Backend keys (INVARIANTS PB-3, docs/design/persona-backend §3). A backend
 * (config `backends.<id>`) authenticates with a key of its own instead of the
 * host token. The daemon makes the key and shows it once, in the answer of
 * `issue` / `rotate`; it keeps the key's SHA-256 only (`daemon_backend_keys`,
 * the session log's database). Nothing here logs: callers log the key id.
 */

/** Every backend key starts with this. */
export const BACKEND_KEY_PREFIX = 'aiob_';
/** A backend id: it becomes a consumer name (`backend:<id>`) and an operation id prefix. */
export const BACKEND_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `unknown_backend`: the id is not configured. `key_exists`: `issue` on a backend that has a key (rotate replaces it). */
export class BackendKeyError extends Error {
  constructor(
    readonly code: 'unknown_backend' | 'key_exists',
    message: string,
  ) {
    super(message);
  }
}

/** A key as it is shown, once. */
export interface IssuedBackendKey {
  /** The key itself. Not kept anywhere by the daemon. */
  key: string;
  /** The first 12 hex digits of its SHA-256: what logs and listings name it by. */
  keyId: string;
  /** Unix ms. */
  createdAt: number;
}

const digest = (token: string) => createHash('sha256').update(token).digest();
const keyIdOf = (hash: string) => hash.slice(0, 12);

export class BackendKeys {
  /**
   * @param ids The configured backend ids. Only their keys verify; a key row of another id
   *   is dead weight until `pruneUnconfigured` removes it.
   */
  constructor(
    private readonly records: Pick<DaemonRecords, 'backendKeys' | 'putBackendKey' | 'delBackendKey'>,
    private readonly ids: () => readonly string[],
    private readonly now: () => number = Date.now,
  ) {}

  private configured(id: string): boolean {
    return this.ids().includes(id);
  }

  private mustBeConfigured(id: string): void {
    if (!this.configured(id)) throw new BackendKeyError('unknown_backend', `no backend ${JSON.stringify(id)} in the config (backends)`);
  }

  private make(id: string): IssuedBackendKey {
    const key = BACKEND_KEY_PREFIX + randomBytes(32).toString('base64url');
    const hash = digest(key).toString('hex');
    const createdAt = this.now();
    this.records.putBackendKey(id, hash, createdAt);
    return { key, keyId: keyIdOf(hash), createdAt };
  }

  /** A first key for a configured backend. `key_exists` when it has one (`rotate` replaces it). */
  issue(id: string): IssuedBackendKey {
    this.mustBeConfigured(id);
    if (this.records.backendKeys().some((r) => r.backend === id)) throw new BackendKeyError('key_exists', `backend ${id} already has a key; rotate replaces it (the old one stops working at once)`);
    return this.make(id);
  }

  /** A new key in place of the old one, which stops verifying at once. Without an old one this is `issue`. */
  rotate(id: string): IssuedBackendKey {
    this.mustBeConfigured(id);
    return this.make(id);
  }

  /** Remove the backend's key; whether it had one. */
  revoke(id: string): boolean {
    this.mustBeConfigured(id);
    return this.records.delBackendKey(id);
  }

  /**
   * The backend whose key `token` is. Compares the token's digest with the digest of every
   * configured backend's key in constant time, without stopping at a match.
   */
  verify(token: string): { id: string; keyId: string } | undefined {
    const given = digest(token);
    const ids = new Set(this.ids());
    let found: { id: string; keyId: string } | undefined;
    for (const r of this.records.backendKeys()) {
      const stored = Buffer.from(r.hash, 'hex');
      const same = stored.length === given.length && timingSafeEqual(stored, given);
      if (same && ids.has(r.backend)) found = { id: r.backend, keyId: keyIdOf(r.hash) };
    }
    return found;
  }

  /** `keyId` is still the key of backend `id` (a connection checks this on every frame). */
  current(id: string, keyId: string): boolean {
    return this.configured(id) && this.records.backendKeys().some((r) => r.backend === id && keyIdOf(r.hash) === keyId);
  }

  /** `token` is some configured backend's key. */
  has(token: string): boolean {
    return this.verify(token) !== undefined;
  }

  /** The keys there are, by backend: id and age, never the key. */
  list(): { backend: string; keyId: string; createdAt: number }[] {
    return this.records.backendKeys().map((r) => ({ backend: r.backend, keyId: keyIdOf(r.hash), createdAt: r.createdAt }));
  }

  /** Delete the keys of backends that are no longer configured; their ids. */
  pruneUnconfigured(): string[] {
    const gone = this.records.backendKeys().map((r) => r.backend).filter((id) => !this.configured(id));
    for (const id of gone) this.records.delBackendKey(id);
    return gone;
  }
}
