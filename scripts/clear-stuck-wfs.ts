import { SQLiteWorkflowStore } from "../glue/store.ts";

async function run() {
    const store = new SQLiteWorkflowStore("workflows.sqlite");
    const all = await store.values();
    let cleared = 0;
    for (const w of all) {
        if (w.status === "running" || w.status === "pending") {
            w.status = "failed";
            await store.set(w.id, w);
            cleared++;
            console.log(`Cleared stuck workflow: ${w.id}`);
        }
    }
    console.log(`Cleared ${cleared} workflows.`);
}

run().catch(console.error);
