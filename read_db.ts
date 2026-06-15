import { Database } from "bun:sqlite";
const db = new Database("workflows.sqlite");
const rows = db.query("SELECT id, last_touched FROM workflows ORDER BY last_touched DESC LIMIT 10").all();
console.log(JSON.stringify(rows, null, 2));
const data = db.query("SELECT data FROM workflows ORDER BY last_touched DESC LIMIT 1").get() as { data: string } | null;
if (data) {
    console.log("Latest Workflow Data:");
    console.log(JSON.stringify(JSON.parse(data.data), null, 2));
}
