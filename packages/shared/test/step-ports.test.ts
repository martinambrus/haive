import { describe, expect, it } from 'vitest';
import {
  projectStepPorts,
  validatePortEdges,
  type PortNode,
} from '../src/step-engine/step-ports.js';
import { SPEC_ROLES, STEP_ROLE_REGISTRY, STEP_ROLES } from '../src/step-engine/output-contracts.js';
const role = SPEC_ROLES.draft;
const port = {
  role,
  contract: STEP_ROLE_REGISTRY[role].contract,
  authorship: 'mixed' as const,
  optional: false,
};
const producer = (id: string): PortNode => ({
  id,
  label: id,
  outputs: [{ ...port, id: role }],
  inputs: [],
});
const consumer = (optional = false): PortNode => ({
  id: 'c',
  label: 'c',
  outputs: [],
  inputs: [{ ...port, id: 'spec', optional }],
});
describe('port edge validation', () => {
  it.each([
    [[producer('p'), consumer()], 'wired'],
    [[producer('p'), producer('q'), consumer()], 'ambiguous'],
    [[consumer(), producer('p')], 'dangling'],
    [[consumer(true)], 'optional-absent'],
  ] as const)('resolves earlier exact compatible producers: %s', (nodes, state) => {
    const graph = validatePortEdges(nodes);
    expect(graph.nodes.find((n) => n.id === 'c')!.inputs[0]!.state).toBe(state);
    expect(graph.edges).toHaveLength(state === 'wired' ? 1 : 0);
  });
  it('refuses incompatible versions and honors an explicit binding without guessing', () => {
    const p = producer('p');
    p.outputs[0]!.contract = { id: port.contract.id, version: 2 };
    expect(validatePortEdges([p, consumer()]).nodes[1]!.inputs[0]!.state).toBe('dangling');
    expect(
      validatePortEdges([producer('p'), producer('q'), consumer()], { '2:spec': 1 }).edges[0]
        ?.source,
    ).toBe('q');
    expect(
      validatePortEdges([producer('p'), consumer()], { '1:spec': -1 }).nodes[1]!.inputs[0]!.state,
    ).toBe('dangling');
  });
  it('projects the spec stages and effective-spec adapter without inventing a direct stage input', () => {
    const ids = [
      '04-phase-0b-pre-planning',
      '05-phase-0b5-spec-quality',
      '05a-resolve-spec-warnings',
      '07-phase-2-implement',
    ];
    const graph = projectStepPorts(ids);
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: ids[0], target: ids[1] }));
    expect(graph.nodes[3]!.inputs[0]).toMatchObject({
      id: 'effective-spec',
      adapter: 'effective-spec',
      state: 'wired',
    });
    const removed = projectStepPorts(ids.filter((id) => id !== ids[1]));
    expect(removed.nodes[1]!.inputs.find((p) => p.id === 'checked')!.state).toBe('optional-absent');
    expect(removed.edges).toContainEqual(
      expect.objectContaining({ source: ids[0], target: ids[2] }),
    );
  });
  it('uses candidate-local v2 review/audit bindings and exposes no policy or output internals', () => {
    const graph = projectStepPorts(
      ['module.demo.review', STEP_ROLES.codeAudit, '09-gate-2-verify-approval'],
      {
        roleBindings: {
          [STEP_ROLES.codeReview]: {
            stepId: 'module.demo.review',
            outputContract: STEP_ROLE_REGISTRY[STEP_ROLES.codeReview].contract,
          },
        },
      },
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'module.demo.review',
          target: '09-gate-2-verify-approval',
        }),
        expect.objectContaining({
          source: STEP_ROLES.codeAudit,
          target: '09-gate-2-verify-approval',
        }),
      ]),
    );
    expect(JSON.stringify(graph)).not.toMatch(/hostPolicy|quoteProjection|schema|validator/);
    const paths = [
      ['module.demo.review', '09-gate-2-verify-approval'],
      ['09-gate-2-verify-approval'],
    ].map((ids) => projectStepPorts(ids));
    expect(paths[1]!.nodes[0]!.inputs.find((p) => p.role === STEP_ROLES.codeReview)!.state).toBe(
      'optional-absent',
    );
  });
});

it('indexes each producer output once rather than rereading earlier nodes per input', () => {
  let reads = 0;
  const nodes = Array.from({ length: 8 }, (_, i) => {
    const node = producer(String(i));
    Object.defineProperty(node.outputs[0], 'role', {
      get() {
        reads++;
        return role;
      },
    });
    return node;
  });
  validatePortEdges([...nodes, ...Array.from({ length: 8 }, () => consumer())]);
  expect(reads).toBeLessThanOrEqual(8);
});

it('keeps duplicate consumer bindings and edge endpoints distinct by run position', () => {
  const graph = validatePortEdges([producer('same'), consumer(), producer('same'), consumer()], {
    '1:spec': 0,
    '3:spec': 2,
  });
  expect(graph.edges).toEqual([
    expect.objectContaining({ sourceIndex: 0, targetIndex: 1 }),
    expect.objectContaining({ sourceIndex: 2, targetIndex: 3 }),
  ]);
});
