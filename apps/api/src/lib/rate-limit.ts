// Rate limiting (design/02 §7, FR-103).
//
// Two layers with different jobs:
//   * a fast in-memory window that caps request volume per key, and
//   * durable lockout counters in the database for sign-in, so a restart does not
//     reset an attacker's budget and every API instance shares the same state.
//
// The in-memory limiter sits behind this interface so a shared store can replace it
// when the API runs on more than one instance, without touching any route.

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): RateLimitResult;
  reset(key: string): void;
}

export class MemoryRateLimiter implements RateLimiter {
  #buckets = new Map<string, { count: number; resetAt: number }>();
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  consume(key: string, limit: number, windowSeconds: number): RateLimitResult {
    const now = this.#now();
    const bucket = this.#buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      this.#sweep(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (bucket.count >= limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.#buckets.delete(key);
  }

  /** Keeps the map from growing without bound on a long-running process. */
  #sweep(now: number): void {
    if (this.#buckets.size < 10_000) return;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now) this.#buckets.delete(key);
    }
  }
}

/** Limits per route class, from design/02 §7. */
export const LIMITS = {
  login: { limit: 10, windowSeconds: 15 * 60 },
  mfa: { limit: 10, windowSeconds: 15 * 60 },
  passwordForgot: { limit: 5, windowSeconds: 60 * 60 },
  invitationAccept: { limit: 5, windowSeconds: 60 * 60 },
  authenticated: { limit: 300, windowSeconds: 60 },
} as const;

/** Failed sign-ins before the account is temporarily locked (FR-103). */
export const LOCKOUT = { threshold: 5, windowMinutes: 15 } as const;
