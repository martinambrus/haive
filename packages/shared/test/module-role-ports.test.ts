import { expect, it } from 'vitest';
import { moduleManifestSchema } from '../src/modularity/manifest.js';
import { dataPortNodes } from '../src/step-engine/core-data-ports.js';
import { buildDataEdgePlan } from '../src/step-engine/data-edge-plan.js';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '../src/step-engine/output-contracts.js';
const role = SPEC_ROLES.checked;
const contract = STEP_ROLE_REGISTRY[role].contract;
const entry = (stepId: string) => ({
  stepId,
  label: stepId,
  group: 'build',
  dispatchesCli: false,
  requires: [],
  provides: [],
});
const providesRoles = [{ role, contract }];
const consumesRoles = [{ input: 'spec', role, contract, optional: false }];
const manifest = (patch = {}) => ({
  id: 'ports',
  name: 'Ports',
  version: '1',
  schemaVersion: 1,
  composableSteps: [
    { ...entry('check'), providesRoles },
    { ...entry('use'), consumesRoles },
  ],
  ...patch,
});
it('retains exact role declarations in module manifests and refuses unsupported versions', () => {
  const parsed = moduleManifestSchema.parse(manifest());
  expect(parsed.composableSteps![0]).toHaveProperty('providesRoles', providesRoles);
  expect(parsed.composableSteps![1]).toHaveProperty('consumesRoles', consumesRoles);
  expect(
    moduleManifestSchema.safeParse(
      manifest({
        composableSteps: [
          { ...entry('check'), providesRoles: [{ role, contract: { ...contract, version: 2 } }] },
        ],
      }),
    ).success,
  ).toBe(false);
});
it.each(['module.other.check', 'module.ports.check', 'custom.t.check'])(
  'refuses foreign/namespaced declaration owner %s',
  (stepId) => {
    expect(
      moduleManifestSchema.safeParse(
        manifest({ composableSteps: [{ ...entry(stepId), providesRoles }] }),
      ).success,
    ).toBe(false);
  },
);
it('wires module roles uniquely, refuses ambiguity and pins an explicit per-consumer choice', () => {
  const entries = new Map([
    ['module.ports.check', { ...entry('module.ports.check'), providesRoles }],
    ['module.ports.use', { ...entry('module.ports.use'), consumesRoles }],
  ]);
  const make = (ids: string[]) => dataPortNodes(ids, {}, entries as never);
  const unique = buildDataEdgePlan('static', [
    { executionPath: null, nodes: make(['module.ports.check', 'module.ports.use']) },
  ]);
  expect(unique.candidates[0]!.bindings['1:spec']?.producerStepId).toBe('module.ports.check');
  const nodes = make(['05-phase-0b5-spec-quality', 'module.ports.check', 'module.ports.use']);
  expect(() => buildDataEdgePlan('static', [{ executionPath: null, nodes }])).toThrow('ambiguous');
  const chosen = buildDataEdgePlan('static', [
    { executionPath: null, nodes, bindings: { '2:spec': 1 } },
  ]);
  expect(chosen.candidates[0]!.bindings['2:spec']?.producerStepId).toBe('module.ports.check');
  expect(() =>
    buildDataEdgePlan('static', [{ executionPath: null, nodes: make(['module.ports.use']) }]),
  ).toThrow('spec: dangling');
});
