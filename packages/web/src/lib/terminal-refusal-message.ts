import { TERMINAL_CLOSE_CODES } from '@haive/shared/constants';

/** Fixed copy keyed only by the protocol code; close reasons are not display copy. */
export function terminalRefusalMessage(code: number): string | null {
  switch (code) {
    case TERMINAL_CLOSE_CODES.CONTAINER_NOT_RUNNING:
      return 'The container is not running. Start it before opening the terminal.';
    case TERMINAL_CLOSE_CODES.CONTAINER_NOT_BOUND:
      return 'The container has no Docker binding. Recreate it before opening the terminal.';
    case TERMINAL_CLOSE_CODES.TASK_TERMINAL_DISABLED:
      return 'The task has ended. Its terminal is disabled.';
    case TERMINAL_CLOSE_CODES.REPO_READ_ONLY:
      return 'Terminals are unavailable for read-only local repositories. Import a writable copy to use a terminal.';
    case TERMINAL_CLOSE_CODES.REPO_NOT_READY:
      return 'The repository is not ready. Wait until it is ready before opening the terminal.';
    default:
      return null;
  }
}
