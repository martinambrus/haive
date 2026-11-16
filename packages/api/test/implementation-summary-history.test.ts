import { expect, it } from 'vitest';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { dataPortNodes } from '@haive/shared/step-ports';
import { projectTaskPorts } from '../src/lib/step-port-projection.js';
const ids = ['06c-dag-execute', '11-phase-8-learning'];
const steps = ids.map((stepId) => ({ stepId }));
const edges = (task: Parameters<typeof projectTaskPorts>[0]) =>
  projectTaskPorts(task, steps).candidates[0]!.graph.edges.filter(
    (e) => e.targetPort === 'implementation-summary',
  );
it('keeps old tasks on the canonical 07 read even when only DAG is in their list', () => {
  expect(edges({ runListSnapshot: ids })).toEqual([]);
});
it('shows the pinned DAG route on a new DAG-only task', () => {
  const dataEdgePlan = buildDataEdgePlan('static', [
    { executionPath: null, nodes: dataPortNodes(ids) },
  ]);
  expect(edges({ runListSnapshot: ids, dataEdgePlan })).toMatchObject([
    { source: ids[0], target: ids[1] },
  ]);
});
it('shows canonical absence for an input missing from an older valid v3 pin', () => {
  const nodes = dataPortNodes(ids).map((n) => ({
    ...n,
    inputs: n.inputs.filter((i) => i.role !== 'haive.implementation.summary'),
    outputs: n.outputs.filter((o) => o.role !== 'haive.implementation.summary'),
  }));
  const dataEdgePlan = buildDataEdgePlan('static', [{ executionPath: null, nodes }]);
  expect(edges({ runListSnapshot: ids, dataEdgePlan })).toEqual([]);
});
