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
export { CLOSED_GAP_INTO_IDLE_MS } from './closed-gap.js';
export { isLockNotAvailable, isUniqueViolation, isUndefinedTable } from './pg-errors.js';
export {
  TASK_ATTACHMENTS_LOCK_TIMEOUT_MS,
  withTaskAttachmentsLock,
  type DbTx,
} from './task-attachments-lock.js';
export {
  ROOT_CLAIM_RENEW_MS,
  ROOT_CLAIM_STALE_MS,
  acquireRootClaim,
  claimRepositoryRoot,
  renewRootClaim,
  isRootClaimLive,
  readLiveRootClaim,
  releaseRepositoryRoot,
  rootClaimRefusal,
  type RootClaim,
  type RootClaimHandle,
  type RootClaimKind,
} from './repo-root-claim.js';
