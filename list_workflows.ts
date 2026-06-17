import { Database } from "bun:sqlite";
const db = new Database("workflows.sqlite");
const rows = db.query("SELECT data FROM workflows ORDER BY last_touched DESC").all();
console.log(JSON.stringify(rows.map(r => JSON.parse(r.data)), null, 2));
