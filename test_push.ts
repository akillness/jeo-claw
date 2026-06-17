import { $ } from "bun";
import fs from "fs";
const data = JSON.parse(fs.readFileSync("secrets/live.json", "utf8"));
const token = data["github-token-rw"];
const repo = "akillness/jeo-claw";
await $`rm -rf /tmp/test-push && mkdir -p /tmp/test-push`;
await $`cd /tmp/test-push && git clone https://github.com/${repo}.git .`;
await $`cd /tmp/test-push && git config user.email "test@example.com" && git config user.name "Test"`;
await $`cd /tmp/test-push && git checkout -b test-push-branch-${Date.now()}`;
await $`cd /tmp/test-push && touch test.txt && git add test.txt && git commit -m "test"`;
const pushUrl1 = `https://oauth2:${token}@github.com/${repo}.git`;
const pushUrl2 = `https://x-access-token:${token}@github.com/${repo}.git`;
try {
  await $`cd /tmp/test-push && git push --force ${pushUrl1} HEAD`;
  console.log("SUCCESS using oauth2");
} catch (e: any) {
  console.log("FAILED with oauth2:", e.stderr?.toString());
  try {
    await $`cd /tmp/test-push && git push --force ${pushUrl2} HEAD`;
    console.log("SUCCESS using x-access-token");
  } catch (e2: any) {
    console.log("FAILED with x-access-token:", e2.stderr?.toString());
  }
}
