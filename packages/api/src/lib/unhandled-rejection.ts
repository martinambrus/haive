import { logger } from '@haive/shared';

// Node exits on a stray rejection by default; log it and keep serving, as the worker does.
export function installUnhandledRejectionLogger(
  proc: NodeJS.EventEmitter = process,
  log: Pick<typeof logger, 'error'> = logger,
): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    log.error({ err: reason }, 'unhandled promise rejection (api kept alive)');
  });
}
