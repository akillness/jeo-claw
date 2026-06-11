import { Database } from "bun:sqlite";
import type { WorkflowState } from "./contract";

export interface WorkflowStore {
  get(id: string): WorkflowState | undefined;
  set(id: string, state: WorkflowState): void;
  delete(id: string): void;
  values(): WorkflowState[];
  size: number;
}

export class SQLiteWorkflowStore implements WorkflowStore {
  private db: Database;

  constructor(path: string = "workflows.sqlite") {
    this.db = new Database(path);
    this.init();
  }

  private init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        last_touched INTEGER NOT NULL
      )
    `);
  }

  get(id: string): WorkflowState | undefined {
    const row = this.db.query("SELECT data FROM workflows WHERE id = ?").get(id) as { data: string } | null;
    if (!row) return undefined;
    return JSON.parse(row.data);
  }

  set(id: string, state: WorkflowState): void {
    const data = JSON.stringify(state);
    const now = Date.now();
    this.db.run(
      "INSERT OR REPLACE INTO workflows (id, data, last_touched) VALUES (?, ?, ?)",
      [id, data, now]
    );
  }

  delete(id: string): void {
    this.db.run("DELETE FROM workflows WHERE id = ?", [id]);
  }

  values(): WorkflowState[] {
    const rows = this.db.query("SELECT data FROM workflows").all() as { data: string }[];
    return rows.map(r => JSON.parse(r.data));
  }

  get size(): number {
    const row = this.db.query("SELECT COUNT(*) as count FROM workflows").get() as { count: number };
    return row.count;
  }
}
