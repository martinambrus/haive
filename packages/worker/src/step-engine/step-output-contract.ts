import { rolePortDeclarationsSchema } from '@haive/shared/modularity';
import {
  parseStepOutputContractRef,
  STEP_ROLE_REGISTRY,
  safeParseStepOutput,
  stepOutputContractsEqual,
  stepRoleOutputContract,
  type StepOutputContractRef,
  type LegacyStepRoleId as StepRoleId,
} from '@haive/shared/step-outputs';
import { fixConsumerSchema, type ComposableStepEntry } from '@haive/shared/modularity';
import type { StepDefinition } from './step-definition.js';
import { promptRoleOutputValue } from './prompt-role-output.js';

type Declaration = Pick<
  StepDefinition,
  'outputContract' | 'replaces' | 'fixConsumer' | 'providesRoles' | 'consumesRoles'
> &
  Partial<
    Pick<
      StepDefinition,
      'metadata' | 'fixLoop' | 'restartLoop' | 'reviseLoop' | 'loop' | 'fixLoopOnError'
    >
  >;

export function hasConflictingReplacementHooks(step: Declaration): boolean {
  return !!(
    step.fixLoop ||
    step.restartLoop ||
    step.reviseLoop ||
    step.loop ||
    step.fixLoopOnError
  );
}

/** Boot validation of executable declarations; no module-defined validators. */
export function assertStepOutputDeclaration(step: Declaration): void {
  if (step.fixConsumer !== undefined && !fixConsumerSchema.safeParse(step.fixConsumer).success)
    throw new Error('fix-consumer-invalid');
  if (!rolePortDeclarationsSchema.safeParse(step).success)
    throw new Error('step-data-role-invalid');
  if (step.outputContract !== undefined && !parseStepOutputContractRef(step.outputContract)) {
    throw new Error('step-output-contract-unknown');
  }
  if (step.replaces === undefined) return;
  if (
    step.replaces.length &&
    (hasConflictingReplacementHooks(step) || step.metadata?.allowSkip === true)
  )
    throw new Error('step-output-role-policy-incompatible');
  if (!Array.isArray(step.replaces) || new Set(step.replaces).size !== step.replaces.length) {
    throw new Error('step-output-role-invalid');
  }
  for (const role of step.replaces) {
    if (role !== '08c-code-review' && role !== '08c2-code-audit') {
      throw new Error('step-output-role-invalid');
    }
    if (!stepOutputContractsEqual(stepRoleOutputContract(role), step.outputContract)) {
      throw new Error('step-output-contract-mismatch');
    }
  }
}

/** Executable and serialized catalog metadata describe the same promise. */
export function assertMatchingOutputDeclaration(
  step: Declaration,
  entry: ComposableStepEntry,
  compareDataPorts = true,
): void {
  assertStepOutputDeclaration(step);
  assertStepOutputDeclaration(entry);
  if (step.fixConsumer?.version !== entry.fixConsumer?.version)
    throw new Error('fix-consumer-mismatch');
  if (
    (step.outputContract !== undefined || entry.outputContract !== undefined) &&
    !stepOutputContractsEqual(step.outputContract, entry.outputContract)
  )
    throw new Error('step-output-contract-mismatch');
  for (const key of compareDataPorts ? (['providesRoles', 'consumesRoles'] as const) : []) {
    const normalize = (d: Declaration) =>
      [...(d[key] ?? [])]
        .map((p) => ({
          role: p.role,
          contract: { id: p.contract.id, version: p.contract.version },
          ...('input' in p && 'optional' in p ? { input: p.input, optional: p.optional } : {}),
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (JSON.stringify(normalize(step)) !== JSON.stringify(normalize(entry)))
      throw new Error('step-data-role-mismatch');
  }
  const roles = (declaration: Declaration) => [...(declaration.replaces ?? [])].sort();
  if (JSON.stringify(roles(step)) !== JSON.stringify(roles(entry))) {
    throw new Error('step-output-role-mismatch');
  }
}

/** A producer bug, never an implementation diagnosis or an automatic fix round. */
export class StepOutputContractInvalidError extends Error {
  readonly code = 'step-output-contract-invalid';
  /** issuePaths comes from the shared parser's bounded, value-free diagnostics. */
  constructor(ref: StepOutputContractRef, producer: string, issuePaths: readonly string[]) {
    super(
      `step-output-contract-invalid: ${ref.id}@${ref.version} producer ${producer}: ${issuePaths.join(', ')}`,
    );
    this.name = 'StepOutputContractInvalidError';
  }
}

/** Called only after a successful apply return. Keep the ORIGINAL output on every write.
 * A declaration of replaces is capability, not proof that this run occupies a role.
 * The runner supplies only pinned role occupancy. Built-in producers always warn and
 * persist on schema drift. */
export function validateSuccessfulStepOutput(
  step: StepDefinition,
  output: unknown,
  logger: { warn(bindings: object, message: string): void },
  replacedRole?: StepRoleId,
): void {
  for (const provided of step.providesRoles ?? []) {
    const ref = STEP_ROLE_REGISTRY[provided.role].contract;
    // Match readDataRole: prompt producers store one role envelope; core/module
    // producers return the payload itself. The envelope must name this exact port.
    const value = step.metadata.id.startsWith('custom.')
      ? promptRoleOutputValue(output, provided.role, ref)
      : output;
    const result = safeParseStepOutput(ref, value);
    if (!result.success)
      throw new StepOutputContractInvalidError(ref, step.metadata.id, result.issuePaths);
  }
  const ref = step.outputContract;
  const builtin = step.metadata.id === '08c-code-review' || step.metadata.id === '08c2-code-audit';
  const replacement = !builtin && replacedRole !== undefined;
  if (replacement) {
    if (
      !step.replaces?.includes(replacedRole) ||
      !stepOutputContractsEqual(ref, stepRoleOutputContract(replacedRole))
    ) {
      throw new Error('step-output-role-mismatch');
    }
  }
  if (ref === undefined) return;
  const result = safeParseStepOutput(ref, output);
  if (result.success) return;
  if (replacement)
    throw new StepOutputContractInvalidError(ref, step.metadata.id, result.issuePaths);
  // Never log the Zod error: it may retain input values. Paths contain only host schema
  // keys and array offsets, and are bounded by the shared parser.
  logger.warn(
    {
      contractId: parseStepOutputContractRef(ref)?.id ?? 'unknown',
      contractVersion: parseStepOutputContractRef(ref)?.version ?? null,
      producer: step.metadata.id,
      issuePaths: result.issuePaths,
    },
    'step output does not match host contract; preserving output',
  );
}
