import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const parts = signatureHeader.split("=");
  const algorithm = parts[0];
  const signature = parts[1];

  if (algorithm !== "sha256" || !signature) {
    return false;
  }

  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  const digest = hmac.digest("hex");

  const digestBuffer = Buffer.from(digest, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  if (digestBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(digestBuffer, signatureBuffer);
}

function strictOptionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in payload)) return undefined;
  const value = payload[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function strictOptionalInteger(payload: Record<string, unknown>, key: string): number | undefined {
  if (!(key in payload)) return undefined;
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
}

function objectValue(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = payload[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function strictOptionalString(payload: Record<string, unknown>, key: string): string | undefined {
  if (!(key in payload)) return undefined;
  const value = payload[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

export function parseWebhook(rawBody: string): { event: string; workflowId?: string; prNumber?: number; ciPassed?: boolean; reviewPassed?: boolean } {
  const payload = JSON.parse(rawBody) as Record<string, unknown>;

  let event = "unknown";
  let prNumber: number | undefined;
  let ciPassed: boolean | undefined;
  let reviewPassed: boolean | undefined;

  const pullRequest = objectValue(payload, "pull_request");
  const checkSuite = objectValue(payload, "check_suite");
  const review = objectValue(payload, "review");

  if (pullRequest && review) {
    event = "pull_request_review";
    prNumber = strictOptionalInteger(pullRequest, "number") ?? strictOptionalInteger(payload, "number");
    const reviewState = String(review.state ?? "").toLowerCase();
    if (reviewState === "approved") {
      reviewPassed = true;
    } else if (reviewState === "changes_requested" || reviewState === "dismissed") {
      reviewPassed = false;
    }
  } else if (pullRequest) {
    event = "pull_request";
    prNumber = strictOptionalInteger(pullRequest, "number") ?? strictOptionalInteger(payload, "number");
  } else if (checkSuite) {
    event = "check_suite";
    if (checkSuite.conclusion === "success") {
      ciPassed = true;
    } else if (checkSuite.conclusion) {
      ciPassed = false;
    }
  } else if (payload.status || payload.state) {
    event = "status";
    const state = payload.state ?? payload.status;
    if (state === "success") {
      ciPassed = true;
    } else if (state && state !== "pending") {
      ciPassed = false;
    }
  }

  const eventOverride = strictOptionalString(payload, "event");
  if (eventOverride) {
    event = eventOverride;
  }

  const directPrNumber = strictOptionalInteger(payload, "prNumber");
  if (directPrNumber !== undefined) prNumber = directPrNumber;

  const directCi = strictOptionalBoolean(payload, "ciPassed");
  if (directCi !== undefined) ciPassed = directCi;
  const directReview = strictOptionalBoolean(payload, "reviewPassed");
  if (directReview !== undefined) reviewPassed = directReview;

  const workflowId = strictOptionalString(payload, "workflowId") ?? strictOptionalString(payload, "id");

  return { event, workflowId, prNumber, ciPassed, reviewPassed };
}
