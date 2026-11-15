import { expect, it } from 'vitest';
import { bindPortInput, portBindingIndexes, validatePortEdges } from '@haive/shared/step-ports';
const port = {
  id: 'spec',
  role: 'haive.spec.checked',
  contract: { id: 'haive.spec.checked', version: 1 },
  authorship: 'mixed' as const,
  optional: false,
};
const nodes = [
  { id: 'a', label: 'a', inputs: [], outputs: [port] },
  { id: 'b', label: 'b', inputs: [], outputs: [port] },
  { id: 'use', label: 'use', inputs: [port], outputs: [] },
];
it('drag and keyboard/list choices serialize identically and preserve other paths', () => {
  const old = [
    { executionPath: 'quick_bugfix', consumerStepId: 'use', input: 'spec', producerStepId: 'a' },
  ];
  const drag = bindPortInput(old, null, 'use', 'spec', 'b');
  const list = bindPortInput(old, null, 'use', 'spec', 'b');
  expect(drag).toEqual(list);
  expect(drag).toHaveLength(2);
  const graph = validatePortEdges(nodes, portBindingIndexes(nodes, drag, null));
  expect(graph.nodes[2]!.inputs[0]!.state).toBe('wired');
  expect(graph.edges[0]!.source).toBe('b');
  expect(validatePortEdges([nodes[2]!]).nodes[0]!.inputs[0]!.state).toBe('dangling');
});
