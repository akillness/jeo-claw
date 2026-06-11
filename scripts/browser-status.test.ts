import { test, expect } from "bun:test";
import { renderStatusHtml, type BrowserStatusPayload } from "./browser-status.ts";

test("renderStatusHtml includes container and workflow data", () => {
  const payload: BrowserStatusPayload = {
    generatedAt: "2026-06-10T09:35:53.463Z",
    containers: [
      { service: "discord-bot", state: "running", health: "healthy" },
      { service: "zeroclaw-researcher-coder", state: "running", health: "healthy" },
    ],
    workflows: [
      {
        id: "wf-1",
        runtime: "zeroclaw",
        request: "browser verification",
        stage: "pr-create",
        status: "awaiting-approval",
        pendingAction: "pr.create",
        headRef: "jeo/zeroclaw/pr-creator/wf-1",
      },
    ],
  };

  const html = renderStatusHtml(payload);
  expect(html).toContain("jeo-claw runtime browser status");
  expect(html).toContain("discord-bot");
  expect(html).toContain("wf-1");
  expect(html).toContain("browser verification");
  expect(html).toContain("awaiting-approval");
});
