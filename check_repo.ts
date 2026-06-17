import fs from "fs";
const data = JSON.parse(fs.readFileSync("secrets/live.json", "utf8"));
const token = data["github-token-rw"];
fetch("https://api.github.com/repos/akillness/jeo-claw", {
  headers: { "Authorization": `Bearer ${token}` }
}).then(async r => {
  const json = await r.json();
  console.log("Permissions:", json.permissions);
});
