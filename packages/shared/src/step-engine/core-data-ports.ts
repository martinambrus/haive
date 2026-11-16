import {
  rolePortDeclarationsSchema,
  promptRolePortDeclarationsSchema,
  type RolePortDeclarations,
} from './role-port-declarations.js';
import {
  SPEC_ROLES,
  DISCOVERY_ROLE,
  REQUIREMENTS_ROLES,
  STEP_ROLES,
  STEP_ROLE_REGISTRY,
  type StepRoleId,
  type StepOutputContractRef,
} from './output-contracts.js';
import type { PortNode, StepPort } from './step-ports.js';

export interface DataInput {
  input: string;
  role: StepRoleId;
  contract: StepOutputContractRef;
  optional: boolean;
}
const input = (name: string, role: StepRoleId): DataInput =>
  Object.freeze({
    input: name,
    role,
    contract: STEP_ROLE_REGISTRY[role].contract,
    optional: true,
  });
const stages = Object.freeze([
  input('resolved', SPEC_ROLES.resolved),
  input('checked', SPEC_ROLES.checked),
  input('draft', SPEC_ROLES.draft),
]);
/** One vocabulary for core declarations, admission and the host stage adapters.
 * Each stage is pinned separately: optional runtime fallback is the host's decision. */
export const SPEC_INPUTS: Readonly<Record<string, readonly DataInput[]>> = Object.freeze({
  '05-phase-0b5-spec-quality': Object.freeze([input('draft', SPEC_ROLES.draft)]),
  '05a-resolve-spec-warnings': Object.freeze([
    input('checked', SPEC_ROLES.checked),
    input('draft', SPEC_ROLES.draft),
  ]),
  '06-gate-1-spec-approval': stages,
  ...Object.fromEntries(
    [
      '06-run-config',
      '06b-sprint-planning',
      '07-phase-2-implement',
      '07a-code-simplify',
      '07b-phase-4-validate',
      '08a-browser-verify',
      '08b-test-management',
      STEP_ROLES.codeReview,
      STEP_ROLES.codeAudit,
      '08d-adversarial-qa',
      '08e-insights-triage',
      '11f-plan-reconcile',
    ].map((id) => [id, stages]),
  ),
});
export const EFFECTIVE_REQUIREMENTS_ROLES = Object.freeze([
  REQUIREMENTS_ROLES.humanized,
  REQUIREMENTS_ROLES.draft,
] as const);
const requirementsStages = Object.freeze([
  input('requirements-humanized', REQUIREMENTS_ROLES.humanized),
  input('requirements-draft', REQUIREMENTS_ROLES.draft),
]);
export const DISCOVERY_REQUIREMENTS_INPUTS: Readonly<Record<string, readonly DataInput[]>> =
  Object.freeze({
    '03b-business-requirements': Object.freeze([input('discovery', DISCOVERY_ROLE)]),
    '03b2-humanize-requirements': Object.freeze([
      input('requirements-draft', REQUIREMENTS_ROLES.draft),
    ]),
    '03c-business-requirements-review': requirementsStages,
    '04-phase-0b-pre-planning': Object.freeze([
      input('discovery', DISCOVERY_ROLE),
      ...requirementsStages,
    ]),
  });
export const CORE_STAGE_INPUTS: Readonly<Record<string, readonly DataInput[]>> = Object.freeze({
  ...SPEC_INPUTS,
  ...DISCOVERY_REQUIREMENTS_INPUTS,
});
const reviewInputs = Object.freeze([input('review', STEP_ROLES.codeReview)]);
export const CORE_DATA_INPUTS: Readonly<Record<string, readonly DataInput[]>> = Object.freeze({
  ...CORE_STAGE_INPUTS,
  '09-gate-2-verify-approval': Object.freeze([
    ...reviewInputs,
    input('audit', STEP_ROLES.codeAudit),
  ]),
  '11-phase-8-learning': reviewInputs,
});
export type DataRoleBindings = Readonly<
  Record<string, { stepId: string; outputContract: { id: string; version: number } }>
>;
const port = (role: StepRoleId, id: string, optional: boolean): StepPort => ({
  id,
  role,
  contract: { ...STEP_ROLE_REGISTRY[role].contract },
  authorship: STEP_ROLE_REGISTRY[role].authorship,
  optional,
});
/** Host declarations plus exact module data ports. V2 host-policy occupancy retains
 * its inherited inputs; a new data declaration never establishes occupancy. */
export function dataPortNodes(
  stepIds: readonly string[],
  roleBindings: DataRoleBindings = {},
  entries: ReadonlyMap<string, RolePortDeclarations> = new Map(),
): PortNode[] {
  return stepIds.map((id) => {
    const occupied = Object.keys(roleBindings).find((role) => roleBindings[role]!.stepId === id);
    const declared = (
      id.startsWith('custom.') ? promptRolePortDeclarationsSchema : rolePortDeclarationsSchema
    ).parse(entries.get(id) ?? {});
    for (const d of declared.consumesRoles ?? []) {
      const inherited = CORE_DATA_INPUTS[occupied ?? id]?.find((c) => c.input === d.input);
      if (
        inherited &&
        (inherited.role !== d.role ||
          inherited.contract.id !== d.contract.id ||
          inherited.contract.version !== d.contract.version ||
          inherited.optional !== d.optional)
      )
        throw new Error(`data-role-input-conflict: ${id}.${d.input}`);
    }
    const declarations = [
      ...(CORE_DATA_INPUTS[occupied ?? id] ?? []),
      ...(declared.consumesRoles ?? []).filter(
        (d) => !(CORE_DATA_INPUTS[occupied ?? id] ?? []).some((c) => c.input === d.input),
      ),
    ];
    const outputs = Object.values(STEP_ROLE_REGISTRY)
      .filter((entry) => {
        const bound = roleBindings[entry.id];
        return (
          (bound?.stepId ?? entry.legacyStepId) === id &&
          (!bound ||
            (bound.outputContract.id === entry.contract.id &&
              bound.outputContract.version === entry.contract.version))
        );
      })
      .map((entry) => port(entry.id, entry.id, false));
    for (const provided of declared.providesRoles ?? []) {
      if (!outputs.some((p) => p.role === provided.role))
        outputs.push(port(provided.role, provided.role, false));
    }
    return {
      id,
      label: id,
      outputs,
      inputs: declarations.map((d) => ({
        ...port(d.role, d.input, d.optional),
        contract: { ...d.contract },
      })),
    };
  });
}
