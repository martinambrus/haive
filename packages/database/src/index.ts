import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(connectionString: string) {
  const client = postgres(connectionString, { max: 10 });
  return drizzle(client, { schema });
}

export * as schema from './schema/index.js';
export type { StepIterationEntry, MergeResolveState } from './schema/index.js';
export type { StepGuidanceScope, StepGuidanceCause, StepGuidanceStatus } from './schema/index.js';
export { waitForDatabaseReady, type WaitForDatabaseOptions } from './wait-for-ready.js';
export { resetDagCurrentLevelForRetry } from './dag-reset.js';
export { isUniqueViolation, isUndefinedTable } from './pg-errors.js';
