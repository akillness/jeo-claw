import { test, expect } from "bun:test";
import { handleDispatchRequest } from "./start.ts";

test("oversized streamed dispatch without content-length is rejected and its source cancelled", async () => {
  let chunksRead = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksRead++;
      controller.enqueue(new Uint8Array(32 * 1024));
      if (chunksRead === 100) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://runtime/dispatch", {
    method: "POST",
    headers: { "x-runtime-dispatch-secret": "test-secret" },
    body,
  });

  const response = await handleDispatchRequest(request, "zeroclaw", "reviewer", "test-secret");

  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(chunksRead).toBeLessThan(100);
});

test("aborting a stalled streamed request stops reading and rejects the dispatch", async () => {
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { entered(); return new Promise<void>(() => {}); },
    cancel() { cancelled = true; },
  });
  const abort = new AbortController();
  const request = new Request("http://runtime/dispatch", {
    method: "POST", headers: { "x-runtime-dispatch-secret": "test-secret" }, body, signal: abort.signal,
  });
  const pending = handleDispatchRequest(request, "zeroclaw", "reviewer", "test-secret");
  await reading;
  abort.abort();
  const response = await pending;
  expect(response.ok).toBe(false);
  expect(cancelled).toBe(true);
}, 1000);

test("oversized dispatch returns even if cancelling the body never settles", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  });
  const request = new Request("http://runtime/dispatch", {
    method: "POST", headers: { "x-runtime-dispatch-secret": "test-secret" }, body,
  });
  const response = await handleDispatchRequest(request, "zeroclaw", "reviewer", "test-secret");
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
}, 1000);
