import fs from "fs";
import os from "os";

const jeoDir = os.homedir() + "/.jeo";
if (!fs.existsSync(jeoDir)) fs.mkdirSync(jeoDir, { recursive: true });

const liveJson = JSON.parse(fs.readFileSync("secrets/live.json", "utf8"));
const geminiAuthStr = liveJson["jeo-claw-gemini-oauth"];

const config = {
  providers: {
    "google-antigravity": {
      "oauth": JSON.parse(geminiAuthStr)
    }
  },
  defaultModel: "antigravity/gemini-3.5-flash",
  modelAliases: {}
};

fs.writeFileSync(jeoDir + "/config.json", JSON.stringify(config, null, 2), "utf8");
console.log("Written to " + jeoDir + "/config.json");
