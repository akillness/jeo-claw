// Automated Token Cleanup verification
// Automated UI cleanup test
// Automated proof of zero-click merge
import { Database, Statement } from "bun:sqlite";
import type { WorkflowState } from "./contract";

export interface WorkflowStore {
  get(id: string): WorkflowState | undefined;
  set(id: string, state: WorkflowState): void;
  delete(id: string): void;
  values(): WorkflowState[];
  getActiveWorkflows(): WorkflowState[];
  size: number;
  getRunningWorkflowsCount?(): number;
  hasDuplicateRequest?(request: string): boolean;
}

export class SQLiteWorkflowStore implements WorkflowStore {
  private db: Database;
  private getStmt: Statement;
  private setStmt: Statement;
  private deleteStmt: Statement;
  private valuesStmt: Statement;
  private activeStmt: Statement;
  private sizeStmt: Statement;
  private runningCountStmt: Statement;
  private hasDuplicateStmt: Statement;

  constructor(path: string = "workflows.sqlite") {
    this.db = new Database(path);
    this.init();
    
    this.getStmt = this.db.query("SELECT data FROM workflows WHERE id = ?");
    this.setStmt = this.db.query("INSERT OR REPLACE INTO workflows (id, data, last_touched) VALUES (?, ?, ?)");
    this.deleteStmt = this.db.query("DELETE FROM workflows WHERE id = ?");
    this.valuesStmt = this.db.query("SELECT data FROM workflows");
    this.activeStmt = this.db.query("SELECT data FROM workflows WHERE json_extract(data, '$.status') NOT IN ('completed', 'failed', 'merged')");
    this.sizeStmt = this.db.query("SELECT COUNT(*) as count FROM workflows");
    this.runningCountStmt = this.db.query("SELECT COUNT(*) as count FROM workflows WHERE json_extract(data, '$.status') IN ('running', 'pending')");
    this.hasDuplicateStmt = this.db.query("SELECT 1 FROM workflows WHERE json_extract(data, '$.request') = ? AND json_extract(data, '$.status') IN ('queued', 'pending', 'running', 'awaiting-approval') LIMIT 1");
  }

  private init() {
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        last_touched INTEGER NOT NULL
      )
    `);
  }

  get(id: string): WorkflowState | undefined {
    const row = this.getStmt.get(id) as { data: string } | null;
    if (!row) return undefined;
    return JSON.parse(row.data);
  }

  set(id: string, state: WorkflowState): void {
    const data = JSON.stringify(state);
    const now = Date.now();
    this.setStmt.run(id, data, now);
  }

  delete(id: string): void {
    this.deleteStmt.run(id);
  }

  getRunningWorkflowsCount(): number {
    const row = this.runningCountStmt.get() as { count: number };
    return row.count;
  }

  hasDuplicateRequest(request: string): boolean {
    const row = this.hasDuplicateStmt.get(request);
    return !!row;
  }

  values(): WorkflowState[] {
    const rows = this.valuesStmt.all() as { data: string }[];
    return rows.map(r => JSON.parse(r.data));
  }

  getActiveWorkflows(): WorkflowState[] {
    const rows = this.activeStmt.all() as { data: string }[];
    return rows.map(r => JSON.parse(r.data));
  }

  get size(): number {
    const row = this.sizeStmt.get() as { count: number };
    return row.count;
  }
}
