
import { SQLiteWorkflowStore } from "../glue/store.ts";
const store = new SQLiteWorkflowStore("workflows.sqlite");
const workflows = await store.values();
const sorted = [...workflows].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 10);

console.log("\x1b[1m=== GJC (Global Jeoclaw Control) TUI Monitor ===\x1b[0m");
console.log("-".repeat(70));
console.log("ID".padEnd(20) + "Runtime".padEnd(12) + "Stage".padEnd(18) + "Status");
console.log("-".repeat(70));

for (const wf of sorted) {
    let color = "\x1b[0m";
    if (wf.status === "running") color = "\x1b[32m";
    if (wf.status === "awaiting-approval") color = "\x1b[33m";
    
    console.log(
        wf.id.padEnd(20) + 
        wf.runtime.padEnd(12) + 
        wf.stage.padEnd(18) + 
        `${color}${wf.status}\x1b[0m`
    );
    if (wf.pendingAction) {
        console.log(`  └─ \x1b[33mPENDING ACTION: ${wf.pendingAction}\x1b[0m`);
    }
}
process.exit(0);
