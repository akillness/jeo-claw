
import { SQLiteWorkflowStore } from "../glue/store.ts";
import type { WorkflowState } from "../glue/contract.ts";

const dbPath = process.env.SQLITE_DB_PATH || "workflows.sqlite";
const store = new SQLiteWorkflowStore(dbPath);

const REFRESH_INTERVAL_MS = 2000;

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[0;0H");
}

function getColor(status: string) {
  switch (status) {
    case "running": return "\x1b[32m"; // Green
    case "pending": return "\x1b[34m"; // Blue
    case "awaiting-approval": return "\x1b[33m"; // Yellow
    case "merged": return "\x1b[36m"; // Cyan
    case "rejected": return "\x1b[31m"; // Red
    case "failed": return "\x1b[35m"; // Magenta
    default: return "\x1b[0m"; // Reset
  }
}

async function render() {
  const workflows = await store.values();
  const sorted = [...workflows].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 20);

  
  console.log("\x1b[1m=== GJC (Global Jeoclaw Control) TUI Monitor ===\x1b[0m");
  console.log(`DB: ${dbPath} | Refresh: ${REFRESH_INTERVAL_MS}ms | Time: ${new Date().toLocaleTimeString()}`);
  console.log("-".repeat(80));
  console.log(
    "ID".padEnd(25) + 
    "Runtime".padEnd(12) + 
    "Stage".padEnd(20) + 
    "Status".padEnd(20)
  );
  console.log("-".repeat(80));

  for (const wf of sorted) {
    const color = getColor(wf.status);
    const reset = "\x1b[0m";
    
    console.log(
      wf.id.padEnd(25) + 
      wf.runtime.padEnd(12) + 
      wf.stage.padEnd(20) + 
      `${color}${wf.status}${reset}`.padEnd(30)
    );
    if (wf.pendingAction) {
      console.log(`  └─ \x1b[33mPENDING ACTION: ${wf.pendingAction}\x1b[0m`);
    }
  }

  if (sorted.length === 0) {
    console.log("\x1b[90mNo active workflows found.\x1b[0m");
  }
}

async function start() { await render(); process.exit(0);
  
    await render();
    
  }
}

start().catch(console.error);
