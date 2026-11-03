import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeDenialEvidence } from "./native-probe-evidence";

const request = (input: unknown[]) => [{ body: { input } }];

for (const [adapter, outcome] of [
  ["Responses", (output: string) => ({ type: "function_call_output", call_id: "call_attack", output })],
  ["tool role", (content: string) => ({ role: "tool", tool_call_id: "call_attack", content })],
  ["NullClaw", (output: string) => ({ role: "user", content: `[Tool results]\n<tool_result name="shell" status="error">\n${output}\n</tool_result>` })],
] as const) {
  test.each([
    "File not found: /workspace/missing.txt",
    "Executable not found: nonexistent-command",
    "Resource not available: connection pool exhausted",
    "Command executed; filesystem returned Permission denied",
  ])(`SEC-2 ${adapter}: execution errors are not policy refusals: %s`, output => {
    expect(nativeDenialEvidence(request([
      { type: "function_call", call_id: "call_attack", name: "shell", arguments: "{}" },
      outcome(output),
    ]))).toEqual([]);
  });
}

test("SEC-2 an orphan function result cannot attest denial of the injected shell call", () => {
  expect(nativeDenialEvidence(request([
    { type: "function_call", call_id: "call_attack", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_other", output: "Tool disabled: file_read" },
    { type: "function_call_output", call_id: "call_attack", output: "Command completed successfully" },
  ]))).toEqual([]);
});

test("SEC-2 explicit registry refusal for the injected call remains usable evidence", () => {
  expect(nativeDenialEvidence(request([
    { type: "function_call", call_id: "call_attack", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_attack", output: "Tool not found: shell" },
  ]))).toEqual(["Tool not found: shell"]);
});

const image = `sha256:${"a".repeat(64)}`;
const secret = "synthetic-image-metadata-credential-do-not-export";
type Scenario = "normal" | "create-error" | "create-signal" | "image-volume";

// A disposable Docker-boundary fake persists resource effects across CLI calls.
// No Docker daemon, container, native executable, or network is used by these tests.
const fakeDocker = `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const path = process.env.NATIVE_TEST_STATE;
const scenario = process.env.NATIVE_TEST_SCENARIO;
const image = ${JSON.stringify(image)};
const secret = ${JSON.stringify(secret)};
const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { container: false, volume: false, started: false };
const save = () => writeFileSync(path, JSON.stringify(state));
const output = value => console.log(JSON.stringify(value));
if (args[0] === "image" && args[1] === "inspect") {
  output([{ Id: image, Architecture: "arm64", Os: "linux", Config: scenario === "image-volume" ? { Volumes: { "/state": {} } } : {} }]);
} else if (args[0] === "create") {
  state.container = true;
  state.volume = scenario === "image-volume";
  save();
  writeFileSync(path + ".owner", args[args.indexOf("--label") + 1].split("=")[1]);
  if (scenario === "create-error") { console.error("daemon created container but connection was lost"); process.exit(1); }
  if (scenario === "create-signal") process.kill(process.pid, "SIGTERM");
  console.log("owned-container-id");
} else if (args[0] === "inspect") {
  if (!state.container) { console.error("Error: No such object: " + args.at(-1)); process.exit(1); }
  output([{
    Id: "owned-container-id", Image: image,
    Config: { Env: ["IMAGE_CREDENTIAL=" + secret], Labels: { credential: secret, "org.jeo.native-probe.owner": readFileSync(path + ".owner", "utf8") }, Healthcheck: { Test: ["CMD", "healthcheck", secret] } },
    Mounts: state.volume ? [{ Type: "volume", Name: "owned-anonymous-volume", Destination: "/state" }] : [],
    HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"], Binds: null, PortBindings: {}, PidsLimit: 128, Memory: 536870912, Tmpfs: { "/tmp": "rw,nosuid,nodev,mode=1777", "/run": "rw,nosuid,nodev,mode=0755" } }
  }]);
} else if (args[0] === "start") {
  state.started = true;
  save();
  output({ runtime: "zeroclaw", qualification: "unqualified", productionEquivalence: "UNESTABLISHED: synthetic fixture is not production proof", binarySha256: "b".repeat(64), fixtureSha256: "c".repeat(64), evidenceHelperSha256: "d".repeat(64), cases: [{ name: "synthetic-self-report", passed: true }] });
} else if (args[0] === "rm") {
  state.container = false;
  if (args.includes("--volumes") || args.includes("-v")) state.volume = false;
  save();
  console.log("owned-container-id");
} else {
  console.error("Unexpected Docker operation: " + args.join(" "));
  process.exit(90);
}
`;

async function runVerifier(scenario: Scenario) {
  const directory = await mkdtemp(join(tmpdir(), "native-security-test-"));
  try {
    const statePath = join(directory, "state.json");
    await writeFile(join(directory, "docker"), fakeDocker, { mode: 0o700 });
    const evidence = join(directory, "evidence");
    const child = Bun.spawn({
      cmd: [process.execPath, "run", resolve("scripts/verify-native-probe.ts"), "--runtime", "zeroclaw", "--image-id", image, "--transport", "codex-loopback-http", "--evidence-dir", evidence],
      cwd: tmpdir(),
      env: { PATH: directory, NATIVE_TEST_STATE: statePath, NATIVE_TEST_SCENARIO: scenario },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const summary = JSON.parse(stdout);
    const reports = await readdir(evidence);
    expect(reports).toEqual([summary.reportPath.split("/").at(-1)]);
    const text = await readFile(summary.reportPath, "utf8");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return { exitCode, stderr, text, report: JSON.parse(text), state };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("verifier CLI keeps offline reports unqualified and removes an owned completed container", async () => {
  const result = await runVerifier("normal");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.report.qualification).toBe("unqualified");
  expect(result.report.cleanup).toBe(true);
  expect(result.state).toEqual({ container: false, volume: false, started: true });
});

test.each(["create-error", "create-signal"] as const)("SEC-3 %s after allocation cannot leave a container while reporting successful cleanup", async scenario => {
  const result = await runVerifier(scenario);
  expect(result.exitCode).toBe(1);
  expect({ containerRemaining: result.state.container, started: result.state.started, cleanup: result.report.cleanup }).toEqual({ containerRemaining: false, started: false, cleanup: true });
});

test("SEC-4 exported evidence excludes credentials in inherited labels and healthcheck commands", async () => {
  const result = await runVerifier("normal");
  expect(result.text).not.toContain(secret);
});

test("SEC-6 a rejected image volume neither starts the fixture nor leaks its anonymous volume", async () => {
  const result = await runVerifier("image-volume");
  expect(result.exitCode).toBe(1);
  expect(result.state.started).toBe(false);
  expect(result.state.container).toBe(false);
  expect(result.state.volume).toBe(false);
  expect(result.report.cleanup).toBe(true);
});

