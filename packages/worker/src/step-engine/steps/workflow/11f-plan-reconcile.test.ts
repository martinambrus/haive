import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import {
  applyPlanPatch,
  findPlanRoot,
  loadPlanSkeletons,
  PlanPatchError,
  renderPlanMarkdown,
  renderPlanMarkdownFrom,
} from '@haive/shared/plan';
import type { StepApplyArgs, StepContext } from '../../step-definition.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import { planReconcileStep, type PlanReconcileDetect } from './11f-plan-reconcile.js';

vi.mock('@haive/shared/plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/plan')>();
  return {
    ...actual,
    applyPlanPatch: vi.fn(),
    findPlanRoot: vi.fn(),
    loadPlanSkeletons: vi.fn(),
    renderPlanMarkdown: vi.fn(),
  };
});
vi.mock('./_spec-artifact.js', () => ({
  resolveApprovedSpec: vi.fn(async () => ''),
  resolveTaskWorktreePath: vi.fn(async () => null),
}));
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

describe('11f plan reconcile — node versions', () => {
  const node = (id: string, title: string, version: number) =>
    ({
      id,
      parentId: null,
      path: '0001',
      ordinal: 0,
      title,
      kind: 'component',
      status: 'planned',
      taskable: false,
      version,
      createdBy: 'user',
      sourceTaskId: null,
      lastReviewedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      body: null,
    }) as never;

  it('shows the agent each node version, in the plan and in the affected list', async () => {
    const nodes = [node(NODE, 'Billing', 3)];
    vi.mocked(findPlanRoot).mockResolvedValueOnce({ id: NODE } as never);
    vi.mocked(loadPlanSkeletons).mockResolvedValueOnce(nodes);
    vi.mocked(renderPlanMarkdown).mockImplementationOnce(async (_db, _repo, opts) =>
      renderPlanMarkdownFrom(nodes, [], opts),
    );
    const db = {
      query: {
        tasks: { findFirst: async () => ({ repositoryId: 'r', changedPaths: ['src/a.ts'] }) },
      },
      select: () => ({ from: () => ({ where: async () => [{ nodeId: NODE }] }) }),
    } as unknown as Database;
    const d = await planReconcileStep.detect!({ ...ctx, db } as StepContext);
    const prompt = planReconcileStep.llm!.buildPrompt({ detected: d } as never) as string;
    expect(prompt).toContain('`version 3`');
    expect(prompt).toContain(`- Billing (\`node:${NODE}\` · \`version 3\`)`);
  });

  it('reports a conflict as a done step with nothing applied instead of throwing', async () => {
    vi.mocked(applyPlanPatch).mockRejectedValueOnce(
      new PlanPatchError('conflict', 'version mismatch', 0),
    );
    vi.mocked(writePlanMirror).mockClear();
    const out = await apply({ llmOutput: OPS, formValues: { applyOps: ['0'] } });
    expect(out.decision).toBe('conflict');
    expect(out.applied).toBe(0);
    expect(out.summary).toBe('The plan changed since this proposal; nothing applied.');
    expect(writePlanMirror).not.toHaveBeenCalled();
  });

  it('still throws any other patch error', async () => {
    vi.mocked(applyPlanPatch).mockRejectedValueOnce(new PlanPatchError('invalid', 'bad', 0));
    await expect(apply({ llmOutput: OPS, formValues: { applyOps: ['0'] } })).rejects.toThrow('bad');
  });
});
