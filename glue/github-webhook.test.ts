import { test, expect } from "bun:test";
import { verifySignature, parseWebhook } from "./github-webhook";
import { createHmac } from "node:crypto";

test("verifySignature accepts correctly-HMAC'd body and rejects tampered one/secret", () => {
  const secret = "my_secret_token";
  const body = JSON.stringify({ hello: "world" });
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  const validHeader = `sha256=${hmac}`;

  // Valid signature
  expect(verifySignature(body, validHeader, secret)).toBe(true);

  // Tampered body
  expect(verifySignature(body + "tampered", validHeader, secret)).toBe(false);

  // Wrong secret
  expect(verifySignature(body, validHeader, "wrong_secret")).toBe(false);

  // Missing or malformed header
  expect(verifySignature(body, "invalid_header", secret)).toBe(false);
  expect(verifySignature(body, "", secret)).toBe(false);
});

test("parseWebhook handles pull_request event", () => {
  const payload = {
    pull_request: {
      number: 101,
    },
  };
  const parsed = parseWebhook(JSON.stringify(payload));
  expect(parsed.event).toBe("pull_request");
  expect(parsed.prNumber).toBe(101);
});

test("parseWebhook handles check_suite conclusion success", () => {
  const payload = {
    check_suite: {
      conclusion: "success",
    },
  };
  const parsed = parseWebhook(JSON.stringify(payload));
  expect(parsed.event).toBe("check_suite");
  expect(parsed.ciPassed).toBe(true);
});

test("parseWebhook handles check_suite conclusion failure", () => {
  const payload = {
    check_suite: {
      conclusion: "failure",
    },
  };
  const parsed = parseWebhook(JSON.stringify(payload));
  expect(parsed.event).toBe("check_suite");
  expect(parsed.ciPassed).toBe(false);
});

test("parseWebhook handles status success", () => {
  const payload = {
    state: "success",
  };
  const parsed = parseWebhook(JSON.stringify(payload));
  expect(parsed.event).toBe("status");
  expect(parsed.ciPassed).toBe(true);
});

test("parseWebhook handles status pending", () => {
  const payload = {
    state: "pending",
  };
  const parsed = parseWebhook(JSON.stringify(payload));
  expect(parsed.event).toBe("status");
  expect(parsed.ciPassed).toBeUndefined();
});

test("parseWebhook handles status failure", () => {
  const payload = {
    state: "failure",
  };
  const parsed = parseWebhook(JSON.stringify(payload));
  expect(parsed.event).toBe("status");
  expect(parsed.ciPassed).toBe(false);
});
test("parseWebhook rejects truthy-but-not-boolean direct status fields", () => {
  expect(() => parseWebhook(JSON.stringify({ event: "status", ciPassed: "yes" }))).toThrow("ciPassed must be a boolean");
  expect(() => parseWebhook(JSON.stringify({ event: "review", reviewPassed: 1 }))).toThrow("reviewPassed must be a boolean");
});

test("parseWebhook accepts strict direct boolean fields", () => {
  const parsed = parseWebhook(JSON.stringify({ event: "review", ciPassed: true, reviewPassed: false }));
  expect(parsed.ciPassed).toBe(true);
  expect(parsed.reviewPassed).toBe(false);
});
