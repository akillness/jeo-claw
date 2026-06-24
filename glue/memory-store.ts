import type { WorkflowState } from "./contract";
import type { WorkflowStore } from "./store";

export class MemoryWorkflowStore implements WorkflowStore {
  private map = new Map<string, WorkflowState>();

  get(id: string): WorkflowState | undefined {
    return this.map.get(id);
  }

  set(id: string, state: WorkflowState): void {
    this.map.set(id, state);
  }

  delete(id: string): void {
    this.map.delete(id);
  }

  values(): WorkflowState[] {
    return Array.from(this.map.values());
  }
  values(): WorkflowState[] {
    return Array.from(this.map.values());
  }

  hasDuplicateRequest(request: string): boolean {
    for (const w of this.map.values()) {
      if (w.request === request && (w.status === "queued" || w.status === "pending" || w.status === "running" || w.status === "awaiting-approval")) {
        return true;
      }
    }
    return false;
  }

  get size(): number {
    return this.map.size;
  }
}
