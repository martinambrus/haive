import { logger } from '@haive/shared';

/** The first signal runs `run`; a second logs and waits on it; a third exits at once. */
export function guardShutdown(
  run: (signal: string) => Promise<void>,
  exit: (code: number) => void,
): (signal: string) => Promise<void> {
  let running: Promise<void> | undefined;
  let signals = 0;
  return (signal) => {
    signals += 1;
    if (!running) {
      running = run(signal);
    } else if (signals === 2) {
      logger.warn(
        { signal },
        'Worker already shutting down; waiting for it (signal again to exit at once)',
      );
    } else {
      logger.error({ signal }, 'Worker shutdown signalled again; exiting at once');
      exit(1);
    }
    return running;
  };
}
