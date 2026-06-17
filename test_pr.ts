import fs from "fs";
const data = JSON.parse(fs.readFileSync("secrets/live.json", "utf8"));
const token = data["github-token-rw"];

async function testPR() {
  const res = await fetch("https://api.github.com/repos/akillness/jeo-claw/pulls", {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "ZeroClaw-Test"
    }
  });
  console.log("Status:", res.status);
  const text = await res.text();
  console.log("Response:", text.slice(0, 200));
}
testPR();
