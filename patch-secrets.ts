import fs from "fs";
const file = "secrets/live.json";
const data = JSON.parse(fs.readFileSync(file, "utf8"));
data["jeo-claw-openai-codex-oauth"] = JSON.stringify({ refresh_token: "mock-rt", access_token: "mock-at" });
fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
console.log("Patched secrets/live.json");
