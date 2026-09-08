import type { MaintenanceState } from '@haive/shared';

export type AppVariables = {
  userId: string;
  userRole: 'admin' | 'user';
  /** Set by the maintenance gate on every request, so a handler can refuse new work while
   *  draining without re-reading the config. */
  maintenanceState: MaintenanceState;
};

export type AppEnv = {
  Variables: AppVariables;
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
