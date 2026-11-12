import postgres from 'postgres';
import type { Database } from './index.js';

// Per process, including clients still connecting or closing. Api and worker each
// leave capacity for their main pool and for the other service's auth holders.
const MAX_CLI_AUTH_LOCK_CONNECTIONS = 32;
let authConnections = 0;

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
    // The previous holder may have released after bounded teardown while Docker still
    // owns a writable auth mount. Check on this client, without pinning the main pool.
    const [quarantine] = await client`
      select exists (select 1 from cli_auth_containers where scope = ${scope}) as blocked,
      pg_backend_pid() as pid`;
    if (!quarantine || quarantine.pid !== row.pid) throw new CliAuthLockLostError();
    if (quarantine.blocked) {
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
        try {
          const [current] = await client`select pg_backend_pid() as pid`;
          if (released || current?.pid !== row.pid) throw new CliAuthLockLostError();
        } catch {
          // postgres.js may reconnect transparently. Never adopt its replacement session.
          lost = true;
          throw new CliAuthLockLostError();
        }
      },
    });
  } catch (err) {
    await close();
    throw err;
  }
}

/** Record before start, while holding the scope lock. Survives lock loss or API restart. */
export async function recordCliAuthContainer(
  db: Database,
  scope: string,
  dockerContainerId: string,
): Promise<void> {
  await db.$client`
    insert into cli_auth_containers (docker_container_id, scope)
    values (${dockerContainerId}, ${scope})`;
}

/** Call only once Docker confirmed removal (including 404), never on an uncertain error. */
export async function forgetCliAuthContainer(
  db: Database,
  dockerContainerId: string,
): Promise<void> {
  await db.$client`delete from cli_auth_containers where docker_container_id = ${dockerContainerId}`;
}
