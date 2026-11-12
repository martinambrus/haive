import { tryCliAuthLock, type CliAuthLock, type Database } from '@haive/database';

/** Wait outside a transaction; zero waits still try once for opportunistic callers. */
export async function waitForCliAuthLock(
  db: Database,
  scope: string,
  lockWaitMs: number,
): Promise<CliAuthLock | null> {
  const deadline = Date.now() + lockWaitMs;
  do {
    const lock = await tryCliAuthLock(db, scope);
    if (lock || Date.now() >= deadline) return lock;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
  } while (true);
}
