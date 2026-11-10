import { REPOSITORY_ERROR_CODES, type RepositoryErrorCode } from '@haive/shared';
import { UnrecoverableError } from 'bullmq';

/** Retrying the same Git metadata cannot fix this failure. */
export class CheckoutRepairNeededError extends UnrecoverableError {
  constructor(
    message: string,
    readonly code: RepositoryErrorCode = REPOSITORY_ERROR_CODES.CHECKOUT_REPAIR_NEEDED,
  ) {
    super(message);
  }
}
