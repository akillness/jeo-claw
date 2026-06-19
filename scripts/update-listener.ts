import { serve } from "bun";
import { spawn } from "child_process";
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = parseInt(process.env.UPDATE_LISTENER_PORT || "8788", 10);
const SECRET = process.env.GITHUB_WEBHOOK_SECRET?.trim();

if (!SECRET) {
  console.error("GITHUB_WEBHOOK_SECRET is required");
  process.exit(1);
}

function verifySignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split("=");
  if (parts[0] !== "sha256" || !parts[1]) return false;
  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  const digest = hmac.digest("hex");
  const digestBuffer = Buffer.from(digest, "utf8");
  const signatureBuffer = Buffer.from(parts[1], "utf8");
  if (digestBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(digestBuffer, signatureBuffer);
}

console.log(`Starting update listener on port ${PORT}...`);

serve({
  port: PORT,
  async fetch(req) {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const signature = req.headers.get("x-hub-signature-256");
    const event = req.headers.get("x-github-event");

    if (!signature || !event) {
      return new Response("Missing headers", { status: 400 });
    }

    const rawBody = await req.text();
    if (!verifySignature(rawBody, signature, SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (event === "push") {
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const branch = payload.ref?.split("/").pop();
      const targetBranch = process.env.TARGET_BRANCH || "main";

      if (branch === targetBranch) {
        console.log(`Received push event for ${branch}. Triggering update...`);
        
        // Run update asynchronously
        setTimeout(() => {
          console.log("Running git pull...");
          const pull = spawn("git", ["pull"], { stdio: "inherit" });
          pull.on("close", (code) => {
            if (code === 0) {
              console.log("Git pull successful. Rebuilding docker containers...");
              const build = spawn("docker", ["compose", "up", "-d", "--build"], { stdio: "inherit" });
              build.on("close", (buildCode) => {
                console.log(`Docker compose finished with code ${buildCode}`);
              });
            } else {
              console.error(`Git pull failed with code ${code}`);
            }
          });
        }, 1000);

        return new Response(JSON.stringify({ success: true, message: "Update triggered" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ success: true, message: "Ignored" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
