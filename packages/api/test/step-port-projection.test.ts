import { describe, expect, it, vi } from 'vitest';

const selection = vi.hoisted(() => ({ value: 'static' as 'static' | 'workflow' | 'derived' }));
vi.mock('@haive/shared/data-edge-plan', () => ({
  parseDataEdgePlan: () => ({ selection: selection.value }),
  selectDataEdgeCandidate: () => ({
    executionPath: selection.value === 'static' ? null : 'quick_bugfix',
    nodes: [],
    bindings: {},
  }),
}));

const { projectTaskPorts } = await import('../src/lib/step-port-projection.js');

describe('projectTaskPorts with a v3 pin', () => {
  it('keys a static pin by the path the task chose, so the canvas finds it', () => {
    selection.value = 'static';
    const ports = projectTaskPorts(
      { dataEdgePlan: {}, executionPath: 'quick_bugfix' } as never,
      [],
    );
    expect(ports.candidates.map((c) => c.executionPath)).toEqual(['quick_bugfix']);
  });

  it('keeps a static pin path-less when the task has no chosen path', () => {
    selection.value = 'static';
    const ports = projectTaskPorts({ dataEdgePlan: {}, executionPath: null } as never, []);
    expect(ports.candidates.map((c) => c.executionPath)).toEqual([null]);
  });

  it('keeps the selected candidate path for workflow pins', () => {
    selection.value = 'workflow';
    const ports = projectTaskPorts(
      { dataEdgePlan: {}, executionPath: 'quick_bugfix' } as never,
      [],
    );
    expect(ports.candidates.map((c) => c.executionPath)).toEqual(['quick_bugfix']);
  });
});
