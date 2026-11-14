import { TaskCancelledError, type StepContext } from '@haive/shared/step';

export function checkHostCancellation(ctx: StepContext): void {
  ctx.throwIfCancelled();
  if (ctx.signal.aborted) throw new TaskCancelledError();
}

/** Normalize aborts to the runner's control class, including during an awaited read.
 * The underlying operation retains its handlers and owns descriptor cleanup. */
export async function hostCall<T>(ctx: StepContext, operation: () => Promise<T>): Promise<T> {
  checkHostCancellation(ctx);
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      try {
        checkHostCancellation(ctx);
      } catch (error) {
        reject(error);
      }
    };
    ctx.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const value = await Promise.race([operation(), cancelled]);
    checkHostCancellation(ctx);
    return value;
  } catch (error) {
    checkHostCancellation(ctx);
    throw error;
  } finally {
    ctx.signal.removeEventListener('abort', abort);
  }
}
