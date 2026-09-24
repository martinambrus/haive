import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { StepSupersededError, updateOwnedStep } from '../src/step-engine/step-ownership.js';

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
  it('writes the row only while it is not pending or skipped', async () => {
    const { db, seen } = mockDb([{ id: 'step1', status: 'failed' }]);
    const row = await updateOwnedStep(db, 'step1', { status: 'failed' });
    expect(row).toEqual({ id: 'step1', status: 'failed' });
    expect(conditionValues(seen.where)).toEqual(
      expect.arrayContaining(['step1', 'pending', 'skipped']),
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
