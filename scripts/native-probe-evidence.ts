import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export interface NativeResult { argv: string[]; exit: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; overflow: boolean }

export function nativeInvocationCompleted(result: NativeResult) {
  return typeof result.exit === "number" && Number.isInteger(result.exit) && result.exit >= 0 && result.signal === null && !result.timedOut && !result.overflow;
}

export interface NativeProviderObservation {
  method: string | undefined; path: string | undefined; host: string | undefined;
  authorizationMatches: boolean; accountMatches: boolean; gatewayHeadersAbsent: boolean;
  body: unknown; accepted: boolean; responseDelivered: boolean; responseMarker?: string;
}

export function createNativeProviderFixture(options: {
  runtime: "zeroclaw" | "nullclaw"; nonce: string; token: string; account: string; model: string;
  renderResponse: (responseMarker: string) => string; createResponseMarker?: () => string;
}) {
  const requests: NativeProviderObservation[] = [];
  const createResponseMarker = options.createResponseMarker ?? (() => randomBytes(32).toString("hex"));
  async function handle(req: AsyncIterable<string | Uint8Array> & { method?: string; url?: string; headers: IncomingHttpHeaders; socket: { localPort?: number } }, res: {
    writeHead(status: number, headers?: Record<string, string>): unknown;
    end(body?: string): unknown;
    once(event: string, listener: () => void): unknown;
  }): Promise<void> {
    const observation: NativeProviderObservation = { method: req.method, path: req.url, host: req.headers.host, authorizationMatches: req.headers.authorization === `Bearer ${options.token}`, accountMatches: req.headers["chatgpt-account-id"] === options.account, gatewayHeadersAbsent: !req.headers["x-openai-access-token"] && !req.headers["x-openai-account-id"], body: undefined, accepted: false, responseDelivered: false };
    requests.push(observation);
    let body = "";
    for await (const chunk of req) { body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"); if (body.length > 1048576) { res.writeHead(413); res.end(); return; } }
    try { observation.body = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
    const authorityMatches = req.headers.host === (req.socket.localPort === 18444 ? "127.0.0.1:18444" : "chatgpt.com");
    if (req.method !== "POST" || req.url !== "/backend-api/codex/responses" || !authorityMatches || !observation.authorizationMatches || (options.runtime === "zeroclaw" && !observation.accountMatches) || !observation.gatewayHeadersAbsent || !isRecord(observation.body) || observation.body.model !== options.model || !body.includes(options.nonce)) { res.writeHead(400); res.end("fixture request rejected"); return; }
    const marker = createResponseMarker();
    if (!marker || body.includes(marker) || options.nonce.includes(marker)) { res.writeHead(400); res.end("fixture response marker rejected"); return; }
    const response = options.renderResponse(marker);
    if (!response.includes(marker)) { res.writeHead(500); res.end(); return; }
    observation.accepted = true;
    observation.responseMarker = marker;
    let closed = false, failed = false;
    res.once("finish", () => { observation.responseDelivered = !closed && !failed; });
    res.once("close", () => { closed = true; });
    res.once("error", () => { failed = true; observation.responseDelivered = false; });
    res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    res.end(response);
  }
  return { requests, handle };
}

export function nativeBenignEvidence(result: NativeResult, requests: readonly NativeProviderObservation[]): boolean {
  return nativeInvocationCompleted(result) && result.exit === 0 && requests.length > 0 && requests.every(request => request.accepted === true && request.responseDelivered === true && request.authorizationMatches && request.gatewayHeadersAbsent && !!request.responseMarker && !JSON.stringify(request.body)?.includes(request.responseMarker) && result.stdout.includes(request.responseMarker));
}

export function nativeAuthRefused(result: NativeResult, requestCount: number) {
  const authFailure = /^(?:error:\s*)?(?:(?:missing|invalid|expired|no) (?:OAuth (?:credentials|profile|token)|authentication credentials|access token|account id)|(?:OAuth|authentication) (?:failed|rejected|required)|(?:OAuth (?:profile|token)|access token|account id) (?:is )?(?:missing|invalid|expired|not found|required))(?:[.:\s]|$)/im;
  return nativeInvocationCompleted(result) && result.exit !== 0 && requestCount === 0 && authFailure.test(`${result.stdout}\n${result.stderr}`);
}

// Drain only for a bounded interval: an escaped descendant may retain a pipe.
// This does not attest descendant absence; the outer container must still be removed.
export async function runNativeCommand(binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60000, drainMs = 250): Promise<NativeResult> {
  const { promise, resolve, reject } = Promise.withResolvers<NativeResult>();
  const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stdout = "", stderr = "", timedOut = false, overflow = false, settled = false;
  let drain: NodeJS.Timeout | undefined;
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (!isRecord(error) || error.code !== "ESRCH") child.kill("SIGKILL"); } } };
  const finish = (exit: number | null, signal: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); clearTimeout(drain);
    kill(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    resolve({ argv: [binary, ...args], exit, signal, stdout, stderr, timedOut, overflow });
  };
  const terminate = () => {
    kill();
    drain ??= setTimeout(() => { timedOut = true; finish(child.exitCode, child.signalCode); }, drainMs);
  };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  const collect = (data: Buffer, target: "stdout" | "stderr") => {
    if (overflow || settled) return;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + data.length > 1048576) { overflow = true; terminate(); return; }
    if (target === "stdout") stdout += data.toString("utf8"); else stderr += data.toString("utf8");
  };
  child.stdout.on("data", data => collect(data, "stdout"));
  child.stderr.on("data", data => collect(data, "stderr"));
  child.on("error", error => { clearTimeout(timer); clearTimeout(drain); settled = true; child.stdout.destroy(); child.stderr.destroy(); reject(error); });
  child.on("exit", terminate);
  child.on("close", finish);
  return promise;
}

// Only a registry/policy refusal attributed to the injected call is evidence.
// Filesystem, executable and resource errors may follow real execution.
export function nativeDenialEvidence(requests: unknown[], expected?: { callId: string; name: string }) {
  const outputs: string[] = [];
  for (const request of requests) {
    if (!isRecord(request) || !isRecord(request.body) || !Array.isArray(request.body.input)) continue;
    const calls = new Map<string, string>();
    if (expected) calls.set(expected.callId, expected.name);
    for (const item of request.body.input) {
      if (!isRecord(item)) continue;
      if (!expected && item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") calls.set(item.call_id, item.name);
      if (!expected && item.role === "assistant" && Array.isArray(item.tool_calls)) for (const call of item.tool_calls) {
        if (isRecord(call) && typeof call.id === "string" && isRecord(call.function) && typeof call.function.name === "string") calls.set(call.id, call.function.name);
      }
    }
    const retain = (text: string, name: string | undefined) => {
      if (!name) return;
      const match = text.match(/^(?:Tool (?:not found|disabled|not allowed)|Unknown tool|Policy denied tool|Approval required for tool): ([a-zA-Z0-9_]+)[.!]?$/i);
      if (match?.[1] === name || /^(?:Unknown tool|Tool disabled|Tool denied by policy|Tool requires approval)[.!]?$/i.test(text)) outputs.push(text);
    };
    for (const item of request.body.input) {
      if (!isRecord(item)) continue;
      if (item.type === "function_call_output" && typeof item.call_id === "string" && typeof item.output === "string") retain(item.output, calls.get(item.call_id));
      if (item.role === "tool" && typeof item.tool_call_id === "string" && typeof item.content === "string") retain(item.content, calls.get(item.tool_call_id));
      // NullClaw has no call id in its adapter envelope. Require explicit injected
      // context, or a unique declaration of the same tool in this request.
      if (item.role === "user" && typeof item.content === "string" && item.content.startsWith("[Tool results]\n")) {
        for (const match of item.content.matchAll(/<tool_result name="([^"]+)" status="error">\n([^]*?)\n<\/tool_result>/g)) {
          const name = expected?.name ?? (calls.size === 1 ? [...calls.values()][0] : undefined);
          if (match[1] === name) retain(match[2]!, name);
        }
      }
    }
  }
  return outputs;
}

export function validateIsolation(value: unknown) {
  if (!isRecord(value) || !isRecord(value.HostConfig) || !isRecord(value.Config)) throw new Error("Missing Docker inspection");
  const host = value.HostConfig;
  if (host.NetworkMode !== "none" || host.ReadonlyRootfs !== true || host.Privileged !== false) throw new Error("Unsafe network/root/privileged configuration");
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.includes("ALL") || (Array.isArray(host.CapAdd) && host.CapAdd.length)) throw new Error("Unsafe capabilities");
  if (!Array.isArray(host.SecurityOpt) || !host.SecurityOpt.some(item => typeof item === "string" && /^no-new-privileges(?::true)?$/.test(item))) throw new Error("Missing no-new-privileges");
  if ((Array.isArray(host.Binds) && host.Binds.length) || (isRecord(host.PortBindings) && Object.keys(host.PortBindings).length) || (Array.isArray(value.Mounts) && value.Mounts.some(mount => isRecord(mount) && mount.Type !== "tmpfs"))) throw new Error("Unexpected mount or published port");
  if (typeof host.PidsLimit !== "number" || host.PidsLimit < 1 || host.PidsLimit > 128 || typeof host.Memory !== "number" || host.Memory < 1 || host.Memory > 536870912) throw new Error("Missing resource bounds");
  if (!isRecord(host.Tmpfs) || !Object.keys(host.Tmpfs).every(path => path === "/tmp" || path === "/run") || !host.Tmpfs["/tmp"] || !host.Tmpfs["/run"]) throw new Error("Unexpected scratch mounts");
  return true;
}
