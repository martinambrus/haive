'use client';

import { useMemo, useState } from 'react';
import {
  ReactFlow,
  MarkerType,
  Handle,
  Position,
  Controls,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { StepPort, StepPortGraph } from '@haive/shared/step-ports';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';

const ROW_HEIGHT = 300;
type GraphNode = Node<
  { node: StepPortGraph['nodes'][number]; select: (id: string, port: string) => void },
  'ports'
>;

function Port({
  port,
  input,
  select,
}: {
  port: StepPort & { state?: string };
  input: boolean;
  select: () => void;
}) {
  const color =
    port.state === 'dangling'
      ? 'text-red-300 border-red-400'
      : port.state === 'ambiguous'
        ? 'text-amber-300 border-amber-400'
        : 'text-neutral-200 border-neutral-700';
  return (
    <button
      type="button"
      className={`nodrag nopan relative block w-full rounded border p-2 text-left text-xs ${color}`}
      onClick={select}
      aria-label={`${input ? 'Input' : 'Output'} ${port.id}${port.state ? `: ${port.state}` : ''}`}
    >
      <Handle
        id={port.id}
        type={input ? 'target' : 'source'}
        position={input ? Position.Left : Position.Right}
        isConnectable={false}
      />
      <span className="block font-medium">{port.adapter ?? port.role}</span>
      <span className="block font-mono text-indigo-300">
        {port.contract.id}@{port.contract.version}
      </span>
      {port.alternatives && (
        <span className="block">
          {port.alternatives.map((p) => `${p.role}@${p.contract.version}`).join(' → ')}
        </span>
      )}
      <span className="block">
        {port.authorship} · {port.optional ? 'optional' : 'required'}
        {port.state ? ` · ${port.state}` : ''}
      </span>
    </button>
  );
}
function PortsNode({ data }: NodeProps<GraphNode>) {
  const { node, select } = data;
  return (
    <div className="w-[600px] rounded-lg border border-neutral-600 bg-neutral-950 p-3 text-neutral-100">
      <p className="mb-2 font-medium">{node.label}</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          {node.inputs.map((port) => (
            <Port key={port.id} port={port} input select={() => select(node.id, port.id)} />
          ))}
        </div>
        <div className="flex flex-col gap-2">
          {node.outputs.map((port) => (
            <Port key={port.id} port={port} input={false} select={() => select(node.id, port.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}
const nodeTypes = { ports: PortsNode };
export default function StepPortCanvas({
  graph,
  onReorder,
}: {
  graph: StepPortGraph;
  onReorder?: (from: number, to: number) => void;
}) {
  const [selected, setSelected] = useState<{ id: string; port: string } | null>(null);
  const [dragRevision, setDragRevision] = useState(0);
  const nodes: GraphNode[] = useMemo(
    () =>
      graph.nodes.map((node, index) => ({
        id: `${index}:${node.id}`,
        type: 'ports',
        position: { x: 0, y: index * ROW_HEIGHT },
        data: { node, select: (id, port) => setSelected({ id, port }) },
      })),
    [graph],
  );
  const nodeId = (id: string) => `${graph.nodes.findIndex((node) => node.id === id)}:${id}`;
  const edges = graph.edges.map((edge, index) => {
    const highlighted =
      selected &&
      ((selected.id === edge.source && selected.port === edge.sourcePort) ||
        (selected.id === edge.target && selected.port === edge.targetPort));
    return {
      id: String(index),
      source: nodeId(edge.source),
      target: nodeId(edge.target),
      markerEnd: { type: MarkerType.ArrowClosed },
      sourceHandle: edge.sourcePort,
      targetHandle: edge.targetPort,
      style: { stroke: highlighted ? '#a5b4fc' : '#a3a3a3', strokeWidth: highlighted ? 3 : 1.5 },
    };
  });
  return (
    <div>
      <InlineMarkdown
        className="mb-2 text-xs text-neutral-400"
        body={`${onReorder ? 'Drag a step vertically to change its order. ' : 'Read-only step order. '}Select a port to highlight its edges. Use List for keyboard access.`}
      />
      <div className="h-[650px] rounded border border-neutral-700" aria-label="Step port canvas">
        <ReactFlow
          key={dragRevision}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          nodesDraggable={onReorder !== undefined}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ maxZoom: 1, nodes: nodes.slice(0, 2) }}
          minZoom={0.05}
          onNodeDragStop={(_, node) => {
            const from = nodes.findIndex((item) => item.id === node.id);
            const to = Math.max(
              0,
              Math.min(nodes.length - 1, Math.round(node.position.y / ROW_HEIGHT)),
            );
            if (from !== to) onReorder?.(from, to);
            // Discard transient positions even after a refused move. Order always comes from the draft.
            setDragRevision((revision) => revision + 1);
          }}
        >
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
