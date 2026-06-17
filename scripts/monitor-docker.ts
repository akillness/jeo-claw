import { $ } from "bun";

async function monitor() {
  console.log("🚀 Starting Docker Memory & CPU Monitoring Daemon...");
  setInterval(async () => {
    try {
      const stats = await $`docker stats --no-stream --format '{{.Container}} | {{.MemUsage}} | {{.CPUPerc}}' jeo-claw-hive`.text();
      const parts = stats.trim().split('|').map(s => s.trim());
      if (parts.length >= 3) {
        const mem = parts[1];
        const cpu = parts[2];
        console.log(`[Monitor] jeo-claw-hive - Mem: ${mem}, CPU: ${cpu}`);
        
        // Simple heuristic for memory leak (if usage goes above e.g. 1.5GB)
        if (mem.includes("GiB")) {
            const gb = parseFloat(mem.split("GiB")[0]);
            if (gb > 1.5) {
                console.error("⚠️ HIGH MEMORY ALERT! Triggering GC or Rebuild...");
                // Could trigger restart here: await $`docker compose restart claw-hive`;
            }
        }
      }
    } catch (err) {
      console.error("[Monitor] Failed to fetch docker stats", err);
    }
  }, 10000);
}

if (import.meta.main) {
  monitor();
}
