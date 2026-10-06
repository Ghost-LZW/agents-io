/**
 * Maps a provider message id to the sender identity (`SendOp.as`) declared when
 * this adapter sent it. Hosts that need declarations to survive restarts supply a
 * persistent implementation.
 */
export interface DeclaredSenderStore {
  set(providerMessageId: string, as: string): void | Promise<void>;
  get(providerMessageId: string): string | undefined | Promise<string | undefined>;
}

/** Bounded in-memory store (oldest entries are evicted first). */
export class MemoryDeclaredSenderStore implements DeclaredSenderStore {
  private readonly map = new Map<string, string>();
  constructor(private readonly max = 10_000) {}

  set(id: string, as: string): void {
    this.map.delete(id);
    this.map.set(id, as);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  get(id: string): string | undefined {
    return this.map.get(id);
  }
}

/** Remembers keys for a time window; used to drop platform redeliveries. */
export class DedupWindow {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly windowMs: number,
    private readonly max = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the key was already seen inside the window (and refreshes nothing). */
  has(key: string): boolean {
    const exp = this.seen.get(key);
    if (exp === undefined) return false;
    if (exp <= this.now()) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  add(key: string): void {
    this.seen.delete(key);
    this.seen.set(key, this.now() + this.windowMs);
    if (this.seen.size > this.max) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.seen.delete(key);
  }
}
