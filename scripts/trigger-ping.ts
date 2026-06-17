import { SQLiteWorkflowStore } from "../glue/store.ts";
import { loadWriteSecretsForRole, secretSourceFromEnv } from "../secrets/loader.ts";

async function run() {
    const secret = process.env.JEO_CONTROL_EVENT_SECRET || "";
    const res = await fetch("http://127.0.0.1:8787/control-event", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-control-event-secret": "c4d5d2f7071751a543514a894acd70bfb3a538b234175edb5cec6278bfc2494c" // from logs
        },
        body: JSON.stringify({
            type: "request",
            runtime: "zeroclaw",
            request: "wakeup ping"
        })
    });
    console.log(await res.text());
}

run().catch(console.error);
