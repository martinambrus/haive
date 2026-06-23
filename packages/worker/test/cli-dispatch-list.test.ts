import { describe, expect, it } from 'vitest';
import { CLI_DISPATCH_STEP_IDS } from '@haive/shared';
import { StepRegistry } from '../src/step-engine/registry.js';
import { registerAllSteps } from '../src/step-engine/steps/index.js';

/** CLI_DISPATCH_STEP_IDS (in @haive/shared) is the api/web mirror of "which steps
 *  dispatch a CLI" — it drives whether the step card renders the per-step CLI
 *  picker. The worker boot assertion (assertCliDispatchListInSync) enforces this,
 *  but lock it in CI too so a step gaining/losing an llm/agentMining/dagExecute
 *  field fails here rather than only at container startup. */
describe('CLI_DISPATCH_STEP_IDS', () => {
  it('matches the set of step definitions that dispatch a CLI', () => {
    const registry = new StepRegistry();
    // registerAllSteps runs assertCliDispatchListInSync internally; calling it
    // here would already throw on drift. The explicit comparison below gives a
    // readable diff when it does.
    registerAllSteps(registry);

    const actual = registry
      .all()
      .filter((d) => Boolean(d.llm || d.agentMining || d.dagExecute))
      .map((d) => d.metadata.id)
      .sort();
    const declared = [...CLI_DISPATCH_STEP_IDS].sort();

    expect(actual).toEqual(declared);
  });

  it('contains no step that lacks a CLI dispatch field', () => {
    const registry = new StepRegistry();
    registerAllSteps(registry);
    const byId = new Map(registry.all().map((d) => [d.metadata.id, d]));
    for (const id of CLI_DISPATCH_STEP_IDS) {
      const def = byId.get(id);
      expect(def, `CLI_DISPATCH_STEP_IDS lists unknown step "${id}"`).toBeDefined();
      expect(
        Boolean(def!.llm || def!.agentMining || def!.dagExecute),
        `step "${id}" is listed in CLI_DISPATCH_STEP_IDS but dispatches no CLI`,
      ).toBe(true);
    }
  });
});
