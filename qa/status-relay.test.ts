
import { test, expect } from "bun:test";
import { buildStatusRelayHandler } from "../discord/bot";

test("StatusRelayHandler includes repo in content when provided", async () => {
  let capturedContent = "";
  const handler = buildStatusRelayHandler({
    statusRelaySecret: "synthetic-relay-secret",
    sendToChannel: async (workflowId, content) => {
      capturedContent = content;
    }
  });

  const payload = {
    workflowId: "wf-123",
    runtime: "zeroclaw",
    stage: "research-code",
    status: "running",
    message: "Working on it",
    repo: "akillness/jeo-claw",
    claw: "🦀 zeroclaw"
  };

  const req = new Request("http://localhost/status", {
    method: "POST",
    headers: { "x-status-relay-secret": "synthetic-relay-secret" },
    body: JSON.stringify(payload)
  });

  const res = await handler(req);
  expect(res.status).toBe(200);
  expect(capturedContent).toContain("[akillness/jeo-claw]");
  expect(capturedContent).toContain("🦀");
  expect(capturedContent).toContain("@CoordinatorClaw");
});

test("StatusRelayHandler defaults to Sovereign emoji when claw is Sovereign", async () => {
  let capturedContent = "";
  const handler = buildStatusRelayHandler({
    statusRelaySecret: "synthetic-relay-secret",
    sendToChannel: async (workflowId, content) => {
      capturedContent = content;
    }
  });

  const payload = {
    workflowId: "wf-456",
    runtime: "nullclaw",
    stage: "merge",
    status: "awaiting-approval",
    message: "Waiting for merge approval",
    claw: "🏰 Sovereign (Orchestrator)"
  };

  const req = new Request("http://localhost/status", {
    method: "POST",
    headers: { "x-status-relay-secret": "synthetic-relay-secret" },
    body: JSON.stringify(payload)
  });

  await handler(req);
  expect(capturedContent).toContain("🏰");
});

test("status relay authenticates before forwarding and rejects an unconfigured secret", async () => {
  const secret = "synthetic-relay-secret";
  const delivered: string[] = [];
  const makeHandler = (statusRelaySecret: string) => buildStatusRelayHandler({
    statusRelaySecret,
    sendToChannel: async (_id, content) => { delivered.push(content); },
  });
  const body = JSON.stringify({ workflowId: "wf-security", stage: "review", status: "running", message: "safe message" });
  const request = (header?: string) => new Request("http://localhost/status", {
    method: "POST", headers: header === undefined ? {} : { "x-status-relay-secret": header }, body,
  });
  const handler = makeHandler(secret);
  expect((await handler(request())).status).toBe(401);
  expect((await handler(request("incorrect-secret"))).status).toBe(401);
  expect((await makeHandler("")(request(""))).status).toBe(401);
  expect(delivered).toEqual([]);
  expect((await handler(request(secret))).status).toBe(200);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain("wf-security");
  expect(delivered[0]).toContain("safe message");
  expect(delivered[0]).not.toContain(secret);
});

test("status relay rejects an oversized body without forwarding", async () => {
  const secret = "synthetic-relay-secret";
  const delivered: string[] = [];
  const handler = buildStatusRelayHandler({ statusRelaySecret: secret, sendToChannel: async (_id, content) => { delivered.push(content); } });
  const body = JSON.stringify({ workflowId: "wf-large", stage: "review", status: "running", message: "ok" });
  const request = new Request("http://localhost/status", {
    method: "POST", headers: { "x-status-relay-secret": secret },
    body: body + " ".repeat(65537 - Buffer.byteLength(body)),
  });
  expect((await handler(request)).status).toBe(413);
  expect(delivered).toEqual([]);
});

test("status relay rejects malformed and incomplete notifications", async () => {
  const delivered: string[] = [];
  const handler = buildStatusRelayHandler({ statusRelaySecret: "synthetic-relay-secret", sendToChannel: async (_id, content) => { delivered.push(content); } });
  for (const body of ["{", JSON.stringify({ workflowId: "wf", stage: "review", status: "running" })]) {
    const response = await handler(new Request("http://localhost/status", { method: "POST", headers: { "x-status-relay-secret": "synthetic-relay-secret" }, body }));
    expect(response.status).toBe(400);
  }
  expect(delivered).toEqual([]);
});
