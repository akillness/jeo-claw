import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createNativeProviderFixture, nativeBenignEvidence, type NativeResult } from "./native-probe-evidence.ts";

const nonce = "fixture_nonce_123";
const token = "dummy-token";
const account = "fixture-account";
const model = "fixture-model";
const marker = "response-only-marker-01";

class FakeResponse extends EventEmitter {
  status = 0;
  body = "";
  writeHead(status: number) { this.status = status; return this; }
  end(body?: string) { this.body = body ?? ""; return this; }
}

function request(overrides: { method?: string; url?: string; host?: string; authorization?: string; account?: string; gateway?: string; body?: unknown } = {}) {
  const body = JSON.stringify(overrides.body ?? { model, input: [{ role: "user", content: `Reply with ${nonce}` }] });
  return {
    method: overrides.method ?? "POST", url: overrides.url ?? "/backend-api/codex/responses",
    headers: { host: overrides.host ?? "127.0.0.1:18444", authorization: overrides.authorization ?? `Bearer ${token}`,
      "chatgpt-account-id": overrides.account ?? account, ...(overrides.gateway ? { "x-openai-access-token": overrides.gateway } : {}) },
    socket: { localPort: 18444 },
    async *[Symbol.asyncIterator]() { yield body; },
  };
}

function native(stdout: string): NativeResult {
  return { argv: ["fixture"], exit: 0, signal: null, stdout, stderr: "", timedOut: false, overflow: false };
}

function fixture() {
  return createNativeProviderFixture({ runtime: "zeroclaw", nonce, token, account, model,
    createResponseMarker: () => marker, renderResponse: (value: string) => `response:${value}` });
}

test("provider acceptance alone is not benign evidence without delivered response-only marker in native output", async () => {
  const provider = fixture();
  const response = new FakeResponse();
  await provider.handle(request(), response);
  expect(response.status).toBe(200);
  expect(response.body).toContain(marker);
  expect(nativeBenignEvidence(native(marker), provider.requests)).toBe(false);
  response.emit("finish");
  expect(nativeBenignEvidence(native(`echo ${nonce}`), provider.requests)).toBe(false);
  expect(nativeBenignEvidence(native(`result ${marker}`), provider.requests)).toBe(true);
  expect(nativeBenignEvidence({ ...native(marker), exit: 1 }, provider.requests)).toBe(false);
  expect(nativeBenignEvidence({ ...native(marker), timedOut: true }, provider.requests)).toBe(false);
});

test("rejected provider requests cannot contribute to benign evidence", async () => {
  const invalid = [
    { method: "GET" }, { url: "/wrong" }, { host: "evil.example" }, { authorization: "Bearer wrong" },
    { account: "wrong" }, { gateway: "injected" }, { body: { model: "wrong", input: nonce } },
    { body: { model, input: "unrelated" } },
  ];
  for (const input of invalid) {
    const provider = fixture();
    const response = new FakeResponse();
    await provider.handle(request(input), response);
    response.emit("finish");
    expect(response.status).toBe(400);
    expect(nativeBenignEvidence(native(marker), provider.requests)).toBe(false);
  }
});

test("closed connection and mixed rejected traffic cannot be reported as benign success", async () => {
  const provider = fixture();
  const closed = new FakeResponse();
  await provider.handle(request(), closed);
  closed.emit("close");
  expect(nativeBenignEvidence(native(marker), provider.requests)).toBe(false);
  const good = fixture();
  const delivered = new FakeResponse();
  await good.handle(request(), delivered);
  delivered.emit("finish");
  expect(nativeBenignEvidence(native(marker), good.requests)).toBe(true);
  const rejected = new FakeResponse();
  await good.handle(request({ authorization: "Bearer wrong" }), rejected);
  rejected.emit("finish");
  expect(nativeBenignEvidence(native(marker), good.requests)).toBe(false);
});

test("response marker must be novel relative to the request and actually rendered", async () => {
  const collision = createNativeProviderFixture({ runtime: "zeroclaw", nonce, token, account, model,
    createResponseMarker: () => marker, renderResponse: (value: string) => value });
  const response = new FakeResponse();
  await collision.handle(request({ body: { model, input: `${nonce} ${marker}` } }), response);
  response.emit("finish");
  expect(response.status).toBe(400);
  expect(nativeBenignEvidence(native(marker), collision.requests)).toBe(false);
  const omitted = createNativeProviderFixture({ runtime: "zeroclaw", nonce, token, account, model,
    createResponseMarker: () => marker, renderResponse: () => "no marker" });
  const noMarker = new FakeResponse();
  await omitted.handle(request(), noMarker);
  noMarker.emit("finish");
  expect(noMarker.status).toBe(500);
  expect(nativeBenignEvidence(native(marker), omitted.requests)).toBe(false);
});

test("a response error and interrupted native process cannot establish benign evidence", async () => {
  const provider = fixture();
  const response = new FakeResponse();
  await provider.handle(request(), response);
  response.emit("error", new Error("response failed"));
  response.emit("finish");
  expect(nativeBenignEvidence(native(marker), provider.requests)).toBe(false);
  const delivered = fixture();
  const good = new FakeResponse();
  await delivered.handle(request(), good);
  good.emit("finish");
  expect(nativeBenignEvidence(native(marker), delivered.requests)).toBe(true);
  expect(nativeBenignEvidence({ ...native(marker), signal: "SIGKILL", exit: null }, delivered.requests)).toBe(false);
  expect(nativeBenignEvidence({ ...native(marker), overflow: true }, delivered.requests)).toBe(false);
});

test("each delivered response must be correlated to native output", async () => {
  const markers = ["first-response-marker", "second-response-marker"];
  let next = 0;
  const provider = createNativeProviderFixture({ runtime: "zeroclaw", nonce, token, account, model,
    createResponseMarker: () => markers[next++]!, renderResponse: (value: string) => value });
  for (const expected of markers) {
    const response = new FakeResponse();
    await provider.handle(request(), response);
    expect(response.body).toBe(expected);
    response.emit("finish");
  }
  expect(nativeBenignEvidence(native(markers[0]!), provider.requests)).toBe(false);
  expect(nativeBenignEvidence(native(markers.join(" ")), provider.requests)).toBe(true);
});

test("non-text tool-call response may carry the response marker without becoming benign evidence", async () => {
  const provider = createNativeProviderFixture({ runtime: "zeroclaw", nonce, token, account, model,
    createResponseMarker: () => marker,
    renderResponse: (value: string) => `event: response.completed\ndata: ${JSON.stringify({ response: { id: value, output: [{ type: "function_call", name: "shell", call_id: "call-1", arguments: "{}" }] } })}\n\n` });
  const response = new FakeResponse();
  await provider.handle(request(), response);
  expect(response.status).toBe(200);
  expect(response.body).toContain('"type":"function_call"');
  expect(response.body).toContain(marker);
  response.emit("finish");
  expect(nativeBenignEvidence(native(`echo ${nonce}`), provider.requests)).toBe(false);
});

test("default provider markers differ across requests and cannot be echoed from input", async () => {
  const provider = createNativeProviderFixture({ runtime: "zeroclaw", nonce, token, account, model,
    renderResponse: (value: string) => value });
  const outputs: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = new FakeResponse();
    await provider.handle(request(), response);
    expect(response.status).toBe(200);
    expect(response.body).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(provider.requests[i]!.body).includes(response.body)).toBe(false);
    outputs.push(response.body);
    response.emit("finish");
  }
  expect(outputs[0]).not.toBe(outputs[1]);
  expect(nativeBenignEvidence(native(outputs.join(" ")), provider.requests)).toBe(true);
});
