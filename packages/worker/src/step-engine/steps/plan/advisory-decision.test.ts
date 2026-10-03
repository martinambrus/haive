import { describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { advisoryDecisionStep } from './02-advisory-decision.js';
import type { StepContext } from '../../step-definition.js';

vi.mock('../../../plan/mirror.js', () => ({ writePlanMirror: vi.fn() }));

const REPO = '00000000-0000-4000-8000-0000000000c1';
const NODE = '00000000-0000-4000-8000-0000000000d1';
const TASK = '00000000-0000-4000-8000-0000000000e1';

function fixture(version = 1, body = 'Original question', status = 'todo') {
  const fake = createFakeDb({
    planNodes: schema.planNodes,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.planNodes, {
    id: NODE,
    repositoryId: REPO,
    parentId: null,
    path: `/${NODE}/`,
    title: 'Question',
    kind: 'decision',
    taskable: false,
    ordinal: 0,
    version,
    body,
    status,
  });
  const ctx = {
    db: fake.db,
    taskId: TASK,
    repoPath: '/tmp/unused-advisory',
    logger: { warn: vi.fn() },
  } as unknown as StepContext;
  const args = {
    detected: {
      repositoryId: REPO,
      nodeId: NODE,
      nodeTitle: 'Question',
      nodeVersion: 1,
      nodeBody: 'Original question',
      findings: 'Research findings',
      options: [],
    },
    formValues: { decision: 'An advisory answer', status: 'done', writeFindings: true },
    llmOutput: null,
    iteration: 0,
    previousIterations: [],
  };
  return { fake, ctx, args };
}

describe('an advisory decision parked while the plan changes', () => {
  it('rejects a stale form without erasing a direct human answer or its status', async () => {
    const { fake, ctx, args } = fixture(
      2,
      'Original question\n\n## Decision\n\nThe direct human answer.',
      'done',
    );
    await expect(advisoryDecisionStep.apply(ctx, args)).rejects.toMatchObject({ kind: 'conflict' });
    expect(fake.rows(schema.planNodes)[0]).toMatchObject({
      version: 2,
      status: 'done',
      body: 'Original question\n\n## Decision\n\nThe direct human answer.',
    });
    expect(fake.rows(schema.planMirrorState)).toHaveLength(0);
  });

  it('records findings and the decision when the question has not changed', async () => {
    const { fake, ctx, args } = fixture();
    await expect(advisoryDecisionStep.apply(ctx, args)).resolves.toMatchObject({
      status: 'done',
      bodyWritten: true,
    });
    expect(fake.rows(schema.planNodes)[0]).toMatchObject({
      version: 2,
      status: 'done',
      body: 'Original question\n\n## Research\n\nResearch findings\n\n## Decision\n\nAn advisory answer',
    });
  });
});
