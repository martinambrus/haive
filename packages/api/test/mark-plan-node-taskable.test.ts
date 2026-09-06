import { beforeEach, describe, expect, it, vi } from 'vitest';

const { applyPlanPatch } = vi.hoisted(() => ({ applyPlanPatch: vi.fn() }));

vi.mock('@haive/shared/plan', () => ({ applyPlanPatch }));

// logger is imported for-real by the unit under test; spy so the expected
// warn path does not print noise into the test run.
vi.mock('@haive/shared', () => ({ logger: { warn: vi.fn() } }));

const db = {} as never;

import { markPlanNodesTaskable } from '../src/lib/mark-plan-node-taskable.js';

describe('markPlanNodesTaskable', () => {
  beforeEach(() => {
    applyPlanPatch.mockReset();
  });

  it('writes the flag with the version it read', async () => {
    applyPlanPatch.mockResolvedValueOnce(undefined);
    await expect(
      markPlanNodesTaskable(db, [{ id: 'n1', taskable: false, version: 4 }], 'r1'),
    ).resolves.toBe(true);
    expect(applyPlanPatch).toHaveBeenCalledWith(
      db,
      {
        ops: [{ op: 'upsert', nodeRef: 'n1', expectedVersion: 4, taskable: true }],
      },
      { repositoryId: 'r1', origin: 'user' },
    );
  });

  it('marks a whole set in ONE patch, not one call per node', async () => {
    applyPlanPatch.mockResolvedValueOnce(undefined);
    await expect(
      markPlanNodesTaskable(
        db,
        [
          { id: 'n1', taskable: false, version: 4 },
          { id: 'n2', taskable: false, version: 9 },
        ],
        'r1',
      ),
    ).resolves.toBe(true);
    expect(applyPlanPatch).toHaveBeenCalledTimes(1);
    expect(applyPlanPatch.mock.calls[0]?.[1]).toEqual({
      ops: [
        { op: 'upsert', nodeRef: 'n1', expectedVersion: 4, taskable: true },
        { op: 'upsert', nodeRef: 'n2', expectedVersion: 9, taskable: true },
      ],
    });
  });

  it('sends ops only for the nodes that are not already taskable', async () => {
    applyPlanPatch.mockResolvedValueOnce(undefined);
    await markPlanNodesTaskable(
      db,
      [
        { id: 'already', taskable: true, version: 1 },
        { id: 'n2', taskable: false, version: 9 },
      ],
      'r1',
    );
    expect(applyPlanPatch.mock.calls[0]?.[1]).toEqual({
      ops: [{ op: 'upsert', nodeRef: 'n2', expectedVersion: 9, taskable: true }],
    });
  });

  it('skips the write when every node is already taskable', async () => {
    await expect(
      markPlanNodesTaskable(db, [{ id: 'n1', taskable: true, version: 4 }], 'r1'),
    ).resolves.toBe(false);
    expect(applyPlanPatch).not.toHaveBeenCalled();
  });

  it('skips the write for an empty set', async () => {
    await expect(markPlanNodesTaskable(db, [], 'r1')).resolves.toBe(false);
    expect(applyPlanPatch).not.toHaveBeenCalled();
  });

  it('never fails the task creation — a lost version race only warns', async () => {
    applyPlanPatch.mockRejectedValueOnce(new Error('modified by someone else'));
    await expect(
      markPlanNodesTaskable(db, [{ id: 'n1', taskable: false, version: 4 }], 'r1'),
    ).resolves.toBe(false);
  });
});
