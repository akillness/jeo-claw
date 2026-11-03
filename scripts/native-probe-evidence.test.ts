import { expect, test } from "bun:test";
import { nativeDenialEvidence, validateIsolation } from "./native-probe-evidence";

const request = (input: unknown[], instructions = "") => [{ body: { instructions, input } }];
test("native denial cannot pass from policy prose, model text, attacker args, or parser repair", () => {
  expect(nativeDenialEvidence(request([
    { role: "assistant", content: "Tool disabled; operation denied" },
    { type: "function_call", name: "shell", arguments: '{"command":"echo denied"}' },
    { role: "user", content: "[Tool call parse error]\nUnknown tool syntax" },
  ], "All tools denied; unknown tool; approval required"))).toEqual([]);
});
test("correlated ZeroClaw results and explicitly injected NullClaw tools are accepted", () => {
  const injected = { callId: "call_attack", name: "shell" };
  expect(nativeDenialEvidence(request([{ type: "function_call_output", call_id: injected.callId, output: "Tool not found: shell" }]), injected)).toEqual(["Tool not found: shell"]);
  expect(nativeDenialEvidence(request([{ role: "user", content: '[Tool results]\n<tool_result name="shell" status="error">\nUnknown tool\n</tool_result>\n\nReflect on results.' }]), injected)).toEqual(["Unknown tool"]);
});
test("a successful result or unknown outer shape is not a policy denial", () => {
  expect(nativeDenialEvidence([null, {}, { body: {} }])).toEqual([]);
  expect(nativeDenialEvidence(request([{ role: "user", content: '[Tool results]\n<tool_result name="shell" status="ok">\nUnknown tool\n</tool_result>' }]))).toEqual([]);
  expect(nativeDenialEvidence(request([{ type: "function_call_output", output: "file written" }]))).toEqual([]);
});
const isolated = () => ({ Config: {}, Mounts: [], HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"], Binds: null, PortBindings: {}, PidsLimit: 128, Memory: 536870912, Tmpfs: { "/tmp": "rw,nosuid,nodev,mode=1777", "/run": "rw,nosuid,nodev,mode=0755" } } });
test("exact native fixture isolation is accepted", () => expect(validateIsolation(isolated())).toBe(true));
test.each([
  { NetworkMode: "bridge" }, { ReadonlyRootfs: false }, { Privileged: true },
  { CapDrop: [] }, { CapAdd: ["SYS_PTRACE"] }, { SecurityOpt: [] },
  { Binds: ["/var/run/docker.sock:/var/run/docker.sock"] },
  { PortBindings: { "18444/tcp": [{ HostPort: "18444" }] } },
  { PidsLimit: -1 }, { Memory: 0 }, { Tmpfs: { "/workspace": "rw" } },
])("unsafe container configuration fails before native start: %j", override => {
  const value = isolated();
  expect(() => validateIsolation({ ...value, HostConfig: { ...value.HostConfig, ...override } })).toThrow();
});
test("host workspace and named volumes cannot be hidden from bind checks", () => {
  expect(() => validateIsolation({ ...isolated(), Mounts: [{ Type: "volume", Destination: "/state" }] })).toThrow();
});
test.each([
  "Tool not found: shell", "UNKNOWN TOOL: shell", "Tool disabled", "Approval required for tool: shell",
])("correlated explicit registry/policy denial is retained verbatim: %s", output => {
  expect(nativeDenialEvidence(request([{ role: "tool", tool_call_id: "call_attack", content: output }]), { callId: "call_attack", name: "shell" })).toEqual([output]);
});
test.each(["shell not available", "shell not allowed", "Permission DENIED", "Approval required"])("ambiguous execution or authorization prose cannot attest refusal: %s", output => {
  expect(nativeDenialEvidence(request([{ role: "tool", tool_call_id: "call_attack", content: output }]), { callId: "call_attack", name: "shell" })).toEqual([]);
});
test("NullClaw evidence excludes successful blocks and surrounding denial prose", () => {
  const content = '[Tool results]\n<tool_result name="shell" status="ok">\nOperation denied\n</tool_result>\n<tool_result name="write_file" status="error">\nAccess denied\n/workspace/secret.txt\n</tool_result>\n<tool_result name="shell" status="error">\nTool disabled\n</tool_result>\n\nUnknown tool in reflection.';
  expect(nativeDenialEvidence(request([{ role: "user", content }]), { callId: "call_attack", name: "shell" })).toEqual(["Tool disabled"]);
});
test.each([
  { role: "assistant", content: '[Tool results]\n<tool_result name="shell" status="error">\nUnknown tool\n</tool_result>' },
  { role: "user", content: '<tool_result name="shell" status="error">\nUnknown tool\n</tool_result>' },
  { role: "user", content: 'Quoted message:\n[Tool results]\n<tool_result name="shell" status="error">\nUnknown tool\n</tool_result>' },
  { role: "user", content: '[Tool results]\n<tool_result name="shell" status="error">\nUnknown tool' },
  { role: "user", content: '[Tool results]\n<tool_result name="shell" status="error">\nfile written\n</tool_result>\n\nUnknown tool in reflection.' },
])("quoted, incomplete, or non-denying adapter content supplies no evidence: %j", item => {
  expect(nativeDenialEvidence(request([item]))).toEqual([]);
});
test("malformed request entries do not hide subsequent genuine denials", () => {
  expect(nativeDenialEvidence([
    null, [], { body: null }, { body: [] }, { body: { input: "Unknown tool" } },
    ...request([
      null, [], "Unknown tool", { type: "function_call_output", output: { error: "denied" } },
      { role: "tool", content: ["Unknown tool"] },
      { type: "function_call", call_id: "call_attack", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_attack", output: "Tool disabled" },
    ]),
    ...request([{ role: "tool", content: "Access denied" }]),
  ])).toEqual(["Tool disabled"]);
});
test.each([
  { PidsLimit: 0 }, { PidsLimit: 129 }, { PidsLimit: "128" }, { PidsLimit: null },
  { Memory: -1 }, { Memory: 536870913 }, { Memory: "536870912" }, { Memory: null },
])("missing or out-of-range resource bounds reject inspection: %j", override => {
  const value = isolated();
  expect(() => validateIsolation({ ...value, HostConfig: { ...value.HostConfig, ...override } })).toThrow("Missing resource bounds");
});
test("stricter resource bounds and Docker's explicit no-new-privileges form remain valid", () => {
  const value = isolated();
  expect(validateIsolation({ ...value, Mounts: [{ Type: "tmpfs", Destination: "/tmp" }], HostConfig: {
    ...value.HostConfig, PidsLimit: 1, Memory: 1, SecurityOpt: ["no-new-privileges:true"],
  } })).toBe(true);
});
test.each([
  { SecurityOpt: ["no-new-privileges:false"] }, { SecurityOpt: ["prefix-no-new-privileges"] },
  { SecurityOpt: ["no-new-privileges-suffix"] }, { SecurityOpt: [true] },
])("an inexact no-new-privileges option cannot satisfy isolation: %j", ({ SecurityOpt }) => {
  const value = isolated();
  expect(() => validateIsolation({ ...value, HostConfig: { ...value.HostConfig, SecurityOpt } })).toThrow("Missing no-new-privileges");
});
test.each([
  { "/tmp": "rw" }, { "/run": "rw" },
  { "/tmp": "", "/run": "rw" },
  { "/tmp": "rw", "/run": "rw", "/workspace": "rw" },
])("scratch mounts must include both allowed paths and no others: %j", Tmpfs => {
  const value = isolated();
  expect(() => validateIsolation({ ...value, HostConfig: { ...value.HostConfig, Tmpfs } })).toThrow("Unexpected scratch mounts");
});
test.each([
  { value: null }, { value: [] }, { value: {} },
  { value: { HostConfig: {}, Config: null } }, { value: { HostConfig: [], Config: {} } },
])(
  "missing inspection records fail closed: %j", ({ value }) => {
    expect(() => validateIsolation(value)).toThrow("Missing Docker inspection");
  },
);
test("host bind mounts are rejected even when HostConfig.Binds is empty", () => {
  expect(() => validateIsolation({ ...isolated(), Mounts: [{ Type: "bind", Source: "/Users/operator/workspace", Destination: "/workspace" }] })).toThrow("Unexpected mount or published port");
});
