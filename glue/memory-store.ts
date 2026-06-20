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

  get size(): number {
    return this.map.size;
  }
}
