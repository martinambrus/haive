import type { Database } from '@haive/database';
import type { MaintenanceState } from '../system/maintenance.js';

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

export type ModuleRouteContext = {
  db: Database;
};

export type ModuleSettingsKind = 'global' | 'admin';

/** The ConfigService key a module setting is stored under; the api's settings routes write it. */
export const moduleSettingKey = (moduleId: string, kind: ModuleSettingsKind, field: string) =>
  `config:module:${moduleId}:${kind}:${field}`;

/** The Redis pattern that matches every key `moduleSettingKey` builds for the module, and no other module's. */
export const moduleSettingsPattern = (moduleId: string) => `config:module:${moduleId}:*`;
