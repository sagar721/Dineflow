// Short-lived cache of each restaurant's public menu (design/00: 15 s; FR-027 allows 30 s).
//
// Staff edits through this API instance clear the entry at once, so a change shows
// on the next scan. The time limit covers everything else — a second instance, or a
// change made outside the API — and keeps any staleness well inside 30 seconds.
export const MENU_CACHE_TTL_MS = 15_000;

export class MenuCache<T> {
  readonly #entries = new Map<string, { expires: number; value: T }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs = MENU_CACHE_TTL_MS, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get(restaurantId: string): T | undefined {
    const entry = this.#entries.get(restaurantId);
    if (!entry) return undefined;
    if (entry.expires <= this.#now()) {
      this.#entries.delete(restaurantId);
      return undefined;
    }
    return entry.value;
  }

  set(restaurantId: string, value: T): void {
    this.#entries.set(restaurantId, { expires: this.#now() + this.#ttlMs, value });
  }

  invalidate(restaurantId: string): void {
    this.#entries.delete(restaurantId);
  }
}
