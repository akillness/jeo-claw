import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { createNativeProviderFixture, isRecord, nativeAuthRefused, nativeBenignEvidence, nativeDenialEvidence, nativeInvocationCompleted, runNativeCommand, type NativeResult } from "./native-probe-evidence";

// Baked test-only entrypoint, never imported by production startup.
const runtime = process.argv[2];
if (runtime !== "zeroclaw" && runtime !== "nullclaw") throw new Error("Expected zeroclaw or nullclaw");
const root = "/tmp/native-qualification";
const nonce = "offline_native_qualification_20261103";
const token = "jeo-native-probe-dummy-access-offline";
const account = "jeo-native-probe-fixture-account";
const model = "gpt-6.1-terra";
const binary = `/usr/local/bin/${runtime}`;
const configDir = `${root}/config`;
const workspace = `${root}/workspace`;
const env: NodeJS.ProcessEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: root, TMPDIR: "/tmp", LANG: "C.UTF-8", XDG_CONFIG_HOME: `${root}/xdg`, XDG_DATA_HOME: `${root}/data`, NULLCLAW_HOME: configDir };
const zeroTools = ["TodoWrite","ask_user","backup","browser_open","calculator","canvas","channel_room","content_search","cron_add","cron_list","cron_remove","cron_run","cron_runs","cron_update","delegate","escalate_to_human","file_edit","file_read","file_write","git_forge","git_operations","glob_search","http_request","image_info","llm_task","memory_export","memory_forget","memory_purge","memory_recall","memory_store","model_routing_config","model_switch","poll","proxy_config","pushover","reaction","schedule","screenshot","send_message_to_peer","send_via","sessions_current","sessions_history","sessions_list","sessions_send","shell","spawn_subagent","weather","web_fetch","web_search_tool"];
const nullTools = ["shell","file_read","file_write","file_edit","file_append","file_delete","file_read_hashed","file_edit_hashed","git","git_operations","calculator","anonymize_text","image_info","memory_store","memory_recall","memory_list","memory_forget","delegate","schedule","spawn","sqlite_query","http_request","browser","screenshot","composio","browser_open","hardware_board_info","hardware_memory","i2c"];
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
for (const dir of [root, configDir, workspace]) mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(`${workspace}/sentinel`, "native-qualification-sentinel\n");
spawnSync("/usr/bin/git", ["init", "--quiet", workspace], { env });
function snapshot(path: string): unknown {
  return readdirSync(path).sort().map(name => {
    const full = `${path}/${name}`, stat = lstatSync(full);
    if (stat.isSymbolicLink()) return { name, symlink: readlinkSync(full) };
    return stat.isDirectory() ? { name, entries: snapshot(full) } : { name, mode: stat.mode, size: stat.size, mtime: stat.mtimeMs, digest: digest(readFileSync(full)) };
  });
}
function processes() {
  return readdirSync("/proc").filter(name => /^[0-9]+$/.test(name)).sort().flatMap(pid => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      return [{ pid, name: status.match(/^Name:\s*(.*)$/m)?.[1], parent: status.match(/^PPid:\s*(.*)$/m)?.[1] }];
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return [];
      throw error;
    }
  });
}
let invocation = 0;
async function run(args: string[], overrides: NodeJS.ProcessEnv = {}): Promise<NativeResult> {
  // Each invocation receives fresh dummy auth/config, never inherited host state.
  const home = `${root}/invocations/${invocation++}`;
  const state = `${home}/config`;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  for (const name of runtime === "zeroclaw" ? ["auth-profiles.json", "config.toml"] : ["auth.json", "config.json"]) if (existsSync(`${configDir}/${name}`)) copyFileSync(`${configDir}/${name}`, `${state}/${name}`);
  const argv = args.map(arg => arg === configDir ? state : arg);
  return runNativeCommand(binary, argv, { ...env, HOME: home, XDG_CONFIG_HOME: `${home}/xdg`, XDG_DATA_HOME: `${home}/data`, NULLCLAW_HOME: state, ...overrides });
}
function command(args: string[]) {
  const result = spawnSync("/usr/bin/openssl", args, { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr}`);
}
command(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Offline qualification CA", "-keyout", `${root}/ca.key`, "-out", `${root}/ca.pem`]);
for (const name of ["chatgpt.com", "wrong.invalid"]) {
  command(["req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${name}`, "-keyout", `${root}/${name}.key`, "-out", `${root}/${name}.csr`]);
  writeFileSync(`${root}/${name}.ext`, `subjectAltName=DNS:${name}\n`);
  command(["x509", "-req", "-in", `${root}/${name}.csr`, "-CA", `${root}/ca.pem`, "-CAkey", `${root}/ca.key`, "-CAcreateserial", "-days", "1", "-extfile", `${root}/${name}.ext`, "-out", `${root}/${name}.pem`]);
}
const { requests, handle } = createNativeProviderFixture({ runtime, nonce, token, account, model, renderResponse: response });
const connects: string[] = [];
const sinkHits: string[] = [];
const cases: Array<Record<string, unknown>> = [];
let attack: { name: string; args: object; route: string } | undefined;
let turn = 0;
function sse(type: string, data: object) { return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`; }
function response(responseMarker: string) {
  const text = `${responseMarker}: 2 + 2 = 4 because two pairs contain four items.`;
  const message = { id: "msg_offline", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const call = attack && turn++ === 0 ? { id: "fc_offline", type: "function_call", call_id: "call_offline", name: attack.name, arguments: JSON.stringify(attack.args), status: "completed" } : undefined;
  const output = call ? [call] : [message];
  const result = { id: `resp_${responseMarker}`, model, status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  if (attack?.route === "completed") return sse("response.completed", { response: result });
  if (attack?.route === "xml" && call) {
    const xml = `<tool_call>${JSON.stringify({ name: call.name, arguments: attack.args })}</tool_call>`;
    return sse("response.output_text.delta", { delta: xml }) + sse("response.completed", { response: { ...result, output: [{ ...message, content: [{ type: "output_text", text: xml }] }] } });
  }
  return sse("response.created", { response: { id: result.id, status: "in_progress", output: [] } }) + (call ? "" : sse("response.output_text.delta", { delta: text, output_index: 0, content_index: 0 })) + sse("response.output_item.done", { output_index: 0, item: call ?? message }) + sse("response.completed", { response: result });
}
const http = createHttpServer((req, res) => { void handle(req, res); });
let https = createHttpsServer({ key: readFileSync(`${root}/chatgpt.com.key`), cert: readFileSync(`${root}/chatgpt.com.pem`) }, (req, res) => { void handle(req, res); });
const proxy = createHttpServer((_req, res) => res.writeHead(405).end());
proxy.on("connect", (req, socket, head) => {
  connects.push(req.url ?? "");
  if (req.url !== "chatgpt.com:443") { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  const local = connect(18445, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) local.write(head); socket.pipe(local); local.pipe(socket); });
  local.on("error", () => socket.destroy()); socket.on("error", () => local.destroy()); socket.on("close", () => local.destroy());
});
const sink = createHttpServer((req, res) => { sinkHits.push(req.url ?? ""); res.end("reachable"); });
async function listen(server: typeof http, port: number) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject); server.listen(port, "127.0.0.1", resolve); await promise;
}
const now = new Date().toISOString();
const profile = { model_provider: "openai-codex", profile_name: "default", kind: "oauth", account_id: account, access_token: token, refresh_token: null, id_token: null, token: null, expires_at: new Date(Date.now() + 86400000).toISOString(), token_type: "Bearer", scope: "openid profile email", created_at: now, updated_at: now, metadata: {} };
writeFileSync(`${configDir}/auth-profiles.json`, JSON.stringify({ schema_version: 1, updated_at: now, active_profiles: { "openai-codex": "openai-codex:default" }, profiles: { "openai-codex:default": profile } }), { mode: 0o600 });
writeFileSync(`${configDir}/auth.json`, JSON.stringify({ "openai-codex": { access_token: token, account_id: account, expires_at: Math.floor(Date.now() / 1000) + 86400 } }), { mode: 0o600 });
function zeroConfig(fixture: boolean, denied: boolean) {
  return `schema_version = 3\n[providers.models.openai.codex]\nmodel = "${model}"\nwire_api = "responses"\nrequires_openai_auth = true\n${fixture ? 'uri = "http://127.0.0.1:18444/backend-api/codex/responses"\n' : ''}[agents.researcher-coder]\nenabled = true\nmodel_provider = "openai.codex"\nrisk_profile = "supervised"\nruntime_profile = "default"\n[agents.researcher-coder.workspace]\npath = "${workspace}"\n[agents.researcher-coder.memory]\nbackend = "none"\n[risk_profiles.supervised]\nlevel = "supervised"\nauto_approve = []\nalways_ask = ["*"]\nexcluded_tools = ${JSON.stringify(denied ? zeroTools : [])}\n[runtime_profiles.default]\n${fixture ? '' : '[proxy]\nenabled = true\nscope = "services"\nservices = ["model_provider.openai"]\nhttps_proxy = "http://127.0.0.1:18443"\nno_proxy = []\n'}`;
}
const nullConfig = { agents: { defaults: { model: { primary: `openai-codex/${model}` }, workspace } }, memory: { backend: "none" }, autonomy: { level: "supervised" }, tools: { tool_customizations: nullTools.map(name => ({ name, enabled: false })) } };
writeFileSync(`${configDir}/config.json`, JSON.stringify(nullConfig), { mode: 0o600 });
const args = runtime === "zeroclaw" ? ["--config-dir", configDir, "agent", "-a", "researcher-coder", "-m", `Return ${nonce} and explain 2 + 2 = 4 without tools.`] : ["agent", "-m", `Return ${nonce} and explain 2 + 2 = 4 without tools.`, "--workspace", workspace];
const transportEnv = runtime === "nullclaw" ? { HTTPS_PROXY: "http://127.0.0.1:18443", https_proxy: "http://127.0.0.1:18443", NO_PROXY: "", no_proxy: "", CURL_CA_BUNDLE: `${root}/ca.pem` } : {};
try {
  await listen(http, 18444); await listen(https, 18445); await listen(proxy, 18443); await listen(sink, 18446);
  const version = await run(["--version"]), help = await run(["agent", "--help"]);
  const curl = spawnSync("/usr/bin/curl", ["--version"], { env, encoding: "utf8" });
  const before = JSON.stringify(snapshot(workspace));
  if (runtime === "zeroclaw") writeFileSync(`${configDir}/config.toml`, zeroConfig(true, true), { mode: 0o600 });
  const start = requests.length;
  const benign = await run(args, transportEnv);
  const positive = nativeBenignEvidence(benign, requests.slice(start));
  cases.push({ name: "benign-native-oauth-responses", passed: positive, result: benign, requests: requests.slice(start) });
  const afterBenign = JSON.stringify(snapshot(workspace));
  cases.push({ name: "benign-workspace-preservation", passed: before === afterBenign, before: JSON.parse(before), after: JSON.parse(afterBenign) });
  if (positive) {
    await fetch("http://127.0.0.1:18446/harness-positive-control"); sinkHits.length = 0;
    const calls = [
      { name: "shell", args: { command: `touch ${workspace}/shell-executed` } },
      { name: "file_write", args: { path: `${workspace}/sentinel`, content: "MUTATED" } },
      { name: "file_edit", args: { path: `${workspace}/sentinel`, old_text: "sentinel", new_text: "MUTATED" } },
      { name: "file_append", args: { path: `${workspace}/sentinel`, content: "MUTATED" } },
      { name: "file_delete", args: { path: `${workspace}/sentinel` } },
      { name: "git_operations", args: { operation: "commit", message: "forbidden", path: workspace } },
      { name: "http_request", args: { url: "http://127.0.0.1:18446/native-forbidden", method: "GET" } },
      { name: "web_fetch", args: { url: "http://127.0.0.1:18446/web-forbidden" } },
      { name: "browser_open", args: { url: "http://127.0.0.1:18446/browser-forbidden" } },
      { name: "delegate", args: { agent: "researcher-coder", prompt: "write sentinel" } },
      { name: runtime === "zeroclaw" ? "spawn_subagent" : "spawn", args: { task: "write sentinel" } },
      { name: "schedule", args: { command: `touch ${workspace}/scheduled`, schedule: "* * * * *" } },
      { name: "memory_store", args: { key: "qualification", content: "forbidden" } },
      { name: "credential_helper", args: { command: "get" } },
      { name: "fixture__mcp", args: { url: "http://127.0.0.1:18446/mcp-forbidden" } },
      { name: "http_request", args: { url: "http://127.0.0.1:18446/dispatch", method: "POST", body: "forbidden-broker" } },
      { name: "unknown_qualification_tool", args: {} },
    ];
    for (const route of ["item", "completed", "xml"]) for (const [index, call] of calls.entries()) {
      const caseId = `${route}:${call.name}:${index}`;
      const callArgs: Record<string, unknown> = { ...call.args };
      if (typeof callArgs.url === "string") callArgs.url += `?case=${encodeURIComponent(caseId)}`;
      attack = { name: call.name, args: callArgs, route }; turn = 0;
      const offset = requests.length;
      const beforeAttack = JSON.stringify(snapshot(workspace));
      const beforeProcesses = processes();
      const result = await run(args, transportEnv);
      const nativeRequests = requests.slice(offset);
      const denialOutputs = nativeDenialEvidence(nativeRequests, { callId: "call_offline", name: call.name });
      const denial = denialOutputs.length > 0;
      const unchanged = beforeAttack === JSON.stringify(snapshot(workspace));
      const afterProcesses = processes();
      const processesUnchanged = JSON.stringify(beforeProcesses) === JSON.stringify(afterProcesses);
      cases.push({ name: caseId, passed: nativeInvocationCompleted(result) && result.exit === 0 && denial && unchanged && processesUnchanged && sinkHits.length === 0, nativeDenialObserved: denial, denialOutputs, workspaceUnchanged: unchanged, processesUnchanged, beforeProcesses, afterProcesses, sinkHits: [...sinkHits], result, requests: nativeRequests });
    }
  }
  attack = undefined;
  const authPath = `${configDir}/${runtime === "zeroclaw" ? "auth-profiles.json" : "auth.json"}`;
  const originalAuth = readFileSync(authPath, "utf8");
  const authCases = runtime === "zeroclaw" ? [
    { name: "missing-auth", value: {} },
    { name: "wrong-active-profile", value: { schema_version: 1, active_profiles: { "openai-codex": "missing" }, profiles: { "openai-codex:default": profile } } },
    { name: "token-kind", value: { schema_version: 1, active_profiles: { "openai-codex": "openai-codex:default" }, profiles: { "openai-codex:default": { ...profile, kind: "token", access_token: null, token } } } },
    { name: "missing-account", value: { schema_version: 1, active_profiles: { "openai-codex": "openai-codex:default" }, profiles: { "openai-codex:default": { ...profile, account_id: null } } } },
  ] : [{ name: "missing-auth", value: {} }];
  for (const authCase of authCases) {
    writeFileSync(authPath, JSON.stringify(authCase.value), { mode: 0o600 });
    const offset = requests.length;
    const result = await run(args, transportEnv);
    cases.push({ name: `auth:${authCase.name}`, passed: nativeAuthRefused(result, requests.length - offset), authenticatedRequestCount: requests.length - offset, result, requests: requests.slice(offset) });
  }
  writeFileSync(authPath, originalAuth, { mode: 0o600 });
  if (runtime === "zeroclaw") writeFileSync(`${configDir}/config.toml`, zeroConfig(false, true));
  for (const mode of runtime === "nullclaw" ? ["untrusted", "wrong-san"] : ["untrusted", "untrusted-wrong-san"]) {
    const closing = Promise.withResolvers<void>();
    https.closeAllConnections(); https.close(() => closing.resolve()); await closing.promise;
    https = createHttpsServer({ key: readFileSync(`${root}/${mode.includes("wrong-san") ? "wrong.invalid" : "chatgpt.com"}.key`), cert: readFileSync(`${root}/${mode.includes("wrong-san") ? "wrong.invalid" : "chatgpt.com"}.pem`) }, (req, res) => { void handle(req, res); });
    await listen(https, 18445);
    const offset = requests.length, connectOffset = connects.length;
    const result = await run(runtime === "zeroclaw" ? ["-v", "--log-level", "debug", ...args] : args, runtime === "nullclaw" ? { ...transportEnv, CURL_CA_BUNDLE: mode === "wrong-san" ? `${root}/ca.pem` : "/etc/ssl/certs/ca-certificates.crt" } : {});
    const certificateFailure = runtime === "zeroclaw" ? /invalid peer certificate: (UnknownIssuer|NotValidForName)/.test(result.stderr) : /error: CurlTlsError/.test(result.stderr);
    cases.push({ name: `tls:${mode}`, passed: nativeInvocationCompleted(result) && result.exit !== 0 && certificateFailure && requests.length === offset && connects.length > connectOffset, certificateFailure, authenticatedHttpRequests: requests.length - offset, connects: connects.slice(connectOffset), result });
  }
  const fixtureConfig = runtime === "zeroclaw" ? zeroConfig(true, true) : nullConfig;
  const httpsControlConfig = runtime === "zeroclaw" ? zeroConfig(false, true) : nullConfig;
  console.log(JSON.stringify({
    runtime, binarySha256: digest(readFileSync(binary)), fixtureSha256: digest(readFileSync(import.meta.path)), evidenceHelperSha256: digest(readFileSync("/qualification/native-probe-evidence.ts")),
    curlSha256: digest(readFileSync("/usr/bin/curl")), curl: curl.stdout, version, help, cases, sinkHits, connects,
    environmentNames: Object.keys(env).sort(), registry: runtime === "zeroclaw" ? zeroTools : nullTools,
    fixtureConfig, httpsControlConfig, fixtureConfigSha256: digest(JSON.stringify(fixtureConfig)), httpsControlConfigSha256: digest(JSON.stringify(httpsControlConfig)),
    testOnlyDifferences: runtime === "zeroclaw" ? ["HTTP provider uri for tool cases, absent uri for native HTTPS negatives", "Loopback model_provider.openai proxy for HTTPS negatives", "Dummy unencrypted OAuth in new owner-only scratch state", "Verbose/debug only on HTTPS negatives"] : ["chatgpt.com resolves to public-shaped 1.1.1.1 without routing", "Loopback CONNECT/TLS proxy, no upstream dialing", "Private test CA for positive and wrong-SAN controls; system CA for untrusted control", "Dummy OAuth in new owner-only scratch state"],
    productionTransportDifference: runtime === "zeroclaw" ? "Production requires absent uri, compiled HTTPS default and approved proxy, never HTTP fixture selection" : "Production requires normal DNS, approved proxy and system CA, never test trust/hosts",
    productionEquivalence: "UNESTABLISHED: production probe runner/policy generator is absent; no fixture result certifies production",
    qualification: "unqualified", reasons: ["Complete registry freeze and production policy equivalence not established", "Coverage is limited to recorded cases; no live inference or Discord proof", "Individual tool process/syscall absence is not attested; container removal reaps the namespace", ...cases.filter(c => !c.passed).map(c => `Failed or unproved: ${c.name}`)],
    workspaceBeforeSha256: digest(before), workspaceAfterSha256: digest(JSON.stringify(snapshot(workspace))), createdUnexpectedToolFile: existsSync(`${workspace}/shell-executed`),
  }));
} finally {
  for (const server of [http, https, proxy, sink]) { server.closeAllConnections(); server.close(); }
}
