import { type Database } from '@haive/database';

/**
 * Idempotent data fixes applied on every worker boot. Each helper must be
 * narrow, fast, and a no-op on a clean DB so that re-running on every restart
 * costs nothing.
 */
export async function runDataMigrations(_db: Database): Promise<void> {
  // No data migrations required for the current schema. The previous zai
  // auth-mode migration is obsolete now that the CLI path handles api_key
  // providers natively.
}
