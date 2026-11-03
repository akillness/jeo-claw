import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isRecord, validateIsolation } from "./native-probe-evidence";

// Builds, pulls, secrets, Compose, and production startup are intentionally absent.
const options = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!key || !["--runtime", "--image-id", "--transport", "--evidence-dir", "--approval-manifest"].includes(key) || !value || options.has(key)) throw new Error("Expected unique native probe option/value pairs");
  options.set(key, value);
}
const runtime = options.get("--runtime");
const image = options.get("--image-id");
const evidenceDir = options.get("--evidence-dir");
const transport = options.get("--transport");
if (runtime !== "zeroclaw" && runtime !== "nullclaw") throw new Error("Invalid runtime");
if (!image || !/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error("An immutable local image ID is required");
if (transport !== (runtime === "zeroclaw" ? "codex-loopback-http" : "codex-connect-tls")) throw new Error("Transport does not match runtime");
if (!evidenceDir || !isAbsolute(evidenceDir)) throw new Error("Private absolute evidence directory required");
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const stat = lstatSync(evidenceDir);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Evidence directory must be a private non-symlink directory");
const commands: Array<{ argv: string[]; exit: number | null; signal: string | null; stdout: string; stderr: string; error?: string }> = [];
function docker(args: string[], timeout = 30000) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 32 * 1048576, stdio: ["ignore", "pipe", "pipe"] });
  const record = { argv: ["docker", ...args], exit: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error.message } : {}) };
  commands.push(record);
  return record;
}
function checked(args: string[]) {
  const result = docker(args);
  if (result.exit !== 0 || result.signal !== null || result.error) throw new Error(`Docker command failed: ${args[0]} (exit ${result.exit})`);
  return result.stdout;
}
const name = `jeo-offline-native-${runtime}-${randomUUID()}`;
const ownerLabel = "org.jeo.native-probe.owner";
const reportPath = join(evidenceDir, `${name}.json`);
const absent = (result: { exit: number | null; signal: string | null; stdout: string; stderr: string; error?: string }, target = name) => result.exit === 1 && result.signal === null && !result.error && (result.stdout === "" || result.stdout.replace(/\r?\n$/, "") === "[]") && result.stderr.replace(/^error: no such object: /i, "Error: No such object: ").replace(/\r?\n$/, "") === `Error: No such object: ${target}`;
let createAttempted = false;
let nameWasAbsent = false;
let containerId: string | undefined;
let failure: string | undefined;
let fixture: unknown;
let inspection: unknown;
let identity: unknown;
let identityVerified = false;
let approval: Record<string, unknown> | undefined;
let approvalManifestSha256: string | undefined;
try {
  const manifestPath = options.get("--approval-manifest");
  if (manifestPath) {
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16384) throw new Error("Invalid approval manifest file");
    const source = readFileSync(manifestPath);
    const parsed: unknown = JSON.parse(source.toString("utf8"));
    if (!isRecord(parsed) || parsed.image !== image || parsed.runtime !== runtime || typeof parsed.provenance !== "string" || !parsed.provenance.trim() || ![parsed.binarySha256, parsed.fixtureSha256, parsed.evidenceHelperSha256].every(value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))) throw new Error("Approval manifest must bind image, runtime, artifact hashes and build provenance");
    approval = parsed;
    approvalManifestSha256 = createHash("sha256").update(source).digest("hex");
  }
  const imageData: unknown = JSON.parse(checked(["image", "inspect", image]));
  if (!Array.isArray(imageData) || !isRecord(imageData[0]) || imageData[0].Id !== image) throw new Error("Local image identity mismatch");
  identity = { image, architecture: ["amd64", "arm64"].includes(String(imageData[0].Architecture)) ? imageData[0].Architecture : "unknown", os: imageData[0].Os === "linux" ? "linux" : "unknown" };
  nameWasAbsent = absent(docker(["inspect", name]));
  if (!nameWasAbsent) throw new Error("Owned container name absence not established before create");
  createAttempted = true;
  const createdId = checked(["create", "--pull", "never", "--name", name, "--label", `${ownerLabel}=${name}`, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "128", "--memory", "512m", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--tmpfs", "/run:rw,nosuid,nodev,mode=0755", ...(runtime === "nullclaw" ? ["--add-host", "chatgpt.com:1.1.1.1"] : []), "--entrypoint", "/usr/local/bin/bun", image, "run", "/qualification/native-probe-fixture.ts", runtime]).trim();
  if (!createdId || /\s/.test(createdId)) throw new Error("Invalid created container identity");
  containerId = createdId;
  const inspected: unknown = JSON.parse(checked(["inspect", name]));
  if (!Array.isArray(inspected) || !isRecord(inspected[0]) || inspected[0].Id !== containerId) throw new Error("Invalid Docker inspection identity");
  inspection = inspected[0];
  validateIsolation(inspection);
  if (!isRecord(inspection) || inspection.Image !== image) throw new Error("Container image mismatch");
  const result = docker(["start", "--attach", containerId], 1800000);
  if (result.exit !== 0 || result.signal !== null || result.error) throw new Error(`Native fixture failed (exit ${result.exit})`);
  const observed: unknown = JSON.parse(result.stdout);
  if (!isRecord(observed) || observed.runtime !== runtime || observed.qualification !== "unqualified" || !Array.isArray(observed.cases)) throw new Error("Unexpected fixture report");
  identityVerified = !!approval && ["binarySha256", "fixtureSha256", "evidenceHelperSha256"].every(key => observed[key] === approval![key]);
  // Hashes originating in the container are not their own approval. No case
  // evidence is accepted without the operator's independent provenance binding.
  fixture = { runtime, qualification: "unqualified", identityVerified, caseEvidenceAccepted: identityVerified, cases: identityVerified ? observed.cases.filter(isRecord).map(item => ({ passed: item.passed === true })) : [] };
  if (!identityVerified) throw new Error(approval ? "Approved artifact identity mismatch; case evidence rejected" : "Independent approved artifact identities and build provenance absent; case evidence rejected");
  // No fixture result, even with approved identity, certifies production.
  failure = "Production equivalence is unestablished; offline fixture is not a native isolation certificate";
} catch (error) {
  // Never include untrusted daemon output, JSON parse excerpts or filesystem paths.
  const message = error instanceof Error ? error.message : "";
  failure = /^(?:Docker command failed:|Native fixture failed \(exit|Invalid |Unsafe |Missing |Unexpected |Owned container |Container image |Local image |Approval manifest |Approved artifact |Independent approved |Evidence directory )/.test(message) ? message : "Probe failed; untrusted diagnostic output withheld";
} finally {
  let cleanup = !createAttempted;
  if (createAttempted) {
    cleanup = false;
    try {
      const target = containerId ?? name;
      const current = docker(["inspect", target]);
      if (absent(current, target)) cleanup = true;
      else if (current.exit === 0 && current.signal === null && !current.error) {
        const values: unknown = JSON.parse(current.stdout);
        const owned = Array.isArray(values) && values.length === 1 ? values[0] : undefined;
        const labels = isRecord(owned) && isRecord(owned.Config) && isRecord(owned.Config.Labels) ? owned.Config.Labels : undefined;
        // A successful create records its ID. After a lost create response, the
        // unique nonce label recovers ownership; name/image similarity alone is
        // insufficient. Never delete a resource with a conflicting owner label.
        if (isRecord(owned) && typeof owned.Id === "string" && owned.Id && owned.Image === image && (containerId ? owned.Id === containerId : nameWasAbsent && labels?.[ownerLabel] === name) && (!labels?.[ownerLabel] || labels[ownerLabel] === name)) {
          containerId = owned.Id;
          const removed = docker(["rm", "--force", "--volumes", containerId]);
          cleanup = removed.exit === 0 && removed.signal === null && !removed.error && absent(docker(["inspect", containerId]), containerId);
        }
      }
    } catch { cleanup = false; }
    if (!cleanup) failure = `${failure ?? "Probe failed"}; owned container cleanup not established`;
  }
  // Allowlisted booleans/numeric bounds only: inherited labels, healthchecks,
  // environment values, mount sources, native output and daemon text never leave.
  const safeInspection = isRecord(inspection) && isRecord(inspection.HostConfig) ? {
    imageMatches: inspection.Image === image,
    networkNone: inspection.HostConfig.NetworkMode === "none",
    readOnlyRoot: inspection.HostConfig.ReadonlyRootfs === true,
    unprivileged: inspection.HostConfig.Privileged === false,
    isolationValidated: (() => { try { return validateIsolation(inspection); } catch { return false; } })(),
  } : undefined;
  const safeCommands = commands.map(record => ({ argv: record.argv, exit: record.exit, signal: record.signal, executionError: !!record.error }));
  writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, evidenceTier: "offline fixture only, independently approved identity required for case evidence", qualification: "unqualified", failure, identity, identityVerified, approvalManifestSha256, inspection: safeInspection, fixture, cleanup, commands: safeCommands }, null, 2), { flag: "wx", mode: 0o600 });
  chmodSync(reportPath, 0o600);
}
console.log(JSON.stringify({ qualification: "unqualified", reportPath, failure }));
process.exitCode = 1;
