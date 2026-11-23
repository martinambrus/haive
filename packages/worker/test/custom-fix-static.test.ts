import { expect, it } from 'vitest';
import { assertWorkerExecutionContractSupported } from '../src/step-engine/execution-contract-support.js';

const target = 'module.fx.repair';
const pin = { version: 1, guardedSpans: [], fixTarget: { stepId: target, capabilityVersion: 1 } };
it.each(['derived', 'workflow_paths', 'run_app_modes'] as const)(
  '%s refuses a target without spans by the static-list rule',
  (runListStrategy) => {
    expect(() =>
      assertWorkerExecutionContractSupported(pin, { runListStrategy, runListSnapshot: [target] }),
    ).toThrow(/static/);
  },
);
it.each([null, [target, target]].map((runListSnapshot) => ({ runListSnapshot })))(
  'refuses a missing or duplicate static snapshot: $runListSnapshot',
  ({ runListSnapshot }) => {
    expect(() =>
      assertWorkerExecutionContractSupported(pin, { runListStrategy: 'static', runListSnapshot }),
    ).toThrow(/unique pinned/);
  },
);
it('refuses a derived plan even with a static strategy', () => {
  expect(() =>
    assertWorkerExecutionContractSupported(pin, {
      runListStrategy: 'static',
      runListSnapshot: [target],
      derivedRunPlan: {},
    }),
  ).toThrow(/static/);
});
