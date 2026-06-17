import fs from "fs";
const data = JSON.parse(fs.readFileSync("secrets/live.json", "utf8"));
const token = data["github-token-rw"];
fetch("https://api.github.com/user", {
  headers: { "Authorization": `Bearer ${token}` }
}).then(async r => {
  console.log("Token starts with:", token.substring(0, 15) + "...");
});
