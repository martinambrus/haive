import { it, expect, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { definitionForCreate } from '../src/lib/task-type-definition.js';

vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true },
}));

it('names the earlier verification and review required by a stored insight type', async () => {
  const fake = createFakeDb({
    taskTypeDefinitions: schema.taskTypeDefinitions,
    stepCatalog: schema.stepCatalog,
  });
  fake.insert(schema.taskTypeDefinitions, {
    slug: 'insights',
    displayName: 'Insights',
    source: 'admin',
    enabled: true,
    selectable: true,
    requiresRepository: true,
    runListStrategy: 'static',
    stepIds: ['08e-insights-triage'],
  });
  fake.insert(schema.stepCatalog, {
    stepId: '08e-insights-triage',
    source: 'core',
    title: 'Insights',
    workflowType: 'workflow',
    stepIndex: 8.95,
    composable: true,
    entry: {
      stepId: '08e-insights-triage',
      label: 'Insights',
      group: 'check',
      dispatchesCli: true,
      requires: [
        { needs: 'verification', reason: 'Revises through verification.' },
        { needs: 'review', reason: 'Revises through code review.' },
      ],
      provides: [],
      loopTargetStepId: '08-phase-5-verify',
    },
  });
  await expect(
    definitionForCreate(
      fake.db as unknown as Parameters<typeof definitionForCreate>[0],
      'insights',
      { generic: false },
    ),
  ).rejects.toMatchObject({
    status: 409,
    message: expect.stringMatching(
      /08e-insights-triage requires earlier 08-phase-5-verify.*08c-code-review/,
    ),
  });
});
