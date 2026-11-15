// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { projectStepPorts } from '@haive/shared/step-ports';
const h = vi.hoisted(() => ({ edges: [] as { source: string; target: string }[] }));
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ edges }: { edges: typeof h.edges }) => {
    h.edges = edges;
    return null;
  },
  MarkerType: { ArrowClosed: 'arrow' },
  Handle: () => null,
  Position: {},
  Controls: () => null,
}));
import StepPortCanvas from './step-port-canvas';
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
