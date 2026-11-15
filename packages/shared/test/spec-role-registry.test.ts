import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readStepRole, projectStepOutputRoles } from '../src/step-engine/step-role-reader.js';
import { moduleManifestSchema } from '../src/modularity/manifest.js';
import { parsePromptTemplate } from '../src/modularity/prompt-steps.js';
import {
  STEP_ROLE_REGISTRY,
  SPEC_ROLES,
  HOST_POLICY_STEP_ROLES,
  stepRoleOutputContract,
  safeParseStepOutput,
  parseStepOutputContractRef,
} from '../src/step-engine/output-contracts.js';
import { parseDerivedRunPlan } from '../src/modularity/derived-task-types.js';
import { composableStepEntrySchema } from '../src/modularity/contracts.js';
import { rolePlan, rolePin, REVIEW, AUDIT, PRODUCER } from './step-role-fixtures.js';

describe('host spec registry and frozen old plans', () => {
  it('registers mixed, non-quotable stages without extending host policy', () => {
    expect(Object.isFrozen(STEP_ROLE_REGISTRY)).toBe(true);
    expect(HOST_POLICY_STEP_ROLES).toEqual(['08c-code-review', '08c2-code-audit']);
    for (const role of Object.values(SPEC_ROLES)) {
      const entry = STEP_ROLE_REGISTRY[role];
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.contract)).toBe(true);
      expect(entry.authorship).toBe('mixed');
      expect('quoteProjection' in entry).toBe(false);
      const ref = stepRoleOutputContract(role);
      expect(parseStepOutputContractRef(ref)).toBeNull();
      expect(parseStepOutputContractRef({ ...ref, version: 2 })).toBeNull();
      expect(safeParseStepOutput(ref, { spec: '', extension: true })).toMatchObject({
        success: true,
        data: { spec: '', extension: true },
      });
      expect(safeParseStepOutput(ref, { spec: 42 }).success).toBe(false);
    }
  });
  it('keeps the base decoder, bindings and DTO projection byte-identical', () => {
    // Captured by executing the original decoder/reader at c51a58516, not the new code.
    const baseline = JSON.parse(
      readFileSync(new URL('./step-role-legacy-bytes.json', import.meta.url), 'utf8'),
    ) as { decoded: string; bindings: string; projection: string }[];
    for (const version of [1, 2] as const) {
      const expected = baseline[version - 1]!;
      expect(JSON.stringify(parseDerivedRunPlan(rolePlan(version)))).toBe(expected.decoded);
      expect(
        JSON.stringify(
          ([REVIEW, AUDIT] as const).map((role) => readStepRole(rolePin(version), role, (b) => b)),
        ),
      ).toBe(expected.bindings);
      expect(
        JSON.stringify(
          projectStepOutputRoles(rolePin(version), [
            { stepId: REVIEW },
            { stepId: AUDIT },
            { stepId: PRODUCER },
            { stepId: '04-phase-0b-pre-planning' },
          ]),
        ),
      ).toBe(expected.projection);
    }
  });
  it('adds no generic role prompt token', () => {
    for (const role of Object.values(SPEC_ROLES)) {
      expect(parsePromptTemplate('{{role:' + role + '}}').ok).toBe(false);
    }
  });
  it('keeps v1/v2 fixture bytes and refuses spec bindings and replacements', () => {
    for (const version of [1, 2] as const) {
      const plan = rolePlan(version);
      expect(parseDerivedRunPlan(plan)).toEqual(plan);
    }
    const plan = rolePlan(2);
    Object.assign(plan.candidates[0]!.roleBindings!, {
      [SPEC_ROLES.draft]: {
        stepId: '04-phase-0b-pre-planning',
        outputContract: stepRoleOutputContract(SPEC_ROLES.draft),
      },
    });
    expect(() => parseDerivedRunPlan(plan)).toThrow();
    const declaration = {
      stepId: 'module.example.spec',
      label: 'spec',
      group: 'spec',
      dispatchesCli: true,
      requires: [],
      provides: [],
      replaces: [SPEC_ROLES.draft],
      outputContract: stepRoleOutputContract(SPEC_ROLES.draft),
    };
    expect(composableStepEntrySchema.safeParse(declaration).success).toBe(false);
    expect(
      moduleManifestSchema.safeParse({
        id: 'example',
        name: 'Example',
        version: '1',
        schemaVersion: 1,
        composableSteps: [{ ...declaration, stepId: 'spec' }],
      }).success,
    ).toBe(false);
  });
});

it.each(
  Object.values(SPEC_ROLES).flatMap((role) =>
    ['manifest', 'v1', 'v2'].map((boundary) => ({ role, boundary })),
  ),
)('refuses $role contract in $boundary', ({ role, boundary }) => {
  const declaration = {
    stepId: 'module.example.spec',
    label: 'Spec',
    group: 'spec',
    dispatchesCli: false,
    requires: [],
    provides: [],
    outputContract: stepRoleOutputContract(role),
  };
  const manifest = { id: 'example', name: 'Example', version: '1', schemaVersion: 1 };
  expect(
    moduleManifestSchema.safeParse({
      ...manifest,
      composableSteps: [{ ...declaration, stepId: 'spec', outputContract: undefined }],
    }).success,
  ).toBe(true);
  if (boundary === 'manifest')
    expect(
      moduleManifestSchema.safeParse({
        ...manifest,
        composableSteps: [{ ...declaration, stepId: 'spec' }],
      }).success,
    ).toBe(false);
  const v1 = rolePlan(1);
  v1.composableEntries.push(declaration);
  if (boundary === 'v1') expect(() => parseDerivedRunPlan(v1)).toThrow();
  const v2 = rolePlan(2);
  if (v2.version !== 2) throw new Error('expected v2');
  // Keep the valid replacement declarations; only change the contract at the decode gate.
  v2.candidates[0]!.effectiveEntries![0]!.outputContract = declaration.outputContract;
  if (boundary === 'v2') expect(() => parseDerivedRunPlan(v2)).toThrow();
});
