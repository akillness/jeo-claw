import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { discordProxyRequest, installDiscordGatewayProxy } from "./proxy-transport.ts";

const sockets = new Set<Socket | Duplex>();
const targets: string[] = [];
const proxy = createServer();
proxy.on("connect", (request, downstream, head) => {
  const target = request.url ?? "";
  targets.push(target);
  if (target !== expectedTarget) { downstream.destroy(); return; }
  assert(origin.port !== undefined);
  const upstream = connect({ host: "127.0.0.1", port: origin.port });
  sockets.add(downstream);
  sockets.add(upstream);
  downstream.on("close", () => sockets.delete(downstream));
  upstream.on("close", () => sockets.delete(upstream));
  downstream.on("error", () => upstream.destroy());
  upstream.on("error", () => downstream.destroy());
  upstream.once("connect", () => {
    downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    downstream.pipe(upstream).pipe(downstream);
  });
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const address = proxy.address();
assert(address && typeof address !== "string");
const proxyUrl = `http://127.0.0.1:${address.port}`;
let identifies = 0;
let resumes = 0;
let requests = 0;
let gatewayConnections = 0;
let closeGateway = () => {};
const origin = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  tls: { key: readFileSync(process.env.TEST_KEY!), cert: readFileSync(process.env.TEST_CERT!) },
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/gateway") {
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 400 });
    }
    requests++;
    if (url.pathname === "/api/v10/gateway/bot") {
      return Response.json({ url: `wss://localhost:${server.port}/gateway`, shards: 1, session_start_limit: { total: 1, remaining: 1, reset_after: 1000, max_concurrency: 1 } });
    }
    if (url.pathname === "/api/v10/test") return Response.json({ result: "proxied" });
    return new Response("unexpected endpoint", { status: 404 });
  },
  websocket: {
    open(ws) { gatewayConnections++; closeGateway = () => ws.close(4000, "synthetic outage"); ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } })); },
    message(ws, message) {
      const packet = JSON.parse(String(message));
      if (packet.op === 2) {
        identifies++;
        ws.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { v: 10, session_id: "synthetic-session", resume_gateway_url: `wss://localhost:${origin.port}/gateway`, user: { id: "1", username: "fixture", discriminator: "0001", avatar: null, bot: true }, application: { id: "1", flags: 0 }, guilds: [], private_channels: [] } }));
        ws.close(4000, "synthetic resumable disconnect");
      } else if (packet.op === 6) {
        resumes++;
        ws.send(JSON.stringify({ op: 0, t: "RESUMED", s: 2, d: {} }));
      } else if (packet.op === 1) ws.send(JSON.stringify({ op: 11, d: null }));
    },
  },
});
const expectedTarget = `localhost:${origin.port}`;
installDiscordGatewayProxy(proxyUrl);
const ProxyWebSocket = globalThis.WebSocket;
let signalGatewayError!: () => void;
const gatewayError = new Promise<void>((resolve) => { signalGatewayError = resolve; });
class ObservedWebSocket extends ProxyWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener("error", signalGatewayError);
  }
}
globalThis.WebSocket = ObservedWebSocket as typeof WebSocket;
// Import after installing the global transport: this test intentionally exercises module initialization order.
const { Client, REST } = await import("discord.js");
const makeRequest = discordProxyRequest(proxyUrl);
const rest = new REST({ api: `https://localhost:${origin.port}/api`, makeRequest, retries: 0 }).setToken("synthetic-token");
const client = new Client({ intents: [], shardCount: 1, rest: { api: `https://localhost:${origin.port}/api`, makeRequest, retries: 0 } });
const resumed = new Promise<void>((resolve) => {
  client.on("raw", (packet) => { if (packet.t === "RESUMED") resolve(); });
});
try {
  assert.deepEqual(await rest.get("/test"), { result: "proxied" });
  await client.login("synthetic-token");
  await resumed;
  assert.equal(identifies, 1);
  assert.equal(resumes, 1);
  assert.equal(gatewayConnections, 2);
  assert(targets.length >= 3, `expected REST and both gateway CONNECTs, got ${targets}`);
  assert(targets.every((target) => target === expectedTarget));
  const closedProxy = new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  closeGateway();
  await gatewayError;
  for (const socket of sockets) socket.destroy();
  await closedProxy;
  assert.equal(gatewayConnections, 2, "gateway reconnect must not bypass a stopped proxy");
  await client.destroy();
  const requestsBeforeOutage = requests;
  await assert.rejects(rest.get("/test"));
  assert.equal(requests, requestsBeforeOutage, "REST must not bypass a stopped proxy");
  const unavailableClient = new Client({ intents: [], shardCount: 1, rest: { api: `https://localhost:${origin.port}/api`, makeRequest, retries: 0 } });
  try {
    await assert.rejects(unavailableClient.login("synthetic-token"));
    assert.equal(requests, requestsBeforeOutage, "gateway bootstrap must not bypass a stopped proxy");
    assert.equal(gatewayConnections, 2, "gateway must not connect directly when proxy is unavailable");
  } finally {
    await unavailableClient.destroy();
  }
  console.log("proxy fixture passed");
} finally {
  await client.destroy();
  for (const socket of sockets) socket.destroy();
  proxy.close();
  origin.stop(true);
}
process.exit(0);
