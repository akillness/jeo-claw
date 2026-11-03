import { expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { acquireRuntimeProcess } from "./start.ts";

function listen(port: number) {
  return Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("occupied") });
}

test("an occupied runtime port does not launch a child or disrupt its owner", async () => {
  const existing = listen(0);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const occupiedPort = existing.port;
    if (occupiedPort === undefined) throw new Error("TCP server has no port");
    expect(() => acquireRuntimeProcess(
      () => listen(occupiedPort),
      () => (child = spawn(process.execPath, ["-e", "process.stdin.resume()"])),
      () => {},
    )).toThrow();
    expect(child).toBeUndefined();
    const response = await fetch(`http://127.0.0.1:${occupiedPort}/`);
    expect(await response.text()).toBe("occupied");
  } finally {
    if (child) {
      const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      child.kill();
      await closed;
    }
    existing.stop(true);
  }
});

test("a synchronous child-start failure releases the runtime port", () => {
  let port = 0;
  expect(() => acquireRuntimeProcess(
    () => {
      const server = listen(0);
      if (server.port === undefined) {
        server.stop(true);
        throw new Error("TCP server has no port");
      }
      port = server.port;
      return server;
    },
    () => { throw new Error("child could not start"); },
    () => {},
  )).toThrow("child could not start");
  const replacement = listen(port);
  try {
    expect(replacement.port).toBe(port);
  } finally {
    replacement.stop(true);
  }
});
