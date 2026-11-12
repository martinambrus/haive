import postgres from 'postgres';
import type { Database } from './index.js';

// Per process, including clients still connecting or closing. Api and worker each
// leave capacity for their main pool and for the other service's auth holders.
const MAX_CLI_AUTH_LOCK_CONNECTIONS = 32;
let authConnections = 0;
/** A holder checks its lock inside write transactions; a hung dedicated socket must not pin the
 *  main-pool connection and row locks behind it (TCP keepalive alone takes minutes). */
export const CLI_AUTH_ASSERT_TIMEOUT_MS = 5_000;

export interface CliAuthLock {
  (): Promise<void>;
  /** Throws permanently once the owning backend is lost or this handle is released. */
  assertHeld(): Promise<void>;
}

export class CliAuthLockLostError extends Error {
  constructor() {
    super('CLI authentication lock was lost; retry the operation');
    this.name = 'CliAuthLockLostError';
  }
}

/** A session lock on a dedicated connection: interactive login can last minutes, and must
 * never pin a main-pool connection or an open transaction. No lease can expire under Docker.
 * Contenders try once; the worker delays its job, freeing the slot needed by login's probe.
 * The server releases the lock if its owner process dies. Closing the dedicated connection
 * releases it even when an explicit unlock would fail. */
export async function tryCliAuthLock(db: Database, scope: string): Promise<CliAuthLock | null> {
  const options = db.$client.options;
  if (!options?.database || !options.user)
    throw new Error('CLI auth lock requires database connection options');
  if (authConnections >= MAX_CLI_AUTH_LOCK_CONNECTIONS) return null;
  authConnections += 1;
  let client: ReturnType<typeof postgres>;
  try {
    client = postgres({
      // postgres accepts its parsed options again (including host/port arrays), although
      // the public input type describes only the pre-parsed scalar form.
      ...(options as unknown as postgres.Options<{}>),
      // parseOptions returns objects with shared verbatim. Never alias the pool's retry
      // counter/type cache, and do not launch its unawaited startup type query.
      shared: { retries: 0, typeArrayMap: {} },
      fetch_types: false,
      max: 1,
      idle_timeout: 0,
      max_lifetime: null,
      connect_timeout: 5,
    } as unknown as postgres.Options<{}>);
  } catch (err) {
    authConnections -= 1;
    throw err;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.end({ timeout: 5 });
    } finally {
      authConnections -= 1;
    }
  };
  try {
    const [row] =
      await client`select pg_try_advisory_lock(hashtextextended(${`cli-auth:${scope}`}, 0)) as held, pg_backend_pid() as pid`;
    if (!row?.held) {
      await close();
      return null;
    }
    let released = false;
    let lost = false;
    const release = async () => {
      if (released) return;
      released = true;
      await close();
    };
    return Object.assign(release, {
      assertHeld: async () => {
        if (released || lost) throw new CliAuthLockLostError();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const [current] = await Promise.race([
            client`select pg_backend_pid() as pid`,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new CliAuthLockLostError()),
                CLI_AUTH_ASSERT_TIMEOUT_MS,
              );
            }),
          ]);
          if (released || current?.pid !== row.pid) throw new CliAuthLockLostError();
        } catch {
          // postgres.js may reconnect transparently. Never adopt its replacement session.
          lost = true;
          throw new CliAuthLockLostError();
        } finally {
          clearTimeout(timer);
        }
      },
    });
  } catch (err) {
    await close();
    throw err;
  }
}
