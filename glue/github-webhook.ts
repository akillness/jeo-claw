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

export function parseWebhook(rawBody: string): { event: string; prNumber?: number; ciPassed?: boolean; reviewPassed?: boolean } {
  const payload = JSON.parse(rawBody);

  let event = "unknown";
  let prNumber: number | undefined;
  let ciPassed: boolean | undefined;
  let reviewPassed: boolean | undefined;

  if (payload.pull_request) {
    event = "pull_request";
    prNumber = payload.pull_request.number ?? payload.number;
  } else if (payload.check_suite) {
    event = "check_suite";
    if (payload.check_suite.conclusion === "success") {
      ciPassed = true;
    } else if (payload.check_suite.conclusion) {
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

  if (payload.event) {
    event = String(payload.event);
  }
  if (payload.prNumber !== undefined) {
    if (typeof payload.prNumber !== "number" || !Number.isInteger(payload.prNumber)) {
      throw new Error("prNumber must be an integer");
    }
    prNumber = payload.prNumber;
  }

  const directCi = strictOptionalBoolean(payload, "ciPassed");
  if (directCi !== undefined) ciPassed = directCi;
  const directReview = strictOptionalBoolean(payload, "reviewPassed");
  if (directReview !== undefined) reviewPassed = directReview;

  return { event, prNumber, ciPassed, reviewPassed };
}
