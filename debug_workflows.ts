import fs from "fs";
const data = JSON.parse(fs.readFileSync("secrets/live.json", "utf8"));
const secret = data["jeo-claw-control-event-secret"];
fetch("http://127.0.0.1:8787/debug/workflows", {
  headers: { "x-control-event-secret": secret }
}).then(async r => {
  console.log("Status:", r.status);
  const json = await r.json() as any;
  console.log("WF:", json.workflows.find((w:any) => w.id === "wf-1781576807261-302"));
});
