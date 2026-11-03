import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const image = `sha256:${"a".repeat(64)}`;
const hashes = { binarySha256: "b".repeat(64), fixtureSha256: "c".repeat(64), evidenceHelperSha256: "d".repeat(64) };
const privateMetadata = "synthetic-metadata-never-share";
const fakeDocker = `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), path = process.env.STATE, scenario = process.env.SCENARIO;
const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { container: false, started: false, removed: false };
const save = () => writeFileSync(path, JSON.stringify(state));
const output = value => console.log(JSON.stringify(value));
const image = ${JSON.stringify(image)}, secret = ${JSON.stringify(privateMetadata)};
const missingResponse = process.env.MISSING_RESPONSE ? JSON.parse(process.env.MISSING_RESPONSE) : undefined;
if (args[0] === 'image') { save(); output([{ Id: image, Architecture: 'arm64', Os: 'linux' }]); }
else if (args[0] === 'create') { state.container = true; state.label = scenario === 'lost-owner' ? undefined : args[args.indexOf('--label') + 1].split('=')[1]; save(); if (scenario === 'lost-owner') process.exit(1); console.log('owned-id'); }
else if (args[0] === 'inspect') {
  if (!state.container && missingResponse?.stage === (state.removed ? 'after-removal' : 'before-create')) {
    const target = args.at(-1);
    process.stdout.write(missingResponse.stdout.replaceAll('<target>', target));
    process.stderr.write(missingResponse.stderr.replaceAll('<target>', target));
    process.exit(missingResponse.exit);
  }
  if (state.replacementInstalled && !(scenario === 'replace-before-start' && args.at(-1) === 'owned-id' && state.ownedRemaining)) {
    const remaining = args.at(-1) === 'owned-id' ? state.ownedRemaining : state.replacementRemaining;
    if (!remaining) { console.error('Error: No such object: ' + args.at(-1)); process.exit(1); }
    output([{ Id: args.at(-1) === 'owned-id' ? 'owned-id' : 'replacement-id' }]);
    process.exit(0);
  }
  if (!state.container) { console.error('Error: No such object: ' + args.at(-1)); process.exit(1); }
  if (scenario === 'inspect-error' && state.started) { console.error('daemon unavailable ' + secret); process.exit(1); }
  output([{ Id: scenario === 'id-changed' && state.started ? 'foreign-id' : 'owned-id', Image: image,
    Config: { Labels: { 'org.jeo.native-probe.owner': scenario === 'owner-changed' && state.started ? 'foreign' : state.label, secret }, Healthcheck: { Test: ['CMD', secret] }, Env: ['SECRET=' + secret] }, Mounts: [],
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Binds: null, PortBindings: {}, PidsLimit: 128, Memory: 536870912, Tmpfs: { '/tmp': 'rw', '/run': 'rw' } }
  }]);
  // The inspected object is still owned at the instant its inspection is returned.
  // A competing client then reuses its name before the verifier's next command.
  if ((!state.started && scenario === 'replace-before-start') || (state.started && ['rename-and-replace', 'remove-and-replace'].includes(scenario))) {
    state.replacementInstalled = true;
    state.replacementRemaining = true;
    state.ownedRemaining = scenario !== 'remove-and-replace';
    state.deletedIds = [];
    save();
  }
} else if (args[0] === 'start') {
  const target = args.at(-1);
  const startedId = state.replacementInstalled && target === state.label ? 'replacement-id' : target === 'owned-id' || target === state.label ? 'owned-id' : undefined;
  if (!startedId || (state.replacementInstalled && !(startedId === 'owned-id' ? state.ownedRemaining : state.replacementRemaining))) process.exit(90);
  state.startedIds = [...(state.startedIds ?? []), startedId];
  state.started = true; save(); output({ runtime: 'zeroclaw', qualification: 'unqualified', ...${JSON.stringify(hashes)}, metadata: secret, productionEquivalence: secret, cases: [{ name: secret, passed: true, result: { stdout: secret } }] });
}
else if (args[0] === 'rm') {
  if (state.replacementInstalled) {
    const target = args.at(-1);
    if (target === 'owned-id') {
      if (!state.ownedRemaining) { console.error('Error: No such container: ' + target); process.exit(1); }
      state.ownedRemaining = false;
      state.deletedIds.push('owned-id');
    } else if (target === state.label && state.replacementRemaining) {
      state.replacementRemaining = false;
      state.deletedIds.push('replacement-id');
    } else process.exit(90);
    save(); console.log(target);
  } else { state.container = false; state.removed = true; save(); console.log('owned-id'); }
}
else process.exit(90);
`;

type MissingResponse = { stage: "before-create" | "after-removal"; stderr: string; stdout: string; exit: number };

async function verify(scenario: string, manifest?: Record<string, unknown>, missingResponse?: MissingResponse) {
  const directory = await mkdtemp(join(tmpdir(), "native-provenance-test-"));
  try {
    await writeFile(join(directory, "docker"), fakeDocker, { mode: 0o700 });
    const manifestPath = join(directory, "approval.json");
    if (manifest) await writeFile(manifestPath, JSON.stringify(manifest));
    const evidence = join(directory, "evidence");
    const child = Bun.spawn({
      cmd: [process.execPath, "run", resolve("scripts/verify-native-probe.ts"), "--runtime", "zeroclaw", "--image-id", image, "--transport", "codex-loopback-http", "--evidence-dir", evidence, ...(manifest ? ["--approval-manifest", manifestPath] : [])],
      env: { PATH: directory, STATE: join(directory, "state.json"), SCENARIO: scenario, ...(missingResponse ? { MISSING_RESPONSE: JSON.stringify(missingResponse) } : {}) }, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    const summary = JSON.parse(stdout);
    expect(await readdir(evidence)).toEqual([summary.reportPath.split("/").at(-1)]);
    const text = await readFile(summary.reportPath, "utf8");
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8").catch(() => "{}"));
    return { report: JSON.parse(text), text, state };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const approved = { image, runtime: "zeroclaw", ...hashes, provenance: "independently reviewed synthetic offline build record" };

test("SEC-7 unapproved self-reported cases are observations, never accepted evidence", async () => {
  const { report, text } = await verify("normal");
  expect(report.identityVerified).toBe(false);
  expect(report.fixture.caseEvidenceAccepted).toBe(false);
  expect(report.fixture.cases).toEqual([]);
  expect(report.cleanup).toBe(true);
  expect(text).not.toContain(privateMetadata);
});
test("SEC-7 independent approved identity permits offline case evidence but never qualification", async () => {
  const { report, text } = await verify("normal", approved);
  expect(report.identityVerified).toBe(true);
  expect(report.fixture.caseEvidenceAccepted).toBe(true);
  expect(report.fixture.cases).toEqual([{ passed: true }]);
  expect(report.qualification).toBe("unqualified");
  expect(report.approvalManifestSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(report.cleanup).toBe(true);
  expect(text).not.toContain(privateMetadata);
});
test.each(["binarySha256", "fixtureSha256", "evidenceHelperSha256"])("SEC-7 mismatched approved %s rejects every case", async key => {
  const { report } = await verify("normal", { ...approved, [key]: "e".repeat(64) });
  expect(report.identityVerified).toBe(false);
  expect(report.fixture.caseEvidenceAccepted).toBe(false);
  expect(report.fixture.cases).toEqual([]);
  expect(report.failure).toContain("identity mismatch");
  expect(report.cleanup).toBe(true);
});
test.each(["owner-changed", "id-changed", "inspect-error", "lost-owner"])("SEC-3 %s cannot establish cleanup or delete an unproven resource", async scenario => {
  const { report, state, text } = await verify(scenario);
  expect(report.cleanup).toBe(false);
  expect(report.failure).toContain("cleanup not established");
  expect(state.container).toBe(true);
  expect(state.removed).toBe(false);
  expect(text).not.toContain(privateMetadata);
});
const invalidApprovals: Record<string, unknown>[] = [{ ...approved, image: `sha256:${"e".repeat(64)}` }, { ...approved, runtime: "nullclaw" }, { ...approved, provenance: "" }];
test.each(invalidApprovals)("SEC-7 invalid approval prevents native startup: %j", async manifest => {
  const { report, state } = await verify("normal", manifest);
  expect(report.identityVerified).toBe(false);
  expect(report.cleanup).toBe(true);
  expect(state.started).not.toBe(true);
});

test.each(['rename-and-replace', 'remove-and-replace'])("REVIEW-2 %s after verified inspection never deletes the replacement container", async scenario => {
  const { report, state } = await verify(scenario, approved);
  expect(state.replacementInstalled).toBe(true);
  expect({ ownedRemaining: state.ownedRemaining, replacementRemaining: state.replacementRemaining, deletedIds: state.deletedIds }).toEqual({
    ownedRemaining: false,
    replacementRemaining: true,
    deletedIds: scenario === 'rename-and-replace' ? ['owned-id'] : [],
  });
  if (scenario === 'rename-and-replace') expect(report.cleanup).toBe(true);
});

test("RESIDUAL-1 name replacement after initial validation starts only the verified immutable container", async () => {
  const { report, state } = await verify("replace-before-start", approved);
  expect(report.inspection.isolationValidated).toBe(true);
  expect(state.replacementInstalled).toBe(true);
  expect({ startedIds: state.startedIds, ownedRemaining: state.ownedRemaining, replacementRemaining: state.replacementRemaining, deletedIds: state.deletedIds }).toEqual({
    startedIds: ['owned-id'],
    ownedRemaining: false,
    replacementRemaining: true,
    deletedIds: ['owned-id'],
  });
  expect(report.cleanup).toBe(true);
});
const absenceStages = ["before-create", "after-removal"] as const;
const exactAbsenceResponses = [
  { name: "uppercase Docker diagnostic", stderr: "Error: No such object: <target>\n", stdout: "" },
  { name: "real lowercase Docker diagnostic", stderr: "error: no such object: <target>\n", stdout: "" },
  { name: "mixed-case Docker diagnostic", stderr: "eRrOr: nO sUcH oBjEcT: <target>\n", stdout: "" },
  { name: "real lowercase Docker diagnostic with empty JSON array", stderr: "error: no such object: <target>\n", stdout: "[]\n" },
  { name: "empty JSON array without newline", stderr: "Error: No such object: <target>\n", stdout: "[]" },
  { name: "empty JSON array with CRLF", stderr: "error: no such object: <target>\r\n", stdout: "[]\r\n" },
];
for (const stage of absenceStages) {
  test.each(exactAbsenceResponses)(`MISSING-OBJECT ${stage} accepts exact $name without bypassing identity or cleanup`, async ({ stderr, stdout }) => {
    const { report, state } = await verify("normal", approved, { stage, stderr, stdout, exit: 1 });
    expect(report.identityVerified).toBe(true);
    expect(report.fixture.caseEvidenceAccepted).toBe(true);
    expect(report.fixture.cases).toEqual([{ passed: true }]);
    expect(report.cleanup).toBe(true);
    expect({ startedIds: state.startedIds, container: state.container, removed: state.removed }).toEqual({ startedIds: ["owned-id"], container: false, removed: true });
  });
}

const rejectedAbsenceResponses = [
  { name: "unrelated daemon error", stderr: "Cannot connect to the Docker daemon\n", stdout: "", exit: 1 },
  { name: "empty diagnostic", stderr: "", stdout: "", exit: 1 },
  { name: "different target", stderr: "Error: No such object: another-container\n", stdout: "", exit: 1 },
  { name: "target prefix collision", stderr: "Error: No such object: <target>-other\n", stdout: "", exit: 1 },
  { name: "prefixed unrelated error", stderr: "daemon failure: Error: No such object: <target>\n", stdout: "", exit: 1 },
  { name: "suffixed unrelated error", stderr: "Error: No such object: <target>: permission denied\n", stdout: "", exit: 1 },
  { name: "additional error line", stderr: "Error: No such object: <target>\npermission denied\n", stdout: "", exit: 1 },
  { name: "multiple missing targets", stderr: "Error: No such object: <target>\nError: No such object: another-container\n", stdout: "", exit: 1 },
  { name: "successful exit with missing diagnostic", stderr: "Error: No such object: <target>\n", stdout: "", exit: 0 },
  { name: "unexpected error exit", stderr: "Error: No such object: <target>\n", stdout: "", exit: 2 },
  { name: "ambiguous object on stdout", stderr: "Error: No such object: <target>\n", stdout: '[{"Id":"foreign-id"}]\n', exit: 1 },
  { name: "noncanonical empty list on stdout", stderr: "Error: No such object: <target>\n", stdout: "[ ]\n", exit: 1 },
  { name: "extra data after empty list on stdout", stderr: "Error: No such object: <target>\n", stdout: "[]\nforeign-data", exit: 1 },
];
for (const stage of absenceStages) {
  test.each(rejectedAbsenceResponses)(`MISSING-OBJECT ${stage} rejects $name as proof of absence`, async ({ name: _name, ...response }) => {
    const { report, state } = await verify("normal", approved, { stage, ...response });
    if (stage === "before-create") {
      expect(report.failure).toBe("Owned container name absence not established before create");
      expect(report.identityVerified).toBe(false);
      expect({ container: state.container, started: state.started, removed: state.removed }).toEqual({ container: false, started: false, removed: false });
    } else {
      expect(report.identityVerified).toBe(true);
      expect(report.cleanup).toBe(false);
      expect(report.failure).toContain("owned container cleanup not established");
      expect({ container: state.container, started: state.started, removed: state.removed }).toEqual({ container: false, started: true, removed: true });
    }
  });
}
