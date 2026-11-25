import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BackendAccess } from '@agents-io/protocol';
import type { DaemonRecords } from './records.js';

/*
 * Backend keys (INVARIANTS PB-3, PB-7, docs/design/persona-backend §3). A backend
 * (config `backends.<id>`) authenticates with a key of its own instead of the
 * host token. The daemon makes the key and shows it once, in the answer of
 * `issue` / `rotate`; it keeps the key's SHA-256 only (the session log's database).
 * Nothing here logs: callers log the key id.
 *
 * Two levels, at most one key of each per backend, each issued, rotated and revoked
 * on its own: `readwrite` (the backend itself; `daemon_backend_keys`) and `read` (an
 * observer of that backend; `daemon_backend_access_keys`). The level of a key is the
 * one stored with its digest, never read off the key's text.
 */

/** Every read-write backend key starts with this. */
export const BACKEND_KEY_PREFIX = 'aiob_';
/**
 * Every read key starts with this, so the two are told apart by eye before one is handed to the
 * wrong party. A mark only: a read-write key's fifth character is always `_`, so it never looks
 * like one; what a key may do is decided by the stored level.
 */
export const BACKEND_READ_KEY_PREFIX = 'aiobr_';
/** A backend id: it becomes a consumer name (`backend:<id>`) and an operation id prefix. */
export const BACKEND_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `unknown_backend`: the id is not configured. `key_exists`: `issue` on a backend that has a key of that level (rotate replaces it). */
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

  private make(id: string, access: BackendAccess): IssuedBackendKey {
    const key = (access === 'read' ? BACKEND_READ_KEY_PREFIX : BACKEND_KEY_PREFIX) + randomBytes(32).toString('base64url');
    const hash = digest(key).toString('hex');
    const createdAt = this.now();
    this.records.putBackendKey(id, hash, createdAt, access);
    return { key, keyId: keyIdOf(hash), createdAt };
  }

  /** A first key of one level for a configured backend. `key_exists` when it has one of that level (`rotate` replaces it). */
  issue(id: string, access: BackendAccess = 'readwrite'): IssuedBackendKey {
    this.mustBeConfigured(id);
    if (this.records.backendKeys().some((r) => r.backend === id && r.access === access)) {
      throw new BackendKeyError('key_exists', `backend ${id} already has a ${access === 'read' ? 'read key' : 'key'}; rotate replaces it (the old one stops working at once)`);
    }
    return this.make(id, access);
  }

  /** A new key in place of the old one of that level, which stops verifying at once. Without an old one this is `issue`. */
  rotate(id: string, access: BackendAccess = 'readwrite'): IssuedBackendKey {
    this.mustBeConfigured(id);
    return this.make(id, access);
  }

  /** Remove the backend's key of one level; whether it had one. The other level's key stays. */
  revoke(id: string, access: BackendAccess = 'readwrite'): boolean {
    this.mustBeConfigured(id);
    return this.records.delBackendKey(id, access);
  }

  /**
   * The backend whose key `token` is, and the key's level. Compares the token's digest with the
   * digest of every configured backend's key of either level in constant time, without stopping at
   * a match. Should one digest ever be stored under both levels, the answer is the lesser (`read`).
   */
  verify(token: string): { id: string; keyId: string; access: BackendAccess } | undefined {
    const given = digest(token);
    const ids = new Set(this.ids());
    let found: { id: string; keyId: string; access: BackendAccess } | undefined;
    for (const r of this.records.backendKeys()) {
      const stored = Buffer.from(r.hash, 'hex');
      const same = stored.length === given.length && timingSafeEqual(stored, given);
      if (same && ids.has(r.backend) && found?.access !== 'read') found = { id: r.backend, keyId: keyIdOf(r.hash), access: r.access };
    }
    return found;
  }

  /** `keyId` is still backend `id`'s key of that level (a connection checks this on every frame). */
  current(id: string, keyId: string, access: BackendAccess): boolean {
    return this.configured(id) && this.records.backendKeys().some((r) => r.backend === id && r.access === access && keyIdOf(r.hash) === keyId);
  }

  /** `token` is some configured backend's key. */
  has(token: string): boolean {
    return this.verify(token) !== undefined;
  }

  /** The keys there are, by backend and level: id and age, never the key. */
  list(): { backend: string; access: BackendAccess; keyId: string; createdAt: number }[] {
    return this.records.backendKeys().map((r) => ({ backend: r.backend, access: r.access, keyId: keyIdOf(r.hash), createdAt: r.createdAt }));
  }

  /** Delete the keys (both levels) of backends that are no longer configured; their ids, each once. */
  pruneUnconfigured(): string[] {
    const gone = [...new Set(this.records.backendKeys().map((r) => r.backend).filter((id) => !this.configured(id)))];
    for (const id of gone) this.records.delBackendKey(id);
    return gone;
  }
}
