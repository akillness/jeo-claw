import fs from "fs";
const data = JSON.parse(fs.readFileSync("secrets/live.json", "utf8"));
const token = data["github-token-rw"];
fetch("https://api.github.com/user", {
  headers: { "Authorization": `Bearer ${token}` }
}).then(async r => {
  console.log("Status:", r.status);
  console.log("Scopes:", r.headers.get("X-OAuth-Scopes"));
  console.log("Accepted:", r.headers.get("X-Accepted-OAuth-Scopes"));
  console.log(await r.json());
});
