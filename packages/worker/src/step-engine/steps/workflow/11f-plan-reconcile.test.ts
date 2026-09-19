import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { applyPlanPatch } from '@haive/shared/plan';
import type { StepApplyArgs, StepContext } from '../../step-definition.js';
import { planReconcileStep, type PlanReconcileDetect } from './11f-plan-reconcile.js';

vi.mock('@haive/shared/plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/plan')>();
  return { ...actual, applyPlanPatch: vi.fn() };
});
vi.mock('../../../plan/mirror.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../plan/mirror.js')>();
  return { ...actual, writePlanMirror: vi.fn(async () => {}) };
});

const NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ctx = {
  taskId: 't',
  taskStepId: 's',
  repoPath: '/tmp',
  db: {} as Database,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as StepContext;

const detected: PlanReconcileDetect = {
  repositoryId: 'r',
  planMarkdown: '# Plan',
  spec: '',
  changedPaths: ['src/billing/export.ts'],
  affected: [],
  nodeTitles: { [NODE]: 'Billing' },
  nodeCount: 2,
};

const OPS = {
  ops: [
    { op: 'upsert', nodeRef: NODE, status: 'done' },
    { op: 'upsert', nodeRef: GONE, status: 'done' },
  ],
};

const apply = (args: Partial<StepApplyArgs<PlanReconcileDetect>>) =>
  planReconcileStep.apply(ctx, {
    detected,
    formValues: {},
    ...args,
  } as StepApplyArgs<PlanReconcileDetect>);

const outcome = (over: {
  updated?: string[];
  dropped?: string[];
  strippedCodeLinks?: string[];
}) => ({
  created: [],
  updated: [],
  deleted: [],
  linked: 0,
  unlinked: 0,
  codeLinked: 0,
  refs: {},
  dropped: [],
  strippedCodeLinks: [],
  ...over,
});

describe('11f plan reconcile apply', () => {
  beforeEach(() => {
    vi.mocked(applyPlanPatch).mockReset();
  });

  it('says which approved change did not land instead of counting it', async () => {
    // A plan chat deleted GONE while the form sat parked, so the applier dropped it.
    // Before, only a log line said so and `applied` counted it.
    const gone = `upsert dropped: unknown node reference '${GONE}'`;
    vi.mocked(applyPlanPatch).mockResolvedValueOnce(outcome({ updated: [NODE], dropped: [gone] }));
    const out = await apply({ llmOutput: OPS, formValues: { applyOps: ['0', '1'] } });
    expect(out.decision).toBe('applied');
    expect(out.applied).toBe(1);
    expect(out.dropped).toEqual([gone]);
    expect(out.summary).toBe(
      'Applied 1 of 2 proposed plan change(s): 0 node(s) created, 1 updated, ' +
        `0 code link(s) written. 1 approved change(s) could not be applied: ${gone}.`,
    );
  });

  it('names a code link it could not record, and still counts its change as landed', async () => {
    const bad = `code link dropped from '${NODE}': repoPath: Invalid input: expected string, received undefined`;
    vi.mocked(applyPlanPatch).mockResolvedValueOnce(
      outcome({ updated: [NODE], strippedCodeLinks: [bad] }),
    );
    const out = await apply({ llmOutput: OPS, formValues: { applyOps: ['0'] } });
    expect(vi.mocked(applyPlanPatch).mock.lastCall?.[2]).toMatchObject({
      onInvalidCodeLink: 'strip',
    });
    expect(out.applied).toBe(1);
    expect(out).not.toHaveProperty('dropped');
    expect(out.summary).toBe(
      'Applied 1 of 2 proposed plan change(s): 0 node(s) created, 1 updated, ' +
        `0 code link(s) written. 1 code link(s) could not be recorded: ${bad}.`,
    );
  });

  it('summarises a clean apply with no dropped clause', async () => {
    vi.mocked(applyPlanPatch).mockResolvedValueOnce(outcome({ updated: [NODE] }));
    const out = await apply({ llmOutput: OPS, formValues: { applyOps: ['0'] } });
    expect(out.applied).toBe(1);
    expect(out).not.toHaveProperty('dropped');
    expect(out.summary).toBe(
      'Applied 1 of 2 proposed plan change(s): 0 node(s) created, 1 updated, 0 code link(s) written.',
    );
  });

  it('summarises a decline and applies nothing', async () => {
    const out = await apply({ llmOutput: OPS, formValues: { applyOps: [] } });
    expect(out.decision).toBe('declined');
    expect(out.applied).toBe(0);
    expect(out.summary).toBe('Declined all 2 proposed plan change(s).');
    expect(applyPlanPatch).not.toHaveBeenCalled();
  });

  it('summarises an empty proposal as nothing to do', async () => {
    const out = await apply({ llmOutput: { ops: [] } });
    expect(out.decision).toBe('nothing_to_do');
    expect(out.summary).toBe('The plan already describes what this task changed.');
  });

  it('summarises a task with no plan', async () => {
    const out = await apply({ detected: { ...detected, repositoryId: null }, llmOutput: OPS });
    expect(out.decision).toBe('nothing_to_do');
    expect(out.summary).toBe('No plan to reconcile.');
  });
});
