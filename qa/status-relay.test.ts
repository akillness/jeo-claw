
import { test, expect } from "bun:test";
import { buildStatusRelayHandler } from "../discord/bot";

test("StatusRelayHandler includes repo in content when provided", async () => {
  let capturedContent = "";
  const handler = buildStatusRelayHandler({
    sendToChannel: async (content) => {
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
    sendToChannel: async (content) => {
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
    body: JSON.stringify(payload)
  });

  await handler(req);
  expect(capturedContent).toContain("🏰");
  expect(capturedContent).toContain("[-]"); // default repo
});
