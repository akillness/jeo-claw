// Webhook delivery idempotency guard.
//
// GitHub stamps every webhook delivery with a unique `X-GitHub-Delivery` UUID and
// *retries* deliveries (manual redelivery, receiver timeouts, 5xx responses). A retried
// or duplicated delivery carries the SAME delivery id. Without a guard, the second copy
// re-enters `handleWebhookRequest`, re-applies the same `ci.update`/`review.update`/PR
// event, and races the per-workflow lock — producing duplicate stage transitions or
// double-counted CI/review signals.
//
// This module is a pure, side-effect-free, TTL- and size-bounded in-memory cache keyed
// by delivery id. The check-and-record step is synchronous, so concurrent duplicate
// deliveries serialize on the single-threaded event loop: the first records, every later
// copy observes `duplicate: true` and is dropped before any state mutation.

export interface IdempotencyOptions {
  /** How long a delivery id is remembered. Covers GitHub's redelivery window. */
  ttlMs?: number;
  /** Hard cap on remembered ids; oldest are evicted first to bound memory. */
  maxEntries?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface IdempotencyResult {
  /** True when this delivery id was already recorded within the TTL window. */
  duplicate: boolean;
  /** Epoch ms when the id was first recorded (or now, for a fresh record). */
  firstSeenAt: number;
}

// 10 minutes comfortably spans GitHub's automatic retry/redelivery cadence while keeping
// the working set small.
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export class DeliveryIdempotencyCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  // deliveryId -> firstSeenAt(ms). Map preserves insertion order, which (for a forward
  // clock) equals ascending firstSeenAt — enabling cheap oldest-first eviction.
  private readonly seen = new Map<string, number>();

  constructor(options: IdempotencyOptions = {}) {
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  /**
   * Atomically check-and-record a delivery id.
   *
   * Returns `{ duplicate: true }` when the id was recorded within the TTL window
   * (the caller should drop the delivery). Otherwise records the id with a fresh
   * timestamp and returns `{ duplicate: false }`.
   *
   * The duplicate decision is independent of eviction: a not-yet-evicted but expired
   * entry is treated as fresh, so a lazy/stale clock never causes a false duplicate.
   */
  check(deliveryId: string): IdempotencyResult {
    const now = this.now();
    this.evictExpired(now);

    const existing = this.seen.get(deliveryId);
    if (existing !== undefined && now - existing <= this.ttlMs) {
      return { duplicate: true, firstSeenAt: existing };
    }

    // Re-insert so this id becomes the newest entry (correct eviction ordering).
    this.seen.delete(deliveryId);
    this.seen.set(deliveryId, now);
    this.evictOverflow();
    return { duplicate: false, firstSeenAt: now };
  }

  get size(): number {
    return this.seen.size;
  }

  /** Drop the oldest expired entries. Stops at the first live entry (insertion order). */
  private evictExpired(now: number): void {
    for (const [id, seenAt] of this.seen) {
      if (now - seenAt > this.ttlMs) {
        this.seen.delete(id);
      } else {
        break;
      }
    }
  }

  private evictOverflow(): void {
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}
