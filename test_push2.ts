import { $ } from "bun";
import fs from "fs";
const data = JSON.parse(fs.readFileSync("secrets/live.json", "utf8"));
const token = data["github-token-rw"];
const repo = "akillness/jeo-claw";
const pushUrl = `https://akillness:${token}@github.com/${repo}.git`;
try {
  await $`cd /tmp/test-push && git push --force ${pushUrl} HEAD`;
  console.log("SUCCESS using username");
} catch (e: any) {
  console.log("FAILED with username:", e.stderr?.toString());
}
