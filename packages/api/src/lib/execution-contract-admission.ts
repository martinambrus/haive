import { assertExecutionContractSupported, ExecutionContractError } from '@haive/shared/modularity';
import { HttpError } from '../context.js';

/** Both creation and START refuse a promise this worker cannot yet execute. */
export function assertExecutionContractUsable(raw: unknown): void {
  try {
    assertExecutionContractSupported(raw);
  } catch (error) {
    if (!(error instanceof ExecutionContractError)) throw error;
    throw new HttpError(409, error.message, error.code);
  }
}
