# Ouroboros Evolution Cycle: Spec-Kit Driven Deep Refactoring

## 1. Problem Definition

After reviewing the core files (`glue/server.ts`, `discord/bot.ts`, `claws/worker.ts`), several performance bottlenecks, potential memory leaks, and unhandled promise rejections were identified:

1.  **`glue/server.ts` - `processQueue` Recursion & Unhandled Rejections:**
    *   `processQueue` is called recursively using `.catch(console.error)`. This can lead to deep call stacks or unhandled promise rejections if the error handling isn't robust.
    *   It's called asynchronously without `await` in several places, which is fine for fire-and-forget, but the recursive nature is problematic.

2.  **`glue/server.ts` - Interval Leaks & Overlapping Executions:**
    *   `autoMergeInterval` (60s) and the OOO RALPH auto-heal interval (15s) are set up using `setInterval`.
    *   The callbacks inside these intervals are `async`. If the execution of the callback takes longer than the interval, overlapping executions will occur, leading to race conditions and memory bloat.
    *   There is no mechanism to clear these intervals on shutdown or reload.

3.  **`glue/server.ts` - `pendingQueue` Unbounded Growth:**
    *   `pendingQueue` is a simple array. While there is a cleanup mechanism (`pendingQueue.splice(...)`), it might not be sufficient under heavy load, and the array operations (`splice`, `filter`, `includes`) are O(N) or O(N^2), which is inefficient for a queue.

4.  **`discord/bot.ts` - Event Debouncing & Idempotency:**
    *   Discord interactions and messages are processed as they come in. There is no debouncing or idempotency check, meaning a user clicking a button multiple times quickly could trigger multiple workflow state transitions.

## 2. Plan

1.  **Refactor `processQueue`:**
    *   Change from recursive calls to a `while` loop to prevent call stack growth and improve readability.
    *   Ensure all promise rejections are properly caught and handled within the loop.

2.  **Fix Interval Overlaps (Debouncing/Locking):**
    *   Implement a simple locking mechanism (e.g., `let isAutoMergeRunning = false;`) inside the `setInterval` callbacks to prevent overlapping executions.
    *   Ensure intervals are properly managed.

3.  **Optimize `pendingQueue`:**
    *   Use a `Set` for `pendingQueue` to ensure uniqueness and O(1) lookups/deletions, or keep it as an array but optimize the cleanup logic to avoid O(N^2) operations.

4.  **Discord Event Idempotency:**
    *   Implement a simple cache (e.g., `Map` with TTL) in `discord/bot.ts` to track recently processed interaction IDs and prevent duplicate processing.

5.  **Self-Healing Loop:**
    *   Run tests after modifications.
    *   If tests fail, analyze the error and fix it.

6.  **Finalize:**
    *   Ensure Discord popups only trigger on `awaiting-approval`.
    *   Document the changes.