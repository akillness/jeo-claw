import { SQLiteWorkflowStore } from "../glue/store.ts";
import { loadWriteSecretsForRole, secretSourceFromEnv } from "../secrets/loader.ts";

async function run() {
    const secret = process.env.JEO_CONTROL_EVENT_SECRET;
    if (!secret) throw new Error("JEO_CONTROL_EVENT_SECRET is required");

    const res = await fetch("http://127.0.0.1:8787/control-event", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-control-event-secret": secret
        },
        body: JSON.stringify({
            type: "request",
            runtime: "zeroclaw",
            request: "wakeup ping"
        })
    });
    console.log(await res.text());
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
