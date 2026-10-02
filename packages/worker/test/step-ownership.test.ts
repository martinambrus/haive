import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const stamp = vi.hoisted(() => `tree:${'ab'.repeat(20)}`);
vi.mock('../src/build-stamp.js', () => ({ currentBuildStamp: () => stamp }));

import {
  StepSupersededError,
  insertOwnedRun,
  lockOwnedStep,
  updateOwnedStep,
} from '../src/step-engine/step-ownership.js';

/** Values a drizzle condition binds, in order. */
function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) conditionValues(item, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) acc.push(obj.value);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionValues(c, acc);
  return acc;
}

function mockDb(returned: unknown[]) {
  const seen: { set?: Record<string, unknown>; where?: unknown } = {};
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        seen.set = patch;
        return {
          where: (cond: unknown) => {
            seen.where = cond;
            return { returning: async () => returned };
          },
        };
      },
    }),
  } as unknown as Database;
  return { db, seen };
}

describe('updateOwnedStep', () => {
  it('writes the row only while it is not pending, skipped or failed', async () => {
    const { db, seen } = mockDb([{ id: 'step1', status: 'failed' }]);
    const row = await updateOwnedStep(db, 'step1', { status: 'failed' });
    expect(row).toEqual({ id: 'step1', status: 'failed' });
    // A Stop fails the row without moving the task's epoch, so a pass must not finish over it.
    expect(conditionValues(seen.where)).toEqual(
      expect.arrayContaining(['step1', 'pending', 'skipped', 'failed']),
    );
    expect(seen.set).toMatchObject({ status: 'failed' });
    expect(seen.set?.updatedAt).toBeInstanceOf(Date);
  });

  it('throws StepSupersededError when a Retry or a Skip took the row', async () => {
    const { db } = mockDb([]);
    await expect(updateOwnedStep(db, 'step1', { status: 'failed' })).rejects.toBeInstanceOf(
      StepSupersededError,
    );
  });
});

function lockDb(returned: unknown[]) {
  const seen: { where?: unknown; strength?: unknown } = {};
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          seen.where = cond;
          return {
            for: async (strength: unknown) => {
              seen.strength = strength;
              return returned;
            },
          };
        },
      }),
    }),
  } as unknown as Database;
  return { db, seen };
}

describe('lockOwnedStep', () => {
  it('locks the row for update only while it is not pending, skipped or failed', async () => {
    const { db, seen } = lockDb([{ id: 'step1' }]);
    expect(await lockOwnedStep(db, 'step1')).toBe(true);
    expect(seen.strength).toBe('update');
    expect(conditionValues(seen.where)).toEqual(
      expect.arrayContaining(['step1', 'pending', 'skipped', 'failed']),
    );
  });

  it('answers false once a Retry or a Skip took the row', async () => {
    const { db } = lockDb([]);
    expect(await lockOwnedStep(db, 'step1')).toBe(false);
  });
});

function runDb() {
  const inserted: Record<string, unknown>[] = [];
  const tx = {
    select: lockDb([{ id: 'step1' }]).db.select,
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(row);
          return [{ id: 'run1', ...row }];
        },
      }),
    }),
  };
  const db = {
    transaction: async <T>(fn: (handle: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as Database;
  return { db, inserted };
}

describe('insertOwnedRun', () => {
  const values = { taskId: 'task1', taskStepId: 'step1', mode: 'cli', prompt: 'p' } as const;

  it('stamps the build on the run it records', async () => {
    const { db, inserted } = runDb();
    const run = await insertOwnedRun(db, 'step1', values);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.haiveBuild).toBe(stamp);
    expect(run.haiveBuild).toBe(stamp);
  });

  it('keeps the stamp whatever the caller passes', async () => {
    const { db, inserted } = runDb();
    await insertOwnedRun(db, 'step1', { ...values, haiveBuild: null });
    expect(inserted[0]!.haiveBuild).toBe(stamp);
  });
});
