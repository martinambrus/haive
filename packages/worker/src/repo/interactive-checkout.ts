import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../redis.js';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { INSTALL_LABEL, RUNNER_SUBPATH_LABEL, installId } from '@haive/shared';
import { CheckoutUnavailableError, requireCheckoutAccess } from '@haive/shared/checkout-access';

export const CHECKOUT_DRAIN_TIMEOUT_MS = 30_000;
export const CHECKOUT_TRANSPORT_TIMEOUT_MS = 10_000;
// Fixed aggregate budget, including enumeration/inspection and absence verification.
// Five minutes leaves room for many sequential ten-second stop graces, while bounding
// even a stuck initial listing before the queue can apply its total defer policy.
export const CHECKOUT_DOCKER_TIMEOUT_MS = 5 * 60_000;
export const CHECKOUT_SESSION_DEFER_MAX_MS = 30 * 60_000;
export const CHECKOUT_SESSION_RETRY_MS = 30_000;

export function checkoutSessionCanRetry(
  reason: string,
  submittedAt: number,
  now = Date.now(),
): boolean {
  return (
    ['docker_unknown', 'session_transport_unknown', 'drain_timeout', 'already_suspending'].includes(
      reason,
    ) && now - submittedAt < CHECKOUT_SESSION_DEFER_MAX_MS
  );
}

/** Single-worker lifecycle fence. Register before the first await; suspension closes admission
 * synchronously, drains even failed boots, then closes PTYs and proves mounts removed. No DB
 * connection is retained while waiting for a boot or Docker. Readiness persists across restart. */
export class InteractiveCheckoutBarrier {
  private readonly entries = new Map<
    string,
    { suspended: boolean; opens: Set<Promise<unknown>> }
  >();

  async open<T>(
    repositoryId: string,
    admission: () => Promise<void>,
    run: (check: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    let entry = this.entries.get(repositoryId);
    if (!entry) {
      entry = { suspended: false, opens: new Set() };
      this.entries.set(repositoryId, entry);
    }
    const current = entry;
    const check = async () => {
      if (current.suspended) throw new CheckoutUnavailableError();
      await admission();
      if (current.suspended) throw new CheckoutUnavailableError();
    };
    // Defer run until the promise has been registered. Even an admission in flight is drained.
    const pending = Promise.resolve().then(async () => {
      await check();
      return run(check);
    });
    current.opens.add(pending);
    try {
      return await pending;
    } finally {
      current.opens.delete(pending);
      if (!current.suspended && current.opens.size === 0) this.entries.delete(repositoryId);
    }
  }

  async suspend(
    repositoryId: string,
    stop: () => Promise<void>,
    drainTimeoutMs = CHECKOUT_DRAIN_TIMEOUT_MS,
  ): Promise<() => void> {
    const entry = this.entries.get(repositoryId) ?? {
      suspended: false,
      opens: new Set<Promise<unknown>>(),
    };
    if (entry.suspended) throw new CheckoutSessionsBusyError('already_suspending');
    entry.suspended = true;
    this.entries.set(repositoryId, entry);
    const release = () => {
      entry.suspended = false;
      if (entry.opens.size === 0) this.entries.delete(repositoryId);
    };
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...entry.opens]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new CheckoutSessionsBusyError('drain_timeout')),
              drainTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await stop();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
}

export const interactiveCheckouts = new InteractiveCheckoutBarrier();
export class CheckoutSessionsBusyError extends Error {
  readonly code = 'checkout_sessions_busy';
  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(
      `Checkout rebuild blocked (${reason}): interactive sessions could not be stopped and verified. Nothing was moved.`,
      { cause },
    );
    this.name = 'CheckoutSessionsBusyError';
  }
}

/** A deadline cannot cancel an already sent Redis/Docker request. Observe its eventual
 * rejection via race and fence every continuation before it can issue another request. */
async function withSessionDeadline(
  reason: 'session_transport_unknown' | 'docker_unknown',
  timeoutMs: number,
  run: (check: () => void) => Promise<void>,
): Promise<void> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (expired) throw new CheckoutSessionsBusyError(reason);
  };
  try {
    await Promise.race([
      Promise.resolve().then(() => run(check)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new CheckoutSessionsBusyError(reason));
        }, timeoutMs);
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}

export async function withInteractiveCheckout<T>(
  db: Database,
  repositoryId: string | null | undefined,
  run: (check: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!repositoryId) return run(async () => {});
  return interactiveCheckouts.open(
    repositoryId,
    async () => {
      await requireCheckoutAccess(db, repositoryId, { mode: 'read' });
    },
    run,
  );
}

const terminalClosers = new Set<(repositoryId: string) => Promise<void>>();
export function registerCheckoutTerminalCloser(
  close: (repositoryId: string) => Promise<void>,
): () => void {
  terminalClosers.add(close);
  return () => {
    terminalClosers.delete(close);
  };
}

/** Enumerate containers, not socket registries: detached warm shells and surviving containers
 * after process death are just as writable. Task status deliberately does not filter this set;
 * the existing task/worktree guards decide whether replacement may proceed at all. */
export async function stopCheckoutContainers(
  db: Database,
  repositoryId: string,
  docker = new Docker({ timeout: 90_000 }),
  timeoutMs = CHECKOUT_DOCKER_TIMEOUT_MS,
): Promise<void> {
  try {
    await withSessionDeadline('docker_unknown', timeoutMs, async (check) => {
      const tasks = await db.query.tasks.findMany({
        where: eq(schema.tasks.repositoryId, repositoryId),
        columns: { id: true },
      });
      check();
      const taskIds = new Set(tasks.map((task) => task.id));
      const candidates: Docker.ContainerInfo[] = [];
      const listed = await docker.listContainers({ all: true });
      check();
      for (const container of listed) {
        const labels = container.Labels;
        const interactive =
          labels['haive.role'] === 'terminal-shell' ||
          labels['haive.ide'] === '1' ||
          labels['haive.ddev'] === '1' ||
          labels['haive.apprunner'] === '1';
        if (!interactive) continue;
        const labelledRepo = labels['haive.repository.id'] ?? labels['haive.repo.id'];
        const subpath = labels[RUNNER_SUBPATH_LABEL];
        let matches =
          labelledRepo === repositoryId ||
          taskIds.has(labels['haive.task.id'] ?? '') ||
          subpath?.split('/')[1] === repositoryId;
        if (!matches && !labelledRepo && !subpath) {
          // Legacy task shells can outlive their task row. Resolve their actual mount options,
          // rather than assuming a missing owner row means no mount of this repository remains.
          const details = await docker.getContainer(container.Id).inspect();
          check();
          const mounts = details.HostConfig.Mounts as
            Array<{ Source?: string; VolumeOptions?: { Subpath?: string } }> | undefined;
          matches =
            (mounts ?? []).some(
              (mount) => mount.VolumeOptions?.Subpath?.split('/')[1] === repositoryId,
            ) ||
            (details.Mounts ?? []).some((mount) => mount.Source?.split('/').includes(repositoryId));
        }
        if (matches) candidates.push(container);
      }
      // An explicit foreign owner is never removed. It also cannot authorize moving its mount.
      if (
        candidates.some(
          (container) =>
            container.Labels[INSTALL_LABEL] && container.Labels[INSTALL_LABEL] !== installId(),
        )
      )
        throw new CheckoutSessionsBusyError('foreign_container');
      for (const info of candidates) {
        const container = docker.getContainer(info.Id);
        await container.stop({ t: 10 }).catch((error: unknown) => {
          const code = (error as { statusCode?: number })?.statusCode;
          if (code !== 304 && code !== 404) throw error;
        });
        check();
        // -v removes anonymous nested /var/lib/docker, which a fresh runner cannot adopt.
        // Editor /udata, extensions, auth and cache volumes are named and survive -v.
        await container.remove({ force: false, v: true }).catch((error: unknown) => {
          if ((error as { statusCode?: number })?.statusCode !== 404) throw error;
        });
        check();
      }
      const ids = new Set(candidates.map((container) => container.Id));
      const remaining = await docker.listContainers({ all: true });
      check();
      if (remaining.some((container) => ids.has(container.Id)))
        throw new CheckoutSessionsBusyError('container_remains');
    });
  } catch (error) {
    if (error instanceof CheckoutSessionsBusyError) throw error;
    throw new CheckoutSessionsBusyError('docker_unknown', error);
  }
}

export async function suspendCheckoutSessions(
  db: Database,
  repositoryId: string,
  options: { transportTimeoutMs?: number; dockerTimeoutMs?: number } = {},
): Promise<() => void> {
  return interactiveCheckouts.suspend(repositoryId, async () => {
    try {
      await withSessionDeadline(
        'session_transport_unknown',
        options.transportTimeoutMs ?? CHECKOUT_TRANSPORT_TIMEOUT_MS,
        async (check) => {
          const closers = [...terminalClosers];
          await getRedis().set(`repo-interactive-epoch:${repositoryId}`, randomUUID());
          check();
          for (const close of closers) {
            await close(repositoryId);
            check();
          }
        },
      );
      await stopCheckoutContainers(db, repositoryId, undefined, options.dockerTimeoutMs);
    } catch (error) {
      if (error instanceof CheckoutSessionsBusyError) throw error;
      throw new CheckoutSessionsBusyError('session_transport_unknown', error);
    }
  });
}

/** Runtime boot entry points already carry the canonical volume subpath. Scratch has no
 * repository replacement lifecycle. Queue admission supplies the durable readiness check. */
export function withSubpathInteractiveCheckout<T>(
  subpath: string,
  run: () => Promise<T>,
): Promise<T> {
  const repoId = subpath.split('/')[1];
  if (!repoId || repoId === '_scratch') return run();
  return interactiveCheckouts.open(
    repoId,
    async () => {},
    async (check) => {
      const value = await run();
      await check();
      return value;
    },
  );
}
