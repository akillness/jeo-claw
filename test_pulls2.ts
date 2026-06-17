import fs from "fs";
const data = JSON.parse(fs.readFileSync("secrets/live.json", "utf8"));
const token = data["github-token-rw"];

async function testPR() {
  const res = await fetch("https://api.github.com/repos/akillness/jeo-claw/pulls", {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "ZeroClaw-Test"
    }
  });
  console.log("Status:", res.status);
}
testPR();
