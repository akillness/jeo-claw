import { watch } from "fs";
import { spawn } from "child_process";

console.log("Watching for changes to trigger docker rebuild...");

let timeout: any;
watch(".", { recursive: true }, (eventType, filename) => {
    if (!filename || filename.includes(".git") || filename.includes("node_modules") || filename.includes(".jeo") || filename.includes(".sqlite")) return;
    
    clearTimeout(timeout);
    timeout = setTimeout(() => {
        console.log(`[Auto-Rebuild] Changes detected in ${filename}. Rebuilding...`);
        const rebuild = spawn("docker", ["compose", "up", "-d", "--build", "claw-hive"], { stdio: "inherit" });
        rebuild.on("error", (err) => console.error("Rebuild failed:", err));
        rebuild.on("close", (code) => console.log(`Rebuild process exited with code ${code}`));
    }, 5000);
});
