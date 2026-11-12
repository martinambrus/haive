import { describe, expect, it, vi } from 'vitest';
import { safeErrorMessage } from '@haive/shared/logger';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { ddevEnvStep } from '../src/step-engine/steps/workflow/01c-ddev-env.js';
import { restoreDatabaseStep } from '../src/step-engine/steps/workflow/01c1-restore-database.js';

vi.mock('../src/step-engine/steps/workflow/_task-meta.js', () => ({
  resolveDdevWorkspace: async () => null,
}));
vi.mock('../src/step-engine/steps/env-replicate/_shared.js', () => ({
  getTaskEnvTemplate: async () => null,
}));

describe.each([
  ['01c-ddev-env', ddevEnvStep],
  ['01c1-restore-database', restoreDatabaseStep],
] as const)('%s snapshot initialization', (_name, step) => {
  function context(error: Error) {
    const task = { id: 'task', repositoryId: 'repo', userId: 'user', dbUploadId: null };
    const transaction = vi.fn().mockRejectedValue(error);
    const db = {
      query: { tasks: { findFirst: async () => task } },
      transaction,
    };
    return { ctx: { db, taskId: task.id, repoPath: null } as unknown as StepContext, transaction };
  }

  it.each([false, true])('maps lock contention to a retry sentence (bound: %s)', async (bound) => {
    const driver = Object.assign(new Error('driver lock detail'), { code: '55P03' });
    const error = bound
      ? Object.assign(new Error('query detail', { cause: driver }), { params: ['secret'] })
      : driver;
    const { ctx, transaction } = context(error);

    const failure = await step.detect!(ctx).catch((err: unknown) => err);

    expect(transaction).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(Error);
    expect(safeErrorMessage(failure)).toBe('Saved database is busy. Retry this step in a moment.');
    expect(failure).not.toHaveProperty('cause');
  });

  it('preserves unrelated failures by identity', async () => {
    const error = Object.assign(new Error('connection failed'), { code: '08006' });
    const { ctx, transaction } = context(error);

    await expect(step.detect!(ctx)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledOnce();
  });
});
