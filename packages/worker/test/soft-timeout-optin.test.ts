import { describe, expect, it } from 'vitest';
import { StepRegistry } from '../src/step-engine/registry.js';
import { registerAllSteps } from '../src/step-engine/steps/index.js';

/** Steps whose agents only READ and REPORT. Winding one down early costs a few
 *  unexplored leads; letting it hit the zero-grace SIGKILL costs every finding it
 *  already made. */
const SOFT_TIMEOUT_STEPS = new Set(['08c-code-review', '08d-adversarial-qa']);

describe('agentMining softTimeout opt-in', () => {
  const registry = new StepRegistry();
  registerAllSteps(registry);
  const mining = registry.all().filter((d) => d.agentMining);

  it('finds the mining steps at all (guards against a silent rename)', () => {
    expect(mining.length).toBeGreaterThanOrEqual(2);
    for (const id of SOFT_TIMEOUT_STEPS) {
      expect(mining.map((d) => d.metadata.id)).toContain(id);
    }
  });

  it('opts the reviewers in', () => {
    for (const id of SOFT_TIMEOUT_STEPS) {
      const def = mining.find((d) => d.metadata.id === id)!;
      expect(def.agentMining!.softTimeout, id).toBe(true);
    }
  });

  it('leaves every other mining step out', () => {
    // A mining agent that writes code, files or skills must fail LOUDLY on timeout.
    // Steering it to "emit your output now" would end it early with a plausible
    // result, and a truncated write that looks successful is worse than a kill.
    for (const def of mining) {
      if (SOFT_TIMEOUT_STEPS.has(def.metadata.id)) continue;
      expect(def.agentMining!.softTimeout ?? false, def.metadata.id).toBe(false);
    }
  });
});
