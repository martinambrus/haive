import type { StepDefinition } from './step-definition.js';
import type { WorkflowType } from '@haive/shared';

export class StepRegistry {
  private byId = new Map<string, StepDefinition>();
  private byWorkflow = new Map<WorkflowType, StepDefinition[]>();

  register(def: StepDefinition): void {
    const meta = def.metadata;
    if (this.byId.has(meta.id)) {
      throw new Error(`Step ${meta.id} already registered`);
    }
    this.byId.set(meta.id, def);
    const list = this.byWorkflow.get(meta.workflowType) ?? [];
    list.push(def);
    list.sort((a, b) => a.metadata.index - b.metadata.index);
    this.byWorkflow.set(meta.workflowType, list);
  }

  override(def: StepDefinition): void {
    const meta = def.metadata;
    this.byId.set(meta.id, def);
    const list = this.byWorkflow.get(meta.workflowType) ?? [];
    const idx = list.findIndex((d) => d.metadata.id === meta.id);
    if (idx >= 0) {
      list[idx] = def;
    } else {
      list.push(def);
    }
    list.sort((a, b) => a.metadata.index - b.metadata.index);
    this.byWorkflow.set(meta.workflowType, list);
  }

  get(id: string): StepDefinition | undefined {
    return this.byId.get(id);
  }

  require(id: string): StepDefinition {
    const def = this.byId.get(id);
    if (!def) throw new Error(`Step ${id} not registered`);
    return def;
  }

  listByWorkflow(type: WorkflowType): StepDefinition[] {
    return (this.byWorkflow.get(type) ?? []).slice();
  }

  all(): StepDefinition[] {
    return Array.from(this.byId.values());
  }
}

export const stepRegistry = new StepRegistry();
