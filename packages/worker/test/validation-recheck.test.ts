import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';
import { validationSuccessor } from '../src/queues/validation-recheck.js';

const h = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('../src/step-engine/steps/workflow/_validation-snapshot.js', async (original) => ({
  ...(await original<typeof import('../src/step-engine/steps/workflow/_validation-snapshot.js')>()),
  readValidationSnapshot: h.snapshot,
}));

const VALIDATE = '07b-phase-4-validate';
const RECONCILE = '07c-ddev-reconcile';
const step = (id: string) => ({ metadata: { id } }) as StepDefinition;
const ctx = { taskId: 'task' } as ResolvedTaskContext;

describe('validation successor runtime hand-off', () => {
  it.each([0, 1])(
    'reconciles a validator fixer at round %s and keeps its return address',
    async (round) => {
      const steps = [step(RECONCILE), step(VALIDATE), step('verify'), step('commit')];
      const db = {
        query: {
          taskEvents: {
            findFirst: vi.fn().mockResolvedValue(
              round
                ? {
                    payload: { resumeStepId: 'commit' },
                  }
                : undefined,
            ),
          },
        },
      } as unknown as Database;
      h.snapshot.mockResolvedValue({ '.ddev/config.yaml': 'after' });
      expect(
        await validationSuccessor(db, ctx, VALIDATE, round, steps, {
          runtimeChanged: true,
          validationSnapshot: { '.ddev/config.yaml': 'before' },
        }),
      ).toEqual({
        next: steps[0],
        round: round + 1,
        recheck: {
          resumeStepId: round ? 'commit' : 'verify',
          affectedFiles: ['.ddev/config.yaml'],
        },
      });
    },
  );

  it.each([{ tail: [] }, { tail: [step(RECONCILE)] }])(
    'refuses a runtime change without an earlier reconciliation step: %j',
    async ({ tail }) => {
      const steps = [step(VALIDATE), ...tail, step('commit')];
      await expect(
        validationSuccessor({} as Database, ctx, VALIDATE, 0, steps, {
          runtimeChanged: true,
        }),
      ).rejects.toThrow('run list must place 07c-ddev-reconcile before 07b-phase-4-validate');
    },
  );
});
