import fs from 'fs';
let code = fs.readFileSync('glue/server.ts', 'utf8');

if (!code.includes('Auto-Rebuild Trigger')) {
  code = code.replace(
    'if (updated.status === "merged" && process.env.CONTINUOUS_EVOLUTION !== "0") {',
    'if (updated.status === "merged") {\n      // Auto-Rebuild Trigger\n      try {\n        console.log(`[Auto-Rebuild] PR merged, triggering docker rebuild...`);\n        require("child_process").exec("docker compose build claw-hive && docker compose up -d claw-hive", { cwd: "/app" });\n      } catch(e) { console.error("Auto-rebuild failed:", e); }\n    }\n    if (updated.status === "merged" && process.env.CONTINUOUS_EVOLUTION !== "0") {'
  );
  fs.writeFileSync('glue/server.ts', code);
  console.log('Applied auto-rebuild patch');
}
