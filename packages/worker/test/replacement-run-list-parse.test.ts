import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ parse: vi.fn(), lock: vi.fn(async () => true) }));
vi.mock('@haive/shared/modularity', async (original) => {
  const actual = await original<typeof import('@haive/shared/modularity')>();
  return { ...actual, parseDerivedRunPlan: h.parse.mockImplementation(actual.parseDerivedRunPlan) };
});
vi.mock('../src/step-engine/step-ownership.js', async (original) => ({
  ...(await original<object>()),
  lockOwnedStep: h.lock,
}));
import { schema } from '@haive/database';
import { pinDerivedWorkflowPath } from '../src/step-engine/derived-path.js';
import { buildRunList, type ResolvedTaskContext } from '../src/queues/run-list.js';
import { stepRegistry, type StepRegistry } from '../src/step-engine/registry.js';
import { codeReviewStep } from '../src/step-engine/steps/workflow/08c-code-review.js';
import { rolePin, REVIEW, PRODUCER } from './replacement-fixtures.js';
import { CODE_REVIEW_OUTPUT_CONTRACT } from '@haive/shared/step-outputs';
it.each([1, 2] as const)(
  'parses a v%s pin once per build, preserving host policy',
  async (version) => {
    const pin = rolePin(version);
    vi.spyOn(stepRegistry, 'get').mockImplementation((id) =>
      id === REVIEW
        ? codeReviewStep
        : {
            metadata: { ...codeReviewStep.metadata, id },
            apply: async () => null,
            ...(id === PRODUCER
              ? { replaces: [REVIEW], outputContract: CODE_REVIEW_OUTPUT_CONTRACT }
              : {}),
          },
    );
    let validations = 0;
    Object.defineProperty(pin.derivedRunPlan, 'version', {
      get: () => {
        validations++;
        return version;
      },
    });
    h.parse(pin.derivedRunPlan);
    const once = validations;
    validations = 0;
    h.parse.mockClear();
    try {
      const list = await buildRunList(
        { ...pin, runListStrategy: 'derived' } as ResolvedTaskContext,
        {} as never,
      );
      expect(list.map((s) => s.metadata.id)).toEqual(pin.runListSnapshot);
      expect(h.parse).toHaveBeenCalledTimes(1);
      expect(validations).toBe(once);
      if (version === 2)
        expect(list.find((s) => s.metadata.id === PRODUCER)!.fixLoop).toBe(codeReviewStep.fixLoop);
    } finally {
      vi.restoreAllMocks();
    }
  },
);

it.each([1, 2] as const)('parses a v%s pin once while triage holds the rows', async (version) => {
  const pin = rolePin(version);
  const task = {
    ...pin,
    id: 'task',
    type: 'derived-example',
    currentStepId: '00-triage',
    currentRound: 0,
    orchestrationEpoch: 3,
    status: 'running',
    deadAt: null,
    broadAudit: false,
    customSteps: null,
  };
  const step = { id: 'row', taskId: task.id, stepId: '00-triage', round: 0 };
  const taskLock = vi.fn(async () => [task]);
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => (table === schema.taskSteps ? Promise.resolve([step]) : { for: taskLock }),
      }),
    }),
  };
  const db = {
    query: { tasks: { findFirst: async () => task } },
    transaction: async (fn: (handle: typeof tx) => unknown) => fn(tx),
  };
  const registry: Pick<StepRegistry, 'get'> = {
    get: (id: string) =>
      id === REVIEW
        ? codeReviewStep
        : {
            metadata: { ...codeReviewStep.metadata, id },
            apply: async () => null,
            ...(id === PRODUCER
              ? { replaces: [REVIEW], outputContract: CODE_REVIEW_OUTPUT_CONTRACT }
              : {}),
          },
  };
  h.parse.mockClear();
  h.lock.mockClear();
  expect(
    await pinDerivedWorkflowPath(
      { db, taskId: task.id, taskStepId: step.id, round: 0, epoch: 3 } as never,
      'full_workflow',
      true,
      registry,
    ),
  ).toEqual({ path: 'full_workflow', broadAudit: false });
  expect(h.lock).toHaveBeenCalledOnce();
  expect(taskLock).toHaveBeenCalledWith('no key update');
  expect(h.parse).toHaveBeenCalledTimes(1);
});
