import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { CHECK_RESULT_ROLES, SPEC_ROLES, STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import type { StepDefinition } from '@haive/shared/step';
import { advanceStep } from '../src/step-engine/step-runner.js';

it.each([
  ...['module.ports.check', 'custom.ports.check', 'core-check'].map((stepId) => ({
    stepId,
    role: SPEC_ROLES.checked,
    invalidOnly: false,
  })),
  ...Object.values(CHECK_RESULT_ROLES).map((role) => ({
    stepId: `module.check.${role.split('.').at(-1)}`,
    role,
    invalidOnly: true,
  })),
])(
  'validates role-only producer $stepId through advanceStep before fix-loop routing',
  async ({ stepId, role, invalidOnly }) => {
    for (const valid of invalidOnly ? [false] : [false, true]) {
      const fake = createFakeDb({
        tasks: schema.tasks,
        taskSteps: schema.taskSteps,
        modules: schema.modules,
        cliInvocations: schema.cliInvocations,
        taskEvents: schema.taskEvents,
      });
      const taskId = randomUUID(),
        userId = randomUUID(),
        taskStepId = randomUUID();
      fake.insert(schema.tasks, {
        id: taskId,
        userId,
        status: 'running',
        currentStepId: stepId,
        currentRound: 0,
        orchestrationEpoch: 0,
        autoContinue: true,
      });
      fake.insert(schema.taskSteps, {
        id: taskStepId,
        taskId,
        stepId,
        status: 'running',
        round: 0,
        runSeq: 0,
        detectOutput: {},
        formValues: {},
        iterationCount: 0,
        iterations: [],
        startedAt: new Date(),
        endedAt: null,
        output: null,
      });
      const output = { spec: valid ? 'checked spec' : 123 };
      const apply = vi.fn(async () => output);
      const fixLoop = vi.fn(() => null);
      const stepDef: StepDefinition = {
        metadata: {
          id: stepId,
          title: 'Check',
          description: '',
          workflowType: 'workflow',
          index: 0,
          requiresCli: false,
        },
        providesRoles: [{ role, contract: STEP_ROLE_REGISTRY[role].contract }],
        fixLoopOnError: true,
        fixLoop: { evaluate: fixLoop },
        apply,
      };
      const result = await advanceStep({
        db: fake.db as unknown as Database,
        taskId,
        userId,
        repoPath: '/tmp',
        workspacePath: '/tmp',
        cliProviderId: null,
        providers: [],
        stepDef,
        runSeq: 0,
      });
      expect(apply).toHaveBeenCalledOnce();
      expect(result.status).toBe(valid ? 'done' : 'failed');
      const stored = fake.rows(schema.taskSteps)[0]!;
      expect(stored.status).toBe(valid ? 'done' : 'failed');
      if (valid) expect(stored.output).toEqual(output);
      else {
        expect(result).toMatchObject({
          error: expect.stringContaining('step-output-contract-invalid'),
        });
        expect(stored.errorMessage).toContain(`${STEP_ROLE_REGISTRY[role].contract.id}@1`);
        expect(stored.output).toBeNull();
        expect(fixLoop).not.toHaveBeenCalled();
      }
    }
  },
);
