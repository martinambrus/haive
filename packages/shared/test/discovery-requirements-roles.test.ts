import { expect, it } from 'vitest';
import {
  STEP_ROLE_REGISTRY,
  HOST_POLICY_STEP_ROLES,
  isQuotableRole,
  isPromptProvidableRole,
  safeParseStepOutput,
  projectRoleOutput,
  parseRegistryOutputContractRef,
} from '../src/step-engine/output-contracts.js';
import { validatePromptStep } from '../src/modularity/prompt-steps.js';
import {
  promptRolePortDeclarationsSchema,
  rolePortDeclarationsSchema,
} from '../src/step-engine/role-port-declarations.js';
import { parseDerivedRunPlan } from '../src/modularity/derived-task-types.js';
import { rolePlan } from './step-role-fixtures.js';
import { dataPortNodes, projectStepPorts } from '../src/step-engine/step-ports.js';
import { buildDataEdgePlan } from '../src/step-engine/data-edge-plan.js';

const roles = [
  ['haive.discovery', '03-phase-0a-discovery', { summary: '', relevantKbIds: [], source: 'stub' }],
  ['haive.requirements.draft', '03b-business-requirements', { requirements: '', summary: '' }],
  ['haive.requirements.humanized', '03b2-humanize-requirements', { requirements: '', summary: '' }],
] as const;
it.each(roles)(
  'registers exact data-only contract %s with mixed authorship',
  (id, stepId, output) => {
    const role = id as keyof typeof STEP_ROLE_REGISTRY;
    const entry = STEP_ROLE_REGISTRY[role];
    expect(entry).toEqual({
      id,
      contract: { id, version: 1 },
      cardinality: 'one',
      authorship: 'mixed',
      legacyStepId: stepId,
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.contract)).toBe(true);
    expect(
      safeParseStepOutput(entry.contract, { ...output, extension: 'kept in storage' }),
    ).toMatchObject({ success: true, data: { ...output, extension: 'kept in storage' } });
    expect(projectRoleOutput(role, { ...output, extension: 'private' })).toEqual(output);
    expect(safeParseStepOutput(entry.contract, {}).success).toBe(false);
    expect(parseRegistryOutputContractRef({ id, version: 2 })).toBeNull();
    expect(
      rolePortDeclarationsSchema.safeParse({ providesRoles: [{ role, contract: entry.contract }] })
        .success,
    ).toBe(true);
    expect(HOST_POLICY_STEP_ROLES).toEqual(['08c-code-review', '08c2-code-audit']);
  },
);
it.each(roles)('refuses quoting and prompt production for %s at both boundaries', (id) => {
  const role = id as keyof typeof STEP_ROLE_REGISTRY;
  const contract = { id, version: 1 } as const;
  expect(STEP_ROLE_REGISTRY[role]).toBeDefined();
  expect(isQuotableRole(role)).toBe(false);
  expect(isPromptProvidableRole(role)).toBe(false);
  const consumesRoles = [{ input: 'doc', role, contract, optional: true }];
  const providesRoles = [{ role, contract }];
  expect(
    validatePromptStep(
      { template: '{{role:doc}}', capabilities: [], timeoutMs: 60000, consumesRoles },
      { typeSlug: 'demo', requiresRepository: true, stepIdsBefore: [] },
    ).map((p) => p.kind),
  ).toContain('role-token-not-quotable');
  expect(promptRolePortDeclarationsSchema.safeParse({ providesRoles }).success).toBe(false);
  for (const version of [1, 2] as const) {
    const plan = rolePlan(version);
    Object.assign(plan.candidates[0]!, {
      roleBindings: { [role]: { stepId: 'module.example.doc', outputContract: contract } },
    });
    expect(() => parseDerivedRunPlan(plan)).toThrow();
  }
});
it('pins all stages independently and displays the ordered host adapter', () => {
  const ids = [
    ...roles.map(([, id]) => id),
    '03c-business-requirements-review',
    '04-phase-0b-pre-planning',
  ];
  const pin = buildDataEdgePlan('static', [{ executionPath: null, nodes: dataPortNodes(ids) }]);
  expect(pin.candidates[0]!.bindings['1:discovery']?.producerStepId).toBe(ids[0]);
  expect(pin.candidates[0]!.bindings['2:requirements-draft']?.producerStepId).toBe(ids[1]);
  for (const index of [3, 4]) {
    expect(pin.candidates[0]!.bindings[`${index}:requirements-humanized`]?.producerStepId).toBe(
      ids[2],
    );
    expect(pin.candidates[0]!.bindings[`${index}:requirements-draft`]?.producerStepId).toBe(ids[1]);
    const input = projectStepPorts(ids).nodes[index]!.inputs.find(
      (i) => i.id === 'effective-requirements',
    );
    expect(input).toMatchObject({
      adapter: 'effective-requirements',
      alternatives: [{ role: roles[2][0] }, { role: roles[1][0] }],
    });
  }
});
