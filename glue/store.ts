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
  size: number;
  hasRunningWorkflows?(): boolean;
  hasDuplicateRequest?(request: string): boolean;
}

export class SQLiteWorkflowStore implements WorkflowStore {
  private db: Database;
  private getStmt: Statement;
  private setStmt: Statement;
  private deleteStmt: Statement;
  private valuesStmt: Statement;
  private sizeStmt: Statement;
  private hasRunningStmt: Statement;
  private hasDuplicateStmt: Statement;

  constructor(path: string = "workflows.sqlite") {
    this.db = new Database(path);
    this.init();
    
    this.getStmt = this.db.query("SELECT data FROM workflows WHERE id = ?");
    this.setStmt = this.db.query("INSERT OR REPLACE INTO workflows (id, data, last_touched) VALUES (?, ?, ?)");
    this.deleteStmt = this.db.query("DELETE FROM workflows WHERE id = ?");
    this.valuesStmt = this.db.query("SELECT data FROM workflows");
    this.sizeStmt = this.db.query("SELECT COUNT(*) as count FROM workflows");
    this.hasRunningStmt = this.db.query("SELECT 1 FROM workflows WHERE json_extract(data, '$.status') IN ('running', 'pending') LIMIT 1");
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

  hasRunningWorkflows(): boolean {
    const row = this.hasRunningStmt.get();
    return !!row;
  }

  hasDuplicateRequest(request: string): boolean {
    const row = this.hasDuplicateStmt.get(request);
    return !!row;
  }

  values(): WorkflowState[] {
    const rows = this.valuesStmt.all() as { data: string }[];
    return rows.map(r => JSON.parse(r.data));
  }

  get size(): number {
    const row = this.sizeStmt.get() as { count: number };
    return row.count;
  }
}
