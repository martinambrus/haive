import {
  parseRegistryOutputContractRef,
  safeParseStepOutput,
  type StepRoleId,
  type StepOutputContractRef,
} from '@haive/shared/step-outputs';
import { StepOutputContractInvalidError } from './step-output-contract.js';

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const PROMPT_ROLE_REPLY_MAX_BYTES = 256 * 1024;

/** A strict JSON envelope. The generic CLI parser may repair or extract JSON; this mode
 * deliberately parses the recorded reply itself and never trusts that parser's result. */
export function parsePromptRoleOutput(
  raw: string,
  provided: { role: StepRoleId; contract: StepOutputContractRef },
  stepId: string,
  limits: { maxBytes?: number } = {},
) {
  const fail = (paths: readonly string[]): never => {
    throw new StepOutputContractInvalidError(provided.contract, stepId, paths);
  };
  if (Buffer.byteLength(raw, 'utf8') > (limits.maxBytes ?? PROMPT_ROLE_REPLY_MAX_BYTES))
    return fail(['$reply.too-large']);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* reported below without reply content */
  }
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

/** Structured producers store the parsed payload once, checked again by role readers. */
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
