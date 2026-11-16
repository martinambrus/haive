import { expect, it } from 'vitest';
import {
  STEP_ROLE_REGISTRY,
  isQuotableRole,
  isPromptProvidableRole,
  safeParseStepOutput,
  projectRoleOutput,
  parseRegistryOutputContractRef,
  HOST_POLICY_STEP_ROLES,
} from '../src/step-engine/output-contracts.js';
import { dataPortNodes } from '../src/step-engine/step-ports.js';
import { buildDataEdgePlan } from '../src/step-engine/data-edge-plan.js';
import { parseDerivedRunPlan } from '../src/modularity/derived-task-types.js';
import { promptRolePortDeclarationsSchema } from '../src/step-engine/role-port-declarations.js';
import { rolePlan } from './step-role-fixtures.js';
const role = 'haive.implementation.summary' as const;
const single = '07-phase-2-implement';
const dag = '06c-dag-execute';
const learning = '11-phase-8-learning';
it('registers an exact mixed data-only contract and projects only its fields', () => {
  const entry = STEP_ROLE_REGISTRY[role];
  expect(entry).toEqual({
    id: role,
    contract: { id: role, version: 1 },
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: single,
  });
  expect(Object.isFrozen(entry)).toBe(true);
  expect(Object.isFrozen(entry.contract)).toBe(true);
  const output = {
    summary: 'Done',
    filesTouched: ['src/a.ts'],
    similarSites: [{ path: 'src/b.ts', lines: '2-3', reason: 'similar', extension: 'private' }],
    extension: 'private',
  };
  expect(safeParseStepOutput(entry.contract, output)).toMatchObject({
    success: true,
    data: output,
  });
  expect(projectRoleOutput(role, output)).toEqual({
    summary: 'Done',
    filesTouched: ['src/a.ts'],
    similarSites: [{ path: 'src/b.ts', lines: '2-3', reason: 'similar' }],
  });
  for (const output of [
    {},
    { summary: '', filesTouched: [1] },
    { summary: 1, filesTouched: [] },
    { summary: '', filesTouched: [], similarSites: [{ path: 'a' }] },
  ])
    expect(safeParseStepOutput(entry.contract, output).success).toBe(false);
  expect(safeParseStepOutput(entry.contract, { summary: '', filesTouched: [] }).success).toBe(true);
  expect(parseRegistryOutputContractRef({ id: role, version: 2 })).toBeNull();
  expect(isQuotableRole(role)).toBe(false);
  expect(isPromptProvidableRole(role)).toBe(false);
  expect(
    promptRolePortDeclarationsSchema.safeParse({
      providesRoles: [{ role, contract: entry.contract }],
    }).success,
  ).toBe(false);
  expect(HOST_POLICY_STEP_ROLES).toEqual(['08c-code-review', '08c2-code-audit']);
  for (const version of [1, 2] as const) {
    const plan = rolePlan(version);
    Object.assign(plan.candidates[0]!, {
      roleBindings: { [role]: { stepId: single, outputContract: entry.contract } },
    });
    expect(() => parseDerivedRunPlan(plan)).toThrow();
  }
});
it.each([[single, learning], [dag, learning], [dag, single, learning], [learning]])(
  'pins one structural route for %j',
  (...ids) => {
    const plan = buildDataEdgePlan('static', [{ executionPath: null, nodes: dataPortNodes(ids) }]);
    const key = `${ids.length - 1}:implementation-summary`;
    const expected = ids.includes(single) ? single : ids.includes(dag) ? dag : null;
    expect(Object.hasOwn(plan.candidates[0]!.bindings, key)).toBe(true);
    expect(plan.candidates[0]!.bindings[key]?.producerStepId ?? null).toBe(expected);
  },
);

it('uses the same structural route with real serialized declarations and requires a module choice', () => {
  const provided = { providesRoles: [{ role, contract: { id: role, version: 1 as const } }] };
  const ids = [dag, single, 'module.example.summary', learning];
  const entries = new Map(ids.slice(0, 3).map((id) => [id, provided]));
  const nodes = dataPortNodes(ids, {}, entries);
  expect(nodes[0]!.outputs).toEqual([]);
  expect(() => buildDataEdgePlan('static', [{ executionPath: null, nodes }])).toThrow('ambiguous');
  const plan = buildDataEdgePlan('static', [
    { executionPath: null, nodes, bindings: { '3:implementation-summary': 2 } },
  ]);
  expect(plan.candidates[0]!.bindings['3:implementation-summary']?.producerStepId).toBe(
    'module.example.summary',
  );
});
