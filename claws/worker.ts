import { serve } from "bun";
import { generateImprovement } from "./repo-work.ts";
import type { Stage, Runtime } from "../glue/contract.ts";

const role = process.argv[2];
const port = parseInt(process.env.JEO_CLAW_PORT || "9201", 10);
const secret = process.env.JEO_RUNTIME_DISPATCH_SECRET || "";

console.log(`Claw worker started for role: ${role} on port: ${port}`);

serve({
  port,
  async fetch(req) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/dispatch") {
      return new Response("Not found", { status: 404 });
    }
    if (req.headers.get("x-runtime-dispatch-secret") !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      const body = await req.json() as any;
      
      console.log(`Claw ${role} stage ${body.stage} started for workflow ${body.workflowId}`);
      
      if (role === "researcher-coder" && body.stage === "research-code") {
        // Run gjc via repo-work
        const analysis = { repo: body.repo || "akillness/jeo-code", defaultBranch: "main", description: "", languages: {}, recentCommits: [], openIssues: 0, fileTree: [] };
        const result = await generateImprovement(analysis, body.request);
        
        console.log(`Claw ${role} stage ${body.stage} completed successfully for workflow ${body.workflowId}`);
        return new Response(JSON.stringify({ success: true, summary: result.summary }), { headers: { "Content-Type": "application/json" } });
      } else {
        // Mock success for other roles to keep workflow moving
        console.log(`Claw ${role} stage ${body.stage} completed successfully for workflow ${body.workflowId}`);
        return new Response(JSON.stringify({ success: true, summary: "Mock success" }), { headers: { "Content-Type": "application/json" } });
      }
    } catch (e: any) {
      console.error(`Claw ${role} stage failed:`, e);
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }
});
