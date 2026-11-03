import { expect, test } from "bun:test";
import { shutdownServer } from "./orchestrator.ts";

test("shutdown forces active connections closed and waits for stop to finish", async () => {
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  const server = {
    stop(closeActiveConnections?: boolean): Promise<void> {
      if (closeActiveConnections !== true) return Promise.reject(new Error("active connections left open"));
      return stopped;
    },
  };
  const shutdown = shutdownServer(server, 1000);
  let finished = false;
  void shutdown.then(() => { finished = true; }, () => { finished = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  finish();
  await expect(shutdown).resolves.toBeUndefined();
});

test("shutdown propagates the server stop failure", async () => {
  const failure = new Error("server stop failed");
  const server = { stop: async () => { throw failure; } };
  await expect(shutdownServer(server, 1000)).rejects.toBe(failure);
});

test("shutdown rejects when server stop does not complete before its deadline", async () => {
  const server = { stop: () => new Promise<void>(() => {}) };
  await expect(shutdownServer(server, 0)).rejects.toThrow();
});
