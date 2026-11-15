import {
  parseRegistryOutputContractRef,
  safeParseStepOutput,
  type StepRoleId,
  type StepOutputContractRef,
} from '@haive/shared/step-outputs';
import { StepOutputContractInvalidError } from './step-output-contract.js';

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A strict JSON envelope. The generic CLI parser may repair or extract JSON; this mode
 * deliberately parses the recorded reply itself and never trusts that parser's result. */
export function parsePromptRoleOutput(
  raw: string,
  provided: { role: StepRoleId; contract: StepOutputContractRef },
  stepId: string,
) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* reported below without reply content */
  }
  const fail = (paths: readonly string[]): never => {
    throw new StepOutputContractInvalidError(provided.contract, stepId, paths);
  };
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'data') ||
    !Object.hasOwn(value, 'contract')
  )
    return fail(['$reply']);
  const ref = parseRegistryOutputContractRef(value.contract);
  if (!ref || ref.id !== provided.contract.id || ref.version !== provided.contract.version)
    return fail(['$contract']);
  const parsed = safeParseStepOutput(provided.contract, value.data);
  if (!parsed.success) return fail(parsed.issuePaths);
  return { role: provided.role, contract: provided.contract, data: parsed.data };
}

/** Custom producers keep raw/parsed for physical {{step:}} readers. Role readers see
 * only this separately validated payload, checked again against the pinned contract. */
export function promptRoleOutputValue(
  output: unknown,
  role: StepRoleId,
  contract: StepOutputContractRef,
): unknown {
  if (!record(output) || !Object.hasOwn(output, 'roleOutput')) return output;
  const port = output.roleOutput;
  if (!record(port) || port.role !== role) return undefined;
  const ref = parseRegistryOutputContractRef(port.contract);
  return ref?.id === contract.id && ref.version === contract.version ? port.data : undefined;
}
