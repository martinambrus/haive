// @vitest-environment jsdom
import { act, render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { projectStepPorts } from '@haive/shared/step-ports';
import type { Node, NodeChange } from '@xyflow/react';
const h = vi.hoisted(() => ({
  post: vi.fn(),
  edges: [] as { source: string; target: string }[],
  props: {} as {
    nodes: Node[];
    onNodesChange?: (changes: NodeChange[]) => void;
    onConnect: (connection: import('@xyflow/react').Connection) => void;
    onNodeDragStop: (event: unknown, node: Node) => void;
  },
}));
vi.mock('@xyflow/react', async (original) => ({
  ...(await original<typeof import('@xyflow/react')>()),
  ReactFlow: (props: typeof h.props & { edges: typeof h.edges }) => {
    h.edges = props.edges;
    h.props = props;
    return <div data-testid="flow-instance" />;
  },
  MarkerType: { ArrowClosed: 'arrow' },
  Handle: () => null,
  Position: {},
  Controls: () => null,
}));
vi.mock('@/lib/api-client', () => ({ api: { post: h.post } }));
vi.mock('next/dynamic', () => ({ default: () => StepPortCanvas }));
import StepPortCanvas from './step-port-canvas';
import { StepPortView } from './step-port-view';
afterEach(cleanup);
it('maps duplicate consumer edges to their own canvas nodes', () => {
  const graph = projectStepPorts([
    '04-phase-0b-pre-planning',
    '05-phase-0b5-spec-quality',
    '05-phase-0b5-spec-quality',
  ]);
  render(<StepPortCanvas graph={graph} />);
  expect(h.edges.map((edge) => edge.target)).toEqual([
    '1:05-phase-0b5-spec-quality',
    '2:05-phase-0b5-spec-quality',
  ]);
});

it.each(['refused', 'legal'])(
  'preserves the flow instance and resets positions after a %s drag',
  (move) => {
    const ids = ['04-phase-0b-pre-planning', '01-worktree-setup'];
    const graph = projectStepPorts(ids);
    const reorder = vi.fn();
    const view = render(<StepPortCanvas graph={graph} onReorder={reorder} />);
    const instance = view.getByTestId('flow-instance');
    const first = h.props.nodes[0]!;
    act(() =>
      h.props.onNodesChange?.([
        { type: 'position', id: first.id, position: { x: 40, y: 300 }, dragging: true },
      ]),
    );
    expect(h.props.nodes[0]!.position).toEqual({ x: 40, y: 300 });
    act(() => h.props.onNodeDragStop(null, { ...first, position: { x: 40, y: 300 } }));
    expect(reorder).toHaveBeenCalledWith(0, 1);
    expect(view.getByTestId('flow-instance')).toBe(instance);
    expect(h.props.nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 300 },
    ]);
    if (move === 'legal') {
      view.rerender(
        <StepPortCanvas graph={projectStepPorts([...ids].reverse())} onReorder={reorder} />,
      );
      expect(view.getByTestId('flow-instance')).toBe(instance);
      expect(h.props.nodes.map((node) => node.data.node)).toEqual(
        projectStepPorts([...ids].reverse()).nodes,
      );
    }
  },
);

it('keeps the canvas instance through an asynchronous draft projection refresh', async () => {
  const ids = ['04-phase-0b-pre-planning', '01-worktree-setup'];
  let resolve!: (value: unknown) => void;
  h.post
    .mockResolvedValueOnce({ candidates: [{ executionPath: null, graph: projectStepPorts(ids) }] })
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
  const renderView = (stepIds: string[]) => (
    <StepPortView request={{ path: '/ports', body: { stepIds } }}>
      <div>List</div>
    </StepPortView>
  );
  const view = render(renderView(ids));
  fireEvent.click(view.getByRole('button', { name: /^Canvas$/ }));
  const instance = await view.findByTestId('flow-instance');
  view.rerender(renderView([...ids].reverse()));
  expect(view.getByTestId('flow-instance')).toBe(instance);
  expect(instance.closest('[hidden]')).not.toBeNull();
  expect(view.getByRole('status').textContent).toContain('Loading ports');
  await act(async () =>
    resolve({ candidates: [{ executionPath: null, graph: projectStepPorts([...ids].reverse()) }] }),
  );
  await waitFor(() => expect(instance.closest('[hidden]')).toBeNull());
  expect(view.getByTestId('flow-instance')).toBe(instance);
  expect(h.props.nodes[0]!.id).toBe('0:01-worktree-setup');
});

it('canvas connections and list selections update the same serialized input binding', async () => {
  const { useState } = await import('react');
  const { validatePortEdges, bindPortInput, portBindingIndexes } =
    await import('@haive/shared/step-ports');
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
  let serialized: import('@haive/shared/step-ports').DataRoleBindingsDraft = [];
  function Draft() {
    const [bindings, setBindings] = useState(serialized);
    serialized = bindings;
    const graph = validatePortEdges(nodes, portBindingIndexes(nodes, bindings, null));
    return (
      <StepPortView
        request={{ path: '/unused' }}
        draftGraph={graph}
        onBind={(consumer, input, producer) =>
          setBindings((v) => bindPortInput(v, null, consumer, input, producer))
        }
      >
        <div>steps</div>
      </StepPortView>
    );
  }
  const view = render(<Draft />);
  fireEvent.change(view.getByRole('combobox', { name: 'use.spec producer' }), {
    target: { value: 'b' },
  });
  const fromList = serialized;
  expect(fromList).toEqual([
    { executionPath: null, consumerStepId: 'use', input: 'spec', producerStepId: 'b' },
  ]);
  fireEvent.click(view.getByRole('button', { name: 'Canvas' }));
  act(() =>
    h.props.onConnect({
      source: '0:a',
      target: '2:use',
      sourceHandle: 'spec',
      targetHandle: 'spec',
    }),
  );
  expect(serialized).toEqual(bindPortInput([], null, 'use', 'spec', 'a'));
  act(() =>
    h.props.onConnect({
      source: '1:b',
      target: '2:use',
      sourceHandle: 'spec',
      targetHandle: 'spec',
    }),
  );
  expect(serialized).toEqual(fromList);
  act(() =>
    h.props.onConnect({
      source: '2:use',
      target: '0:a',
      sourceHandle: 'spec',
      targetHandle: 'spec',
    }),
  );
  expect(serialized).toEqual(fromList);
});
