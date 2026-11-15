import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerModuleSteps } from '../src/modules/loader.js';
import { StepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '@haive/shared/step';
import { validateComposition } from '@haive/shared/modularity';
import { buildRunList } from '../src/queues/run-list.js';
const evaluate = vi.fn(async () => true);
const composable = {
  stepId: 'fix',
  label: 'Fix',
  group: 'test',
  requires: [],
  provides: [],
  dispatchesCli: false,
  fixConsumer: { version: 1 as const },
};
const def = {
  metadata: {
    id: 'fix',
    title: 'Fix',
    workflowType: 'test',
    index: 1,
    description: 'Test fix consumer',
    requiresCli: false,
  },
  detect: async () => ({}),
  form: () => ({ title: 'Fix', fields: [] }),
  apply: async () => ({}),
  fixConsumer: { version: 1 as const },
  guardPredicates: { planned: { argsSchema: z.strictObject({}), evaluate } },
} as StepDefinition;
function load(step = def, entry: unknown = composable) {
  return registerModuleSteps(new StepRegistry(), [
    {
      packageName: '@haive/module-fx',
      manifest: {
        id: 'fx',
        name: 'Fx',
        version: '1.0.0',
        schemaVersion: 1,
        composableSteps: [entry, { ...composable, stepId: 'report', fixConsumer: undefined }],
      },
      steps: [
        step,
        {
          ...def,
          metadata: { ...def.metadata, id: 'report' },
          fixConsumer: undefined,
          guardPredicates: undefined,
        },
      ],
    },
  ])[0]!;
}
it('registers trusted code and exact fix capability; validation never evaluates predicates', () => {
  const module = load();
  expect(module.composable[0]?.fixConsumer).toEqual({ version: 1 });
  expect(module.predicates?.has('module.fx.planned')).toBe(true);
  const contract = {
    version: 1,
    guardedSpans: [
      {
        id: 'a',
        firstStepId: 'module.fx.fix',
        lastStepId: 'module.fx.fix',
        predicateId: 'module.fx.planned',
        args: {},
      },
    ],
    fixTarget: { stepId: 'module.fx.fix', capabilityVersion: 1 },
  };
  expect(
    validateComposition(module.stepIds, new Map(module.composable.map((e) => [e.stepId, e])), {
      executionContract: contract,
      predicates: module.predicates,
    }),
  ).toEqual([]);
  expect(evaluate).not.toHaveBeenCalled();
});
it('refuses forged catalog capability, missing declarations and unsupported versions', () => {
  expect(() => load({ ...def, fixConsumer: undefined })).toThrow('fix-consumer');
  const { fixConsumer: _capability, ...without } = composable;
  expect(() => load(def, without)).toThrow('fix-consumer');
  expect(() => load({ ...def, fixConsumer: { version: 2 } } as unknown as StepDefinition)).toThrow(
    'fix-consumer',
  );
});
it('refuses declarative predicates without executable trusted code', () => {
  const bad = {
    ...def,
    guardPredicates: { planned: { argsSchema: z.strictObject({}) } },
  } as unknown as StepDefinition;
  expect(() => load(bad)).toThrow('executable predicate');
});
it('refuses active or malformed pins before constructing a worker run list', async () => {
  for (const executionContract of [
    { version: 1, guardedSpans: [], fixTarget: { stepId: 'module.fx.fix', capabilityVersion: 1 } },
    { version: 99 },
  ]) {
    const task = {
      id: 't',
      type: 'workflow',
      taskId: 't',
      currentStepId: null,
      runListSnapshot: ['module.fx.fix'],
      customSteps: {},
      executionContract,
    };
    await expect(buildRunList(task as never, {} as never)).rejects.toThrow(
      'invalid-execution-contract',
    );
  }
});

it('rejects the actual core cleanup on the feasible zero-merge path', () => {
  const ids = ['01-worktree-setup', '10-gate-3-commit', '12-worktree-cleanup'];
  const catalog = new Map(CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e]));
  const span = (id: string, step: string, predicateId: string) => ({
    id,
    firstStepId: step,
    lastStepId: step,
    predicateId,
    args: {},
  });
  const executionContract = {
    version: 1,
    guardedSpans: [
      span('planned', ids[0]!, 'module.fx.planned'),
      { ...span('merged', ids[1]!, 'module.fx.merged'), requiresSpan: 'planned' },
      span('cleanup', ids[2]!, 'module.fx.planned'),
    ],
  };
  expect(
    validateComposition(ids, catalog, {
      executionContract,
      predicates: new Map([
        ['module.fx.planned', { argsSchema: z.strictObject({}) }],
        ['module.fx.merged', { argsSchema: z.strictObject({}) }],
      ]),
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '12-worktree-cleanup',
        needs: 'commit',
      }),
    ]),
  );
});
