import { afterEach, expect, it, vi } from 'vitest';
import {
  applyPlanPatch,
  loadPlanSkeletons,
  loadPlanEdges,
  PlanPatchError,
  type PlanNodeSkeleton,
} from '@haive/shared/plan';
vi.mock('@haive/shared/plan', async (original) => ({
  ...(await original<typeof import('@haive/shared/plan')>()),
  applyPlanPatch: vi.fn(),
  loadPlanSkeletons: vi.fn(),
  loadPlanEdges: vi.fn(),
}));
import { applyDeterministicOrder } from '../src/step-engine/steps/plan/03-plan-sequence.js';

afterEach(() => vi.resetAllMocks());
const nodes = [
  { id: 'a', parentId: 'root', ordinal: 1 },
  { id: 'b', parentId: 'root', ordinal: 0 },
] as PlanNodeSkeleton[];
const ctx = { db: {}, taskId: 'task' } as never;

it('recomputes a conflicted chunk from fresh dependency and node reads', async () => {
  vi.mocked(applyPlanPatch)
    .mockRejectedValueOnce(new PlanPatchError('conflict', 'raced'))
    .mockResolvedValue({} as never);
  vi.mocked(loadPlanSkeletons).mockResolvedValue(nodes);
  vi.mocked(loadPlanEdges).mockResolvedValue([
    { fromNodeId: 'a', toNodeId: 'b', kind: 'depends_on' },
  ] as never);
  expect(await applyDeterministicOrder(ctx, 'repo', nodes, [])).toBe(0);
  expect(applyPlanPatch).toHaveBeenCalledOnce();
  // The new dependency already matches stored ordinals, so this chunk needs no retry write.
  expect(loadPlanSkeletons).toHaveBeenCalledOnce();
  expect(loadPlanEdges).toHaveBeenCalledOnce();
});

it('retries a content race without failing the order projection', async () => {
  vi.mocked(applyPlanPatch)
    .mockRejectedValueOnce(new PlanPatchError('conflict', 'raced'))
    .mockResolvedValue({} as never);
  vi.mocked(loadPlanSkeletons).mockResolvedValue(nodes);
  vi.mocked(loadPlanEdges).mockResolvedValue([]);
  await applyDeterministicOrder(ctx, 'repo', nodes, []);
  expect(applyPlanPatch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(applyPlanPatch).mock.calls[1]![1]).toEqual(
    vi.mocked(applyPlanPatch).mock.calls[0]![1],
  );
});

it('rebuilds the whole order after a conflict, including nodes the first chunk did not name', async () => {
  // A depends on B; another writer then adds B depends on C. The order becomes C, B, A, and C
  // must move even though the first write named only A and B.
  const before = [
    { id: 'A', parentId: 'root', ordinal: 0 },
    { id: 'B', parentId: 'root', ordinal: 1 },
    { id: 'C', parentId: 'root', ordinal: 2 },
  ] as PlanNodeSkeleton[];
  vi.mocked(applyPlanPatch)
    .mockRejectedValueOnce(new PlanPatchError('conflict', 'raced'))
    .mockResolvedValue({} as never);
  vi.mocked(loadPlanSkeletons).mockResolvedValue(before);
  vi.mocked(loadPlanEdges).mockResolvedValue([
    { fromNodeId: 'A', toNodeId: 'B', kind: 'depends_on' },
    { fromNodeId: 'B', toNodeId: 'C', kind: 'depends_on' },
  ] as never);
  await applyDeterministicOrder(ctx, 'repo', before, [
    { fromNodeId: 'A', toNodeId: 'B', kind: 'depends_on' },
  ] as never);
  const retried = (vi.mocked(applyPlanPatch).mock.calls[1]![1] as { ops: unknown[] }).ops;
  expect(retried).toEqual(
    expect.arrayContaining([
      { op: 'upsert', nodeRef: 'C', ordinal: 0 },
      { op: 'upsert', nodeRef: 'A', ordinal: 2 },
    ]),
  );
});

it('bounds a persistently conflicted chunk', async () => {
  vi.mocked(applyPlanPatch).mockRejectedValue(new PlanPatchError('conflict', 'raced'));
  vi.mocked(loadPlanSkeletons).mockResolvedValue(nodes);
  vi.mocked(loadPlanEdges).mockResolvedValue([]);
  await expect(applyDeterministicOrder(ctx, 'repo', nodes, [])).rejects.toMatchObject({
    kind: 'conflict',
  });
  expect(applyPlanPatch).toHaveBeenCalledTimes(3);
  expect(loadPlanSkeletons).toHaveBeenCalledTimes(2);
});
