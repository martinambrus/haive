import { afterEach, expect, it, vi } from 'vitest';
// Model a newer API/shared admission policy alongside a worker whose runtime
// has not been activated. Local worker support must decide independently.
vi.mock('@haive/shared/modularity', async (original) => ({
  ...(await original<typeof import('@haive/shared/modularity')>()),
  assertExecutionContractSupported: () => {},
}));
import { buildRunList } from '../src/queues/run-list.js';
import { deadTaskResolution } from '../src/queues/dead-task-boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '@haive/shared/step';
afterEach(() => vi.restoreAllMocks());
const guarded = {
  version: 1,
  guardedSpans: [
    {
      id: 'work',
      firstStepId: 'a',
      lastStepId: 'a',
      predicateId: 'module.fx.guard',
      args: {},
    },
  ],
};
it.each([
  guarded,
  { version: 1, guardedSpans: [], fixTarget: { stepId: 'a', capabilityVersion: 1 } },
])(
  'refuses an admitted pin at run-list construction and boot/revival despite permissive shared admission: %j',
  async (executionContract) => {
    const step = { metadata: { id: 'a' } } as StepDefinition;
    vi.spyOn(stepRegistry, 'get').mockReturnValue(step);
    const task = {
      id: 'task',
      type: 'test',
      taskId: 'task',
      workflowType: 'test',
      runListStrategy: 'static' as const,
      runListSnapshot: ['a'],
      currentStepId: 'a',
      customSteps: null,
      executionContract,
    };
    const before = structuredClone(task);
    await expect(buildRunList(task as never, {} as never)).rejects.toMatchObject({
      code: 'invalid-execution-contract',
    });
    expect(deadTaskResolution(task, 'static')).toMatchObject({
      supportReason: expect.stringContaining('not yet supported by this worker'),
    });
    expect(task).toEqual(before);
  },
);
it.each([null, { version: 1, guardedSpans: [] }])(
  'worker-first deployment retains ordinary pins: %j',
  async (executionContract) => {
    const step = { metadata: { id: 'a' } } as StepDefinition;
    vi.spyOn(stepRegistry, 'get').mockReturnValue(step);
    await expect(
      buildRunList(
        {
          workflowType: 'test',
          runListStrategy: 'static',
          runListSnapshot: ['a'],
          executionContract,
        } as never,
        {} as never,
      ),
    ).resolves.toEqual([step]);
  },
);
