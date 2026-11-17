import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
      supportReason: expect.stringMatching(/\S/),
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

const pinned = ['skew-plan', 'skew-a', 'skew-b'];
for (const [index, id] of pinned.entries())
  stepRegistry.register({
    metadata: {
      id,
      workflowType: index === 1 ? 'module.fx' : 'workflow',
      index,
      title: id,
      description: 'skew test stub',
      requiresCli: false,
    },
    detect: async () => ({}),
    apply: async () => ({}),
    ...(index === 1
      ? {
          guardPredicates: {
            guard: { argsSchema: z.strictObject({}), evaluate: async () => true },
          },
        }
      : {}),
  } as StepDefinition);
const span = (over: Record<string, unknown> = {}) => ({
  id: 'work',
  firstStepId: 'skew-a',
  lastStepId: 'skew-b',
  predicateId: 'module.fx.guard',
  args: {},
  ...over,
});
const scoped = (executionContract: unknown, over: Record<string, unknown> = {}) => ({
  id: 'task',
  type: 'test',
  taskId: 'task',
  workflowType: 'test',
  runListStrategy: 'static' as const,
  runListSnapshot: pinned as string[] | null,
  currentStepId: null,
  customSteps: null,
  derivedRunPlan: null,
  executionContract,
  ...over,
});
it('a permissive shared admission accepts the supported guarded shape in the worker', async () => {
  const task = scoped({ version: 1, guardedSpans: [span()] });
  const list = await buildRunList(task as never, {} as never);
  expect(list.map((step) => step.metadata.id)).toEqual(pinned);
  expect(deadTaskResolution(task, 'static').supportReason).toBeUndefined();
});
it.each([
  [
    'a custom fix target on a supported span',
    { version: 1, guardedSpans: [span()], fixTarget: { stepId: 'skew-a', capabilityVersion: 1 } },
    {},
  ],
  [
    'an unregistered predicate',
    { version: 1, guardedSpans: [span({ predicateId: 'module.fx.missing' })] },
    {},
  ],
  ['a derived strategy', { version: 1, guardedSpans: [span()] }, { runListStrategy: 'derived' }],
  [
    'a workflow_paths strategy',
    { version: 1, guardedSpans: [span()] },
    { runListStrategy: 'workflow_paths' },
  ],
  [
    'a run_app_modes strategy',
    { version: 1, guardedSpans: [span()] },
    { runListStrategy: 'run_app_modes' },
  ],
  [
    'a derived run plan',
    { version: 1, guardedSpans: [span()] },
    { derivedRunPlan: { version: 2, candidates: [] } },
  ],
  ['no run list snapshot', { version: 1, guardedSpans: [span()] }, { runListSnapshot: null }],
  [
    'an entry at the first index',
    { version: 1, guardedSpans: [span({ firstStepId: 'skew-plan', lastStepId: 'skew-a' })] },
    {},
  ],
])('a permissive shared admission never widens the worker: %s', async (_name, contract, over) => {
  const task = scoped(contract, over);
  await expect(buildRunList(task as never, {} as never)).rejects.toMatchObject({
    code: 'invalid-execution-contract',
  });
  const resolution = deadTaskResolution(task, task.runListStrategy);
  expect(resolution.supportReason).toMatch(/\S/);
  expect(resolution.unresolved).toEqual([]);
});
