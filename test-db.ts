import { Database } from "bun:sqlite";
const db = new Database('/data/workflows.sqlite');
console.log(db.query('SELECT id, status FROM workflows').all());
