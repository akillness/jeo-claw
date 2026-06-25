import { test, expect } from "bun:test";
import { DeliveryIdempotencyCache } from "./webhook-idempotency.ts";

// 1. CORE IDEMPOTENCY
test("first sighting is fresh, immediate replay is a duplicate", () => {
  const cache = new DeliveryIdempotencyCache({ now: () => 1000 });
  const first = cache.check("delivery-a");
  expect(first.duplicate).toBe(false);
  expect(first.firstSeenAt).toBe(1000);

  const replay = cache.check("delivery-a");
  expect(replay.duplicate).toBe(true);
  expect(replay.firstSeenAt).toBe(1000); // preserves the original timestamp
});

test("distinct delivery ids are independent", () => {
  const cache = new DeliveryIdempotencyCache();
  expect(cache.check("a").duplicate).toBe(false);
  expect(cache.check("b").duplicate).toBe(false);
  expect(cache.check("a").duplicate).toBe(true);
  expect(cache.check("b").duplicate).toBe(true);
  expect(cache.size).toBe(2);
});

// 2. TTL EXPIRY
test("a delivery is forgotten once its TTL elapses", () => {
  let clock = 0;
  const cache = new DeliveryIdempotencyCache({ ttlMs: 100, now: () => clock });

  clock = 0;
  expect(cache.check("id").duplicate).toBe(false);

  clock = 100; // exactly at TTL boundary — still within window
  expect(cache.check("id").duplicate).toBe(true);

  clock = 250; // > original firstSeen + ttl; entry is stale, treated as fresh again
  const reseen = cache.check("id");
  expect(reseen.duplicate).toBe(false);
  expect(reseen.firstSeenAt).toBe(250);
});

test("expired entries are evicted to bound memory", () => {
  let clock = 0;
  const cache = new DeliveryIdempotencyCache({ ttlMs: 10, now: () => clock });
  cache.check("old-1");
  cache.check("old-2");
  expect(cache.size).toBe(2);

  clock = 1000; // both expired; a new check sweeps them out first
  cache.check("new");
  expect(cache.size).toBe(1);
});

// 3. SIZE BOUND
test("maxEntries caps the cache and evicts oldest first", () => {
  let clock = 0;
  const cache = new DeliveryIdempotencyCache({
    maxEntries: 2,
    ttlMs: 1_000_000,
    now: () => clock++,
  });

  cache.check("a");
  cache.check("b");
  cache.check("c"); // evicts "a" (oldest)

  expect(cache.size).toBe(2);
  // "a" was evicted, so it is no longer remembered as a duplicate.
  expect(cache.check("a").duplicate).toBe(false);
  // "c" is still tracked.
  expect(cache.check("c").duplicate).toBe(true);
});

// 4. CONCURRENT-DELIVERY SERIALIZATION
test("synchronous check-and-record serializes a burst of identical deliveries", () => {
  const cache = new DeliveryIdempotencyCache({ now: () => 5 });
  const results = Array.from({ length: 5 }, () => cache.check("burst"));
  const fresh = results.filter((r) => !r.duplicate);
  const dupes = results.filter((r) => r.duplicate);
  expect(fresh.length).toBe(1);
  expect(dupes.length).toBe(4);
});

// 5. DEGENERATE OPTIONS ARE CLAMPED
test("non-positive ttl/maxEntries are clamped to at least 1", () => {
  const cache = new DeliveryIdempotencyCache({ ttlMs: 0, maxEntries: 0, now: () => 0 });
  // maxEntries clamped to 1: second distinct id evicts the first.
  expect(cache.check("x").duplicate).toBe(false);
  expect(cache.check("y").duplicate).toBe(false);
  expect(cache.size).toBe(1);
});
