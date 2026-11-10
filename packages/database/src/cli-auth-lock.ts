import postgres from 'postgres';
import type { Database } from './index.js';

/** A session lock on a dedicated connection: interactive login can last minutes, and must
 * never pin a main-pool connection or an open transaction. No lease can expire under Docker.
 * Contenders try once; the worker delays its job, freeing the slot needed by login's probe.
 * The server releases the lock if its owner process dies. Closing the dedicated connection
 * releases it even when an explicit unlock would fail. */
export async function tryCliAuthLock(
  db: Database,
  scope: string,
): Promise<(() => Promise<void>) | null> {
  const options = db.$client.options;
  if (!options?.database || !options.user)
    throw new Error('CLI auth lock requires database connection options');
  const client = postgres({
    // postgres accepts its parsed options again (including host/port arrays), although
    // the public input type describes only the pre-parsed scalar form.
    ...(options as unknown as postgres.Options<{}>),
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: 5,
  });
  try {
    const [row] =
      await client`select pg_try_advisory_lock(hashtextextended(${`cli-auth:${scope}`}, 0)) as held`;
    if (!row?.held) {
      await client.end({ timeout: 5 });
      return null;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await client.end({ timeout: 5 });
    };
  } catch (err) {
    await client.end({ timeout: 5 });
    throw err;
  }
}
