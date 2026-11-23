import { expect, it } from 'vitest';
import {
  assertExecutionContractSupported,
  resolveTaskTypeAvailability,
} from '../src/modularity/index.js';

const target = 'module.fx.repair';
const pin = { version: 1, guardedSpans: [], fixTarget: { stepId: target, capabilityVersion: 1 } };
it('a fix-target-only pin needs a static list even without guarded spans', () => {
  expect(() => assertExecutionContractSupported(pin, { staticPinnedList: false })).toThrow(
    /static/,
  );
});
it.each(['derived', 'workflow_paths', 'run_app_modes'] as const)(
  '%s definitions refuse a fix-target-only contract by the static-list rule',
  (runListStrategy) => {
    expect(
      resolveTaskTypeAvailability({
        definition: {
          source: 'admin',
          enabled: true,
          selectable: true,
          runListStrategy,
          stepIds: [target],
          requiresRepository: false,
          executionContract: pin,
        },
        switches: { customEnabled: true, moduleEnabled: true },
        modules: null,
        catalog: null,
        generic: true,
        derived: { stepIds: [target], valid: true },
      }),
    ).toMatchObject({
      available: false,
      reason: 'invalid-composition',
      issues: [{ kind: 'invalid-execution-contract', reason: expect.stringMatching(/static/) }],
    });
  },
);
