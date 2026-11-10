import { UnrecoverableError } from 'bullmq';

/** Retrying the same Git metadata cannot fix this failure. */
export class CheckoutRepairNeededError extends UnrecoverableError {
  constructor(
    message: string,
    readonly code: 'checkout_repair_needed' | 'source_repair_needed' = 'checkout_repair_needed',
  ) {
    super(message);
  }
}
