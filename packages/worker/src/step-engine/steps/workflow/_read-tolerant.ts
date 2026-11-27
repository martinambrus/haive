import { rethrowIfConfigUnavailable } from '@haive/shared';

/** One config read for detect(): an outage propagates, any other failure leaves the value
 *  unset so apply() reads it live as it always did. */
export async function readTolerant<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    rethrowIfConfigUnavailable(err);
    return undefined;
  }
}
