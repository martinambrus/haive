import { beforeEach, describe, expect, it, vi } from 'vitest';

const { applyPlanPatch } = vi.hoisted(() => ({ applyPlanPatch: vi.fn() }));

vi.mock('@haive/shared/plan', () => ({ applyPlanPatch }));

// logger is imported for-real by the unit under test; spy so the expected
// warn path does not print noise into the test run.
vi.mock('@haive/shared', () => ({ logger: { warn: vi.fn() } }));

const db = {} as never;

import { markPlanNodeTaskable } from '../src/lib/mark-plan-node-taskable.js';

describe('markPlanNodeTaskable', () => {
  beforeEach(() => {
    applyPlanPatch.mockReset();
  });

  it('writes the flag with the version it read', async () => {
    applyPlanPatch.mockResolvedValueOnce(undefined);
    await expect(
      markPlanNodeTaskable(db, { id: 'n1', taskable: false, version: 4 }, 'r1'),
    ).resolves.toBe(true);
    expect(applyPlanPatch).toHaveBeenCalledWith(
      db,
      {
        ops: [{ op: 'upsert', nodeRef: 'n1', expectedVersion: 4, taskable: true }],
      },
      { repositoryId: 'r1', origin: 'user' },
    );
  });

  it('skips the write when the node is already taskable', async () => {
    await expect(
      markPlanNodeTaskable(db, { id: 'n1', taskable: true, version: 4 }, 'r1'),
    ).resolves.toBe(false);
    expect(applyPlanPatch).not.toHaveBeenCalled();
  });

  it('never fails the task creation — a lost version race only warns', async () => {
    applyPlanPatch.mockRejectedValueOnce(new Error('modified by someone else'));
    await expect(
      markPlanNodeTaskable(db, { id: 'n1', taskable: false, version: 4 }, 'r1'),
    ).resolves.toBe(false);
  });
});
