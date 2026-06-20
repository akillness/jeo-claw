const fs = require('fs');
let content = fs.readFileSync('glue/server.test.ts', 'utf8');
content = content.replace(
  /test\("handleControlEventRequest creates workflows and ignores early approvals", async \(\) => \{\n\s+const localStore = new Map<string, WorkflowState>\(\);\n\s+const req = new Request\("http:\/\/localhost\/control-event", \{\n\s+method: "POST",\n\s+headers: \{\n\s+"Authorization": `Bearer \$\{CONTROL_SECRET\}`,\n\s+"Content-Type": "application\/json",\n\s+\},\n\s+body: JSON\.stringify\(\{ type: "request", runtime: "zeroclaw", request: "fix bug" \}\),\n\s+\}\);\n\s+const res = await handleControlEventRequest\(req, \{ store: localStore, controlEventSecret: CONTROL_SECRET \}\);\n\s+expect\(res\.status\)\.toBe\(200\);\n\s+const created = await res\.json\(\) as any;\n\s+expect\(created\.workflow\.id\)\.toBeDefined\(\);\n\s+expect\(created\.workflow\.stage\)\.toBe\("research-code"\);\n\n\s+const approveReq = new Request\("http:\/\/localhost\/control-event", \{\n\s+method: "POST",\n\s+headers: \{\n\s+"Authorization": `Bearer \$\{CONTROL_SECRET\}`,\n\s+"Content-Type": "application\/json",\n\s+\},\n\s+body: JSON\.stringify\(\{ type: "approve", workflowId: created\.workflow\.id, action: "pr\.create", user: "alice" \}\),\n\s+\}\);\n\s+const approveRes = await handleControlEventRequest\(approveReq, \{ store: localStore, controlEventSecret: CONTROL_SECRET \}\);\n\s+expect\(approveRes\.status\)\.toBe\(200\);\n\s+expect\(localStore\.get\(created\.workflow\.id\)\?\.actionApprovals\?\.\["pr\.create"\]\?\.status\)\.toBeUndefined\(\);\n\}\);/,
  `test("handleControlEventRequest creates workflows and accepts early approvals", async () => {
  const localStore = new Map<string, WorkflowState>();
  const req = new Request("http://localhost/control-event", {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${CONTROL_SECRET}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "fix bug" }),
  });
  const res = await handleControlEventRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET });
  expect(res.status).toBe(200);
  const created = await res.json() as any;
  expect(created.workflow.id).toBeDefined();
  expect(created.workflow.stage).toBe("research-code");

  const approveReq = new Request("http://localhost/control-event", {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${CONTROL_SECRET}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "approve", workflowId: created.workflow.id, action: "pr.create", user: "alice" }),
  });
  const approveRes = await handleControlEventRequest(approveReq, { store: localStore, controlEventSecret: CONTROL_SECRET });
  expect(approveRes.status).toBe(200);
  expect(localStore.get(created.workflow.id)?.actionApprovals?.["pr.create"]?.status).toBe("approved");
});`
);
fs.writeFileSync('glue/server.test.ts', content);
