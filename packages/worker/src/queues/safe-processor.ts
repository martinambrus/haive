import type { Processor } from 'bullmq';
import { safeErrorForTransport } from '@haive/shared/logger';

/** Keep every job kind safe before BullMQ persists message and stack without structure. */
export function safeProcessor<T, R, N extends string = string>(
  processor: Processor<T, R, N>,
): Processor<T, R, N> {
  return async (job, token, signal) => {
    try {
      return await processor(job, token, signal);
    } catch (err) {
      throw safeErrorForTransport(err, job);
    }
  };
}
