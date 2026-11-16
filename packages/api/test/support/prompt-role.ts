import type * as Outputs from '../../../shared/dist/step-engine/output-contracts.js';

/** Test-only agent data role. Reuses a host validator; never exported by production. */
export const TEST_PROMPT_ROLE = 'test.agent-report' as Outputs.StepRoleId;
export function withTestPromptRole(actual: typeof Outputs) {
  const role = TEST_PROMPT_ROLE;
  const contract = actual.CODE_AUDIT_OUTPUT_CONTRACT;
  const registry = Object.freeze({
    ...actual.STEP_ROLE_REGISTRY,
    [role]: Object.freeze({
      id: role,
      contract,
      cardinality: 'one',
      authorship: 'agent',
      quoteProjection: 'agent',
      legacyStepId: role,
    }),
  });
  return {
    ...actual,
    STEP_ROLE_REGISTRY: registry,
    isQuotableRole: (id: unknown) => id === role || actual.isQuotableRole(id),
    isPromptProvidableRole: (id: unknown) => id === role,
    stepRoleOutputContract: (id: Outputs.StepRoleId) =>
      id === role ? contract : actual.stepRoleOutputContract(id),
    projectRoleOutput: (id: Outputs.StepRoleId, value: unknown) =>
      actual.projectRoleOutput(id === role ? actual.STEP_ROLES.codeAudit : id, value),
  };
}
