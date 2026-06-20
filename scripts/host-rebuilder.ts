import { watch } from "fs";
import { exec } from "child_process";

console.log("Watching for changes to trigger docker rebuild...");

let timeout: any;
watch(".", { recursive: true }, (eventType, filename) => {
    if (!filename || filename.includes(".git") || filename.includes("node_modules") || filename.includes(".jeo") || filename.includes(".sqlite")) return;
    
    clearTimeout(timeout);
    timeout = setTimeout(() => {
        console.log(`[Auto-Rebuild] Changes detected in ${filename}. Rebuilding...`);
        exec("docker compose up -d --build claw-hive", (err, stdout, stderr) => {
            if (err) console.error("Rebuild failed:", err);
            else console.log("Rebuild success:\n", stdout);
        });
    }, 5000);
});
