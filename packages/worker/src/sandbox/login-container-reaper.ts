import Docker from 'dockerode';
import type { Redis } from 'ioredis';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { installId, installLabel, INSTALL_LABEL, logger } from '@haive/shared';
import {
  CLI_LOGIN_LABEL,
  CLI_LOGIN_LEASE_LABEL,
  cliLoginLeaseKey,
} from '@haive/shared/cli-login-lease';

const log = logger.child({ module: 'login-container-reaper' });
// Old API: up to 2 min before start, then 10 min session + 30 s teardown; round up.
export const LEGACY_LOGIN_GRACE_MS = 13 * 60_000;
export const LOGIN_REAPER_INTERVAL_MS = 30_000;
const DOCKER_TIMEOUT_MS = 10_000;

export interface LoginContainerReaperDeps {
  list(): Promise<{ id: string; createdAt: number; leaseId?: string }[]>;
  remove(id: string): Promise<void>;
}

/** Labels recover even an insert failure. Old containers had no labels at all: recover those
 * only by their exact Docker id in this database, including rows already marked destroyed. */
export function loginContainerReaperDeps(
  db: Database,
  docker = new Docker({ timeout: DOCKER_TIMEOUT_MS }),
): LoginContainerReaperDeps {
  return {
    async list() {
      const labelled = await docker.listContainers({
        all: true,
        filters: { label: [`${CLI_LOGIN_LABEL}=1`, installLabel()] },
      });
      const unlabelled = (await docker.listContainers({ all: true })).filter(
        (c) => !c.Labels?.[CLI_LOGIN_LABEL],
      );
      const rows =
        unlabelled.length === 0
          ? []
          : await db
              .select({ dockerContainerId: schema.containers.dockerContainerId })
              .from(schema.containers)
              .where(
                and(
                  eq(schema.containers.purpose, 'cli_login'),
                  inArray(
                    schema.containers.dockerContainerId,
                    unlabelled.map((c) => c.Id),
                  ),
                ),
              );
      const legacyIds = new Set(rows.map((r) => r.dockerContainerId));
      return [
        ...labelled.filter((c) => c.Labels?.[INSTALL_LABEL] === installId()),
        ...unlabelled.filter((c) => legacyIds.has(c.Id)),
      ].map((c) => ({
        id: c.Id,
        createdAt: c.Created * 1000,
        leaseId: c.Labels?.[CLI_LOGIN_LEASE_LABEL] || undefined,
      }));
    },
    async remove(id) {
      try {
        await docker.getContainer(id).remove({ force: true });
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      }
      await db
        .update(schema.containers)
        .set({ status: 'destroyed', destroyedAt: new Date() })
        .where(
          and(
            eq(schema.containers.purpose, 'cli_login'),
            eq(schema.containers.dockerContainerId, id),
          ),
        );
    },
  };
}

export async function sweepLoginContainers(
  redis: Pick<Redis, 'mget'>,
  deps: LoginContainerReaperDeps,
  options: { graceMs?: number } = {},
): Promise<number> {
  const containers = await deps.list();
  if (containers.length === 0) return 0;
  const keys = containers.filter((c) => c.leaseId).map((c) => cliLoginLeaseKey(c.leaseId!));
  let leases: (string | null)[];
  try {
    // Also verify Redis for a legacy-only pass: unreadable means unknown for every container.
    leases = await redis.mget(...(keys.length ? keys : [cliLoginLeaseKey('health')]));
  } catch {
    log.warn('login container leases unreadable; keeping every container this pass');
    return 0;
  }
  const held = new Set(keys.filter((_key, i) => leases[i] !== null));
  let removed = 0;
  for (const c of containers) {
    if (
      c.leaseId
        ? held.has(cliLoginLeaseKey(c.leaseId))
        : !Number.isFinite(c.createdAt) ||
          Date.now() - c.createdAt < (options.graceMs ?? LEGACY_LOGIN_GRACE_MS)
    )
      continue;
    try {
      await deps.remove(c.id);
      removed++;
    } catch (err) {
      log.warn(
        { err, dockerContainerId: c.id },
        'orphan login container removal failed; will retry',
      );
    }
  }
  return removed;
}

/** Independent of usage enablement, queue congestion and API restarts. Boot plus periodic,
 * serial passes match the other runtime reapers; no database session spans Redis or Docker. */
export function startLoginContainerReaper(
  redis: Pick<Redis, 'mget'>,
  deps: LoginContainerReaperDeps,
  options: { intervalMs?: number; graceMs?: number } = {},
): () => void {
  let inFlight = false;
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    void sweepLoginContainers(redis, deps, options)
      .catch((err) => log.warn({ err }, 'login container sweep failed'))
      .finally(() => {
        inFlight = false;
      });
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? LOGIN_REAPER_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
