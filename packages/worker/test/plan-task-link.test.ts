import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { eq } from 'drizzle-orm';
import { createFakeDb } from '@haive/database/testing';
import { applyPlanPatch, PlanPatchError } from '@haive/shared/plan';
import { logger } from '@haive/shared';
import { completePlanNodesForTask } from '../src/plan/task-link.js';
import { flushPlanMirrorForRepository } from '../src/plan/mirror.js';

vi.mock('@haive/shared/plan', async (original) => ({
  ...(await original<typeof import('@haive/shared/plan')>()),
  applyPlanPatch: vi.fn(),
}));
vi.mock('../src/plan/mirror.js', () => ({
  flushPlanMirrorForRepository: vi.fn(async () => ({ files: [], repoPath: null })),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function linkedTask() {
  const fake = createFakeDb({ planNodeTasks: schema.planNodeTasks, planNodes: schema.planNodes });
  fake.insert(schema.planNodeTasks, {
    taskId: '10000000-0000-4000-8000-000000000001',
    nodeId: '20000000-0000-4000-8000-000000000001',
    role: 'implements',
  });
  fake.insert(schema.planNodes, {
    id: '20000000-0000-4000-8000-000000000001',
    repositoryId: '30000000-0000-4000-8000-000000000001',
    parentId: null,
    path: '/20000000-0000-4000-8000-000000000001/',
    ordinal: 0,
    title: 'Task node',
    status: 'in_progress',
    version: 1,
  });
  return fake.db as unknown as Database;
}

describe('task completion beside a busy plan', () => {
  it('retries the same done patch when contention clears and then flushes', async () => {
    vi.useFakeTimers();
    vi.mocked(applyPlanPatch)
      .mockReset()
      .mockRejectedValueOnce(new PlanPatchError('busy', 'busy'))
      .mockResolvedValue({} as never);
    const done = completePlanNodesForTask(linkedTask(), '10000000-0000-4000-8000-000000000001');
    await vi.runAllTimersAsync();
    await done;
    expect(applyPlanPatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(applyPlanPatch).mock.lastCall?.[1]).toEqual({
      ops: [
        {
          op: 'upsert',
          nodeRef: '20000000-0000-4000-8000-000000000001',
          status: 'done',
          expectedVersion: 1,
        },
      ],
    });
    expect(flushPlanMirrorForRepository).toHaveBeenCalledOnce();
  });

  it('bounds persistent busy, logs the failure, and keeps task completion non-fatal', async () => {
    vi.useFakeTimers();
    vi.mocked(applyPlanPatch).mockReset().mockRejectedValue(new PlanPatchError('busy', 'busy'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const done = completePlanNodesForTask(linkedTask(), '10000000-0000-4000-8000-000000000001');
    await vi.runAllTimersAsync();
    await done;
    expect(applyPlanPatch).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          kind: 'busy',
          message: 'The plan stayed busy. Try again.',
        }),
      }),
      'plan node completion failed (non-fatal)',
    );
    expect(flushPlanMirrorForRepository).not.toHaveBeenCalled();
  });

  it('bounds persistent CAS conflicts and keeps completion non-fatal', async () => {
    vi.mocked(applyPlanPatch)
      .mockReset()
      .mockRejectedValue(new PlanPatchError('conflict', 'edited meanwhile'));
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await completePlanNodesForTask(linkedTask(), '10000000-0000-4000-8000-000000000001');
    expect(applyPlanPatch).toHaveBeenCalledTimes(3);
    expect(flushPlanMirrorForRepository).not.toHaveBeenCalled();
  });

  it('retries the mark after a concurrent edit using a fresh eligibility and version read', async () => {
    const db = linkedTask();
    vi.mocked(applyPlanPatch)
      .mockReset()
      .mockImplementationOnce(async () => {
        await db
          .update(schema.planNodes)
          .set({ version: 2 })
          .where(eq(schema.planNodes.id, '20000000-0000-4000-8000-000000000001'));
        throw new PlanPatchError('conflict', 'edited meanwhile');
      })
      .mockResolvedValue({} as never);
    await completePlanNodesForTask(db, '10000000-0000-4000-8000-000000000001');
    expect(applyPlanPatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(applyPlanPatch).mock.lastCall?.[1]).toMatchObject({
      ops: [{ status: 'done', expectedVersion: 2 }],
    });
    expect(flushPlanMirrorForRepository).toHaveBeenCalledOnce();
  });

  it('preserves a human verdict that lands before the retry', async () => {
    const db = linkedTask();
    vi.mocked(applyPlanPatch)
      .mockReset()
      .mockImplementationOnce(async () => {
        await db
          .update(schema.planNodes)
          .set({ status: 'blocked_human', version: 2 })
          .where(eq(schema.planNodes.id, '20000000-0000-4000-8000-000000000001'));
        throw new PlanPatchError('conflict', 'human verdict');
      });
    await completePlanNodesForTask(db, '10000000-0000-4000-8000-000000000001');
    expect(applyPlanPatch).toHaveBeenCalledOnce();
  });
});
