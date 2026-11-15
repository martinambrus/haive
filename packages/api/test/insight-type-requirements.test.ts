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
  const error = await definitionForCreate(
    fake.db as unknown as Parameters<typeof definitionForCreate>[0],
    'insights',
    { locked: false, generic: false },
  ).catch((error: unknown) => error);
  expect(error).toMatchObject({
    status: 409,
    message: expect.stringMatching(
      /08e-insights-triage requires earlier 08-phase-5-verify.*08c-code-review/,
    ),
  });
  expect((error as Error).message.match(/08e-insights-triage requires earlier/g)).toHaveLength(1);
});

import { DerivedTaskAdmissionError } from '../src/lib/derived-errors.js';
it('names the insight requirement in derived admission errors too', () => {
  const error = new DerivedTaskAdmissionError([
    {
      kind: 'invalid-composition',
      executionPath: 'full_workflow',
      issue: { kind: 'unmet-need', stepId: '08e-insights-triage', needs: 'review' },
    },
  ]);
  expect(error.message).toMatch(
    /08e-insights-triage requires earlier 08-phase-5-verify.*08c-code-review/,
  );
  expect(new DerivedTaskAdmissionError([{ kind: 'catalog-not-synced' }]).message).toBe(
    'The derived task type cannot be admitted',
  );
});

it('explains verification-before-review when derived insight admission refuses the order', () => {
  const error = new DerivedTaskAdmissionError([
    {
      kind: 'invalid-composition',
      executionPath: 'full_workflow',
      issue: {
        kind: 'need-out-of-order',
        stepId: '08e-insights-triage',
        needs: 'review',
        after: 'verification',
      },
    },
  ]);
  expect(error.message).toBe(
    '08e-insights-triage requires 08-phase-5-verify before 08c-code-review (or its pinned replacement) for insight continuations',
  );
});
