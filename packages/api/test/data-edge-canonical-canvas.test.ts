import { expect, it } from 'vitest';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { dataPortNodes } from '@haive/shared/step-ports';
import { projectTaskPorts } from '../src/lib/step-port-projection.js';
it.each(['input', 'consumer'])(
  'shows canonical worker reads when the valid pin predates a %s',
  (missing) => {
    const ids = ['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality'];
    const nodes = dataPortNodes(ids);
    const pin = buildDataEdgePlan('static', [
      {
        executionPath: null,
        nodes: missing === 'consumer' ? [nodes[0]!] : nodes.map((n) => ({ ...n, inputs: [] })),
      },
    ]);
    const graph = projectTaskPorts(
      { dataEdgePlan: pin } as never,
      ids.map((stepId) => ({ stepId })),
    ).candidates[0]!.graph;
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: ids[0], target: ids[1], targetPort: 'draft' }),
    );
  },
);
it('shows the canonical historical edge even when its producer was not a node in the old pin', () => {
  const ids = ['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality'];
  const pin = buildDataEdgePlan('static', [
    { executionPath: null, nodes: [{ ...dataPortNodes(ids)[1]!, inputs: [] }] },
  ]);
  const graph = projectTaskPorts(
    { dataEdgePlan: pin } as never,
    ids.map((stepId) => ({ stepId })),
  ).candidates[0]!.graph;
  expect(graph.edges).toContainEqual(
    expect.objectContaining({ source: ids[0], target: ids[1], targetPort: 'draft' }),
  );
});
