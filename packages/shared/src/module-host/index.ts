import type { ZodType } from 'zod';
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

export interface IntegrationVendorRequest {
  method: string;
  url: string;
  query?: Record<string, string>;
  json?: unknown;
  headers?: Record<string, string>;
}

/** Resolves for a 2xx answer only (the body is parsed JSON for a JSON content type, else text) and throws otherwise. */
export interface IntegrationVendorClient {
  request(options: IntegrationVendorRequest): Promise<{ status: number; body: unknown }>;
}

export interface IntegrationCall<TArgs = unknown> {
  args: TArgs;
  vendor: IntegrationVendorClient;
  signal: AbortSignal;
  account: { label: string | null; externalAccountId: string | null };
}

export interface IntegrationExecutor<TArgs = unknown> {
  args: ZodType<TArgs>;
  run(call: IntegrationCall<TArgs>): Promise<unknown>;
}

/** A module's executors by provider id, then operation id. */
export type ModuleIntegrationExecutors = Record<string, Record<string, IntegrationExecutor>>;

/** The ConfigService key a module setting is stored under; the api's settings routes write it. */
export const moduleSettingKey = (moduleId: string, kind: ModuleSettingsKind, field: string) =>
  `config:module:${moduleId}:${kind}:${field}`;

/** The Redis pattern that matches every key `moduleSettingKey` builds for the module, and no other module's. */
export const moduleSettingsPattern = (moduleId: string) => `config:module:${moduleId}:*`;
