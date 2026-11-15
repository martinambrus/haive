import { it, expect } from 'vitest';
import { readStepRole, type RoleBinding } from '../src/step-engine/step-role-reader.js';
import { SPEC_ROLES } from '../src/step-engine/output-contracts.js';
import type { StepDefinition, StepRoleId } from '../src/step/index.js';

// Compile-only controls; the package typecheck includes this file.
function typeControls(role: StepRoleId) {
  const replaces: StepDefinition['replaces'] = [role];
  // @ts-expect-error spec data ports have no legacy physical identity or v1/v2 binding
  readStepRole({}, SPEC_ROLES.draft, (binding) => binding);
  // @ts-expect-error a v1/v2 binding can only represent host-policy roles
  const bindingRole: RoleBinding['role'] = SPEC_ROLES.checked;
  return { replaces, bindingRole };
}
it('retains the replaceable SDK role surface', () => {
  expect(typeof typeControls).toBe('function');
});
