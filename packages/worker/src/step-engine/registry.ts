import { assertStepOutputDeclaration } from './step-output-contract.js';
import type { StepDefinition } from './step-definition.js';

/** A step id a task's data names that this install does not register: the task is dead, not failed. */
export class UnresolvedStepError extends Error {
  readonly ids: string[];
  constructor(ids: string[]) {
    super(ids.map((id) => `Step ${id} not registered`).join('; '));
    this.name = 'UnresolvedStepError';
    this.ids = ids;
  }
}

/** The physical producer is installed, but cannot execute its immutable pinned promise. */
export class PinnedStepSupportError extends UnresolvedStepError {
  readonly code = 'pinned-step-support-unavailable';
  constructor(id: string) {
    super([id]);
    this.name = 'PinnedStepSupportError';
    this.message = `pinned-step-support-unavailable: ${id} cannot execute its pinned output contract or host role policy. Restore compatible executable support; the task will not be remapped.`;
  }
}

export class StepRegistry {
  private byId = new Map<string, StepDefinition>();
  private byWorkflow = new Map<string, StepDefinition[]>();

  register(def: StepDefinition): void {
    assertStepOutputDeclaration(def);
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
    assertStepOutputDeclaration(def);
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
    if (!def) throw new UnresolvedStepError([id]);
    return def;
  }

  listByWorkflow(type: string): StepDefinition[] {
    return (this.byWorkflow.get(type) ?? []).slice();
  }

  all(): StepDefinition[] {
    return Array.from(this.byId.values());
  }
}

export const stepRegistry = new StepRegistry();
