import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { LIVE_TASK_STATUSES, schema } from '@haive/database';
import {
  CONFIG_KEYS,
  CONTAINER_FAMILY,
  configService,
  containerName,
  decryptEmail,
  drainTaskStatuses,
  getHaiveVersion,
  installId,
  isDevVersion,
  lockNewWorkFenceExclusive,
  logger,
  maintenanceStateSchema,
  networkName,
  parseMaintenanceState,
} from '@haive/shared';
import { getDb } from '../db.js';
import {
  insertAuditEvent,
  logAuditEvent,
  recordAuditEvent,
  type AuditEvent,
} from '../lib/audit.js';
import { clearTaskPause, stopActiveCliInvocations } from '../lib/task-control.js';
import { appendTaskEvent, findAdminPausedTaskIds } from './tasks/_helpers.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { findLiveUpgradeRun, listUpgradeRuns } from '../lib/upgrade-run.js';

const log = logger.child({ module: 'maintenance' });

/**
 * Operator control for a maintenance window: set the state, see whose work is blocking it, and
 * act on that work.
 *
 * Self-applying auth, like every other router here. Admin-only throughout — this is the first
 * surface in Haive that can touch another user's tasks at all.
 */
export const maintenanceRoutes = new Hono<AppEnv>();
maintenanceRoutes.use('*', requireAuth);
maintenanceRoutes.use('*', requireAdmin);

/** Every unfinished status. `created` is in: a draft runs nothing but would find its module
 *  deactivated once started. */
export const LIVE_TASK_STATES = LIVE_TASK_STATUSES;

/** The most rows either list of GET /blocking answers. */
export const BLOCKING_LIST_CAP = 200;

const setStateSchema = z.object({ state: maintenanceStateSchema });

maintenanceRoutes.get('/', async (c) => {
  const state = parseMaintenanceState(await configService.getFresh(CONFIG_KEYS.MAINTENANCE_STATE));
  return c.json({ state });
});

maintenanceRoutes.put('/', async (c) => {
  const { state } = setStateSchema.parse(await c.req.json());
  const actorUserId = c.get('userId');
  const { event, previous } = await getDb().transaction(async (tx) => {
    await lockNewWorkFenceExclusive(tx);
    const live = await findLiveUpgradeRun(tx);
    if (live) {
      throw new HttpError(
        409,
        `An upgrade from ${live.fromVersion} to ${live.toVersion} is running (run ${live.id}, phase ${live.phase}), so the maintenance state cannot be changed by hand until it ends. If the updater has stopped, run ./haive upgrade --version ${live.toVersion} in the install directory to finish or undo it.`,
        'upgrade_running',
      );
    }
    const replaced = parseMaintenanceState(
      await configService.getFresh(CONFIG_KEYS.MAINTENANCE_STATE),
    );
    const ev: AuditEvent = {
      actorUserId,
      action: 'maintenance.set_state',
      targetType: 'system',
      targetId: null,
      metadata: { from: replaced, to: state },
    };
    // A failed row throws here, so the state stays as it was.
    await insertAuditEvent(tx, ev);
    await configService.set(CONFIG_KEYS.MAINTENANCE_STATE, state);
    return { event: ev, previous: replaced };
  });
  logAuditEvent(event);
  log.info({ from: previous, to: state }, 'maintenance state changed');
  return c.json({ state, previous });
});

const jobOwner = {
  ownerId: schema.users.id,
  ownerName: schema.users.name,
  ownerEmailEncrypted: schema.users.emailEncrypted,
};

/** The background jobs the updater counts beside the tasks; a provider with two in progress is one row. */
async function listBlockingJobs(db: ReturnType<typeof getDb>) {
  const [repositories, bundles, providers] = await Promise.all([
    db
      .select({
        id: schema.repositories.id,
        name: schema.repositories.name,
        status: schema.repositories.status,
        updatedAt: schema.repositories.updatedAt,
        ...jobOwner,
      })
      .from(schema.repositories)
      .leftJoin(schema.users, eq(schema.users.id, schema.repositories.userId))
      .where(eq(schema.repositories.status, 'cloning'))
      .orderBy(desc(schema.repositories.updatedAt))
      .limit(BLOCKING_LIST_CAP + 1),
    db
      .select({
        id: schema.customBundles.id,
        name: schema.customBundles.name,
        status: schema.customBundles.status,
        updatedAt: schema.customBundles.updatedAt,
        ...jobOwner,
      })
      .from(schema.customBundles)
      .leftJoin(schema.users, eq(schema.users.id, schema.customBundles.userId))
      .where(eq(schema.customBundles.status, 'syncing'))
      .orderBy(desc(schema.customBundles.updatedAt))
      .limit(BLOCKING_LIST_CAP + 1),
    db
      .select({
        id: schema.cliProviders.id,
        name: schema.cliProviders.label,
        building: schema.cliProviders.sandboxImageBuildStatus,
        provisioning: schema.cliProviders.modelProvisionStatus,
        updatedAt: schema.cliProviders.updatedAt,
        ...jobOwner,
      })
      .from(schema.cliProviders)
      .leftJoin(schema.users, eq(schema.users.id, schema.cliProviders.userId))
      .where(
        or(
          eq(schema.cliProviders.sandboxImageBuildStatus, 'building'),
          eq(schema.cliProviders.modelProvisionStatus, 'provisioning'),
        ),
      )
      .orderBy(desc(schema.cliProviders.updatedAt))
      .limit(BLOCKING_LIST_CAP + 1),
  ]);
  const listed = [
    ...repositories.map((r) => ({ kind: 'repository' as const, ...r })),
    ...bundles.map((r) => ({ kind: 'bundle' as const, ...r })),
    ...providers.map(({ building, provisioning, ...r }) => ({
      kind: 'cli_provider' as const,
      ...r,
      status: [
        building === 'building' ? 'building' : null,
        provisioning === 'provisioning' ? 'provisioning' : null,
      ]
        .filter(Boolean)
        .join(' + '),
    })),
  ].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return {
    jobs: listed.slice(0, BLOCKING_LIST_CAP),
    capped: listed.length > BLOCKING_LIST_CAP,
  };
}

/**
 * What is still holding the window open.
 *
 * Names the OWNER, not just the task. An admin who can see "3 tasks are running" can only guess;
 * one who can see whose they are can go and ask, which is the difference between a drain that
 * finishes and a drain that gets forced.
 */
maintenanceRoutes.get('/blocking', async (c) => {
  const db = getDb();
  const state = parseMaintenanceState(await configService.getFresh(CONFIG_KEYS.MAINTENANCE_STATE));
  const fetched = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      type: schema.tasks.type,
      status: schema.tasks.status,
      pausedAt: schema.tasks.pausedAt,
      currentStepId: schema.tasks.currentStepId,
      updatedAt: schema.tasks.updatedAt,
      ownerId: schema.users.id,
      ownerName: schema.users.name,
      // A display name is optional in this schema, and "unknown owner" is useless to an operator
      // who has to go and ask whose work this is. The email always exists — decrypted here the
      // same way `/admin/users` does it, since this list has the same admin-only audience.
      ownerEmailEncrypted: schema.users.emailEncrypted,
    })
    .from(schema.tasks)
    .leftJoin(schema.users, eq(schema.users.id, schema.tasks.userId))
    // A dead task runs nothing, and none of this page's actions reach it; its owner cancels it.
    .where(and(inArray(schema.tasks.status, drainTaskStatuses(state)), isNull(schema.tasks.deadAt)))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(BLOCKING_LIST_CAP + 1);
  const rows = fetched.slice(0, BLOCKING_LIST_CAP);
  const { jobs, capped: jobsCapped } = await listBlockingJobs(db);
  const fieldKey = await configService.getEncryptionKey();

  // A task with a live CLI is the one a drain actually has to wait for; a parked one is only
  // holding a slot. Surfaced separately so the operator can tell "still working" from "waiting".
  const live = await db
    .select({ taskId: schema.cliInvocations.taskId })
    .from(schema.cliInvocations)
    // A run the pause held back has no started_at: it is queued, not running.
    .where(
      and(
        isNotNull(schema.cliInvocations.startedAt),
        isNull(schema.cliInvocations.endedAt),
        isNull(schema.cliInvocations.supersededAt),
      ),
    );
  const withLiveCli = new Set(live.map((r) => r.taskId));

  const adminPaused = await findAdminPausedTaskIds(
    db,
    rows.filter((r) => r.pausedAt).map((r) => r.id),
  );

  return c.json({
    tasks: rows.map(({ ownerEmailEncrypted, ...r }) => ({
      ...r,
      pausedByAdmin: adminPaused.has(r.id),
      ownerEmail: ownerEmailEncrypted ? decryptEmail(ownerEmailEncrypted, fieldKey) : null,
      hasLiveCli: withLiveCli.has(r.id),
    })),
    jobs: jobs.map(({ ownerEmailEncrypted, ...r }) => ({
      ...r,
      ownerEmail: ownerEmailEncrypted ? decryptEmail(ownerEmailEncrypted, fieldKey) : null,
    })),
    total: rows.length + jobs.length,
    // The listing is capped; say so rather than letting an operator read a truncated list as the
    // whole picture and force a drain that still had work behind it.
    capped: fetched.length > BLOCKING_LIST_CAP || jobsCapped,
    // GET /tasks/:id answers only a task's owner, so the page links just the viewer's own tasks.
    viewerId: c.get('userId'),
  });
});

const taskActionSchema = z.object({ action: z.enum(['pause', 'resume', 'stop']) });

/**
 * Act on ANY user's task, for a drain.
 *
 * A separate route rather than relaxing the ownership predicate on `POST /tasks/:id/action`.
 * Widening that handler would broaden every read and write sharing it, so a future slip in the
 * role check becomes cross-tenant access; a distinct route behind `requireAdmin` is explicit and
 * greppable. Same reasoning `routes/system.ts` already writes down for the global pause: everyone
 * may READ the state, flipping it stays on the admin route.
 *
 * `cancel` is deliberately absent. A drain needs work HELD or its CLI stopped, never destroyed,
 * and a destructive cross-user action added for a case that does not need one is permanent blast
 * radius. `stop` here is kill-the-CLI-keep-the-environment — the task stays restartable.
 */
maintenanceRoutes.post('/tasks/:id/action', async (c) => {
  const actorUserId = c.get('userId');
  const taskId = c.req.param('id');
  const { action } = taskActionSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { id: true, userId: true, status: true, pausedAt: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');

  // Two logs, because they have two audiences. The audit row is the security trail an admin can
  // query; the task event is what the OWNER sees on their own task page, so they learn who
  // stopped their work and why rather than finding it mysteriously halted.
  const auditEvent = (metadata: Record<string, unknown>): AuditEvent => ({
    actorUserId,
    action: `task.admin_${action}`,
    targetType: 'task',
    targetId: taskId,
    metadata: { ownerUserId: task.userId, ...metadata },
  });

  switch (action) {
    case 'pause': {
      if (task.status === 'completed' || task.status === 'cancelled') {
        throw new HttpError(409, `Cannot pause a ${task.status} task`);
      }
      // Decided under the task row lock, so a concurrent owner Pause or Resume is judged as it is.
      // A standing stamp stays (it anchors the reaper's paused-grace); the event alone takes over.
      const now = new Date();
      const result = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ pausedAt: schema.tasks.pausedAt })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .for('update');
        if (!locked) return { stamp: null, ev: null };
        let stamp = locked.pausedAt;
        let ev: AuditEvent;
        if (!stamp) {
          stamp = now;
          await tx
            .update(schema.tasks)
            .set({ pausedAt: now, updatedAt: now })
            .where(and(eq(schema.tasks.id, taskId), isNull(schema.tasks.pausedAt)));
          ev = auditEvent({ pausedAt: now.toISOString() });
        } else if ((await findAdminPausedTaskIds(tx, [taskId])).has(taskId)) {
          return { stamp, ev: null };
        } else {
          ev = auditEvent({ pausedAt: stamp.toISOString(), tookOver: true });
        }
        await appendTaskEvent(tx, taskId, null, 'task.paused', {
          by: actorUserId,
          byAdmin: true,
          reason: 'maintenance',
        });
        await insertAuditEvent(tx, ev);
        return { stamp, ev };
      });
      if (result.ev) logAuditEvent(result.ev);
      return c.json({ ok: true, pausedAt: result.stamp?.toISOString() ?? null });
    }
    case 'resume': {
      if (!task.pausedAt) return c.json({ ok: true, pausedAt: null });
      const ev = auditEvent({});
      const resumed = await db.transaction(async (tx) => {
        // Only the resume that changes the row is recorded.
        if (!(await clearTaskPause(tx, taskId))) return false;
        await appendTaskEvent(tx, taskId, null, 'task.resumed', { by: actorUserId, byAdmin: true });
        await insertAuditEvent(tx, ev);
        return true;
      });
      if (resumed) logAuditEvent(ev);
      return c.json({ ok: true, pausedAt: null });
    }
    case 'stop': {
      const result = await stopActiveCliInvocations(db, taskId, {
        failTask: true,
        actor: 'admin',
      });
      // The owner and the audit trail hear of a stop only when a run ended or a step failed.
      if (result.cancelled > 0 || result.stopped > 0) {
        await appendTaskEvent(db, taskId, null, 'task.stopped', {
          by: actorUserId,
          byAdmin: true,
          reason: 'maintenance',
          ...result,
        });
        await recordAuditEvent(db, auditEvent(result));
        log.info({ taskId, ...result }, 'admin stopped a task for maintenance');
      }
      return c.json({ ok: true, ...result });
    }
  }
});

/**
 * Where this install lives, as the DOCKER DAEMON sees it.
 *
 * The api never reads that directory. It hands the path to `docker run -v`, which the daemon
 * resolves on the HOST — the same daemon's-view-vs-container's-view distinction that made the
 * first real upgrade write its snapshot to a `/snapshots` nobody owned while the operator's
 * install directory stayed empty. So this cannot be `process.cwd()` and cannot be inferred; the
 * run overlay has to be told, and an install that was not told refuses rather than guesses.
 *
 * Unset on a source checkout, which is the correct answer there: a dev stack builds its images
 * and has no published release to swap to.
 */
const installDirHost = (): string | null => process.env.HAIVE_INSTALL_DIR_HOST || null;

const registry = (): string => process.env.HAIVE_REGISTRY || 'ghcr.io/martinambrus';

/** Strip a leading `v`, so `v0.2.0` and `0.2.0` name the same release — the same normalisation
 *  `build-release-manifest.mjs` applies, and the reason both forms are accepted here. */
const stripV = (v: string): string => v.replace(/^v/, '');

/** The release manifest lives as an asset on the GitHub release, whose TAG carries the `v` the
 *  manifest's own `version` field does not. Both placeholders are substituted so an install
 *  publishing manifests elsewhere can point at either shape. */
function manifestUrl(version: string): string {
  const template =
    process.env.HAIVE_RELEASE_MANIFEST_URL ||
    'https://github.com/martinambrus/haive/releases/download/{tag}/release.json';
  return template.replaceAll('{tag}', `v${version}`).replaceAll('{version}', version);
}

/** Upgrade history, and whether this install can start one at all. */
maintenanceRoutes.get('/upgrade', async (c) => {
  const runs = await listUpgradeRuns(getDb());

  const version = getHaiveVersion();
  return c.json({
    version,
    // Two separate reasons an upgrade cannot start, reported separately because they have
    // different fixes: a dev checkout has nothing to upgrade TO, while a published install that
    // was not told where it lives needs one line in its `.env`.
    canUpgrade: !isDevVersion(version) && installDirHost() !== null,
    devBuild: isDevVersion(version),
    installDirConfigured: installDirHost() !== null,
    runs,
  });
});

const startUpgradeSchema = z.object({
  version: z.string().min(1).max(64),
  /** Stop live work at the drain deadline instead of failing the upgrade. */
  force: z.boolean().optional(),
  drainTimeoutSeconds: z.number().int().min(0).max(86_400).optional(),
});

/**
 * Start an upgrade.
 *
 * The updater runs as a container OUTSIDE this compose project, because api, worker and web are
 * the things being replaced — a process cannot `compose up -d` itself out of existence and
 * survive to verify the result or roll it back. That is also why this is not a queued job: the
 * worker dies in the same swap, so a job holding the upgrade would be killed halfway through it.
 * Shelling out to `docker` from the api is the established seam (`lib/sandbox-kill.ts` already
 * does it against the same mounted socket).
 *
 * What is awaited here is the `docker run -d` CLIENT, not the upgrade: that command starts the
 * container and exits, so a bad image, an unreachable registry or a missing socket is reported to
 * the operator as a 502 instead of vanishing into a detached process. Progress after that point
 * is read from `upgrade_runs`, which is where it has to live anyway — this api is about to be
 * replaced by the one being installed.
 */
maintenanceRoutes.post('/upgrade', async (c) => {
  const body = startUpgradeSchema.parse(await c.req.json());
  const version = stripV(body.version.trim());
  // The version reaches a command line. Constrain it rather than trust it.
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw new HttpError(400, 'invalid version');

  const current = getHaiveVersion();
  if (isDevVersion(current)) {
    throw new HttpError(
      409,
      'this is a development build. It builds its images from the source tree, so there is no ' +
        'published release to swap to — upgrade by pulling the branch and rebuilding.',
    );
  }
  const installDir = installDirHost();
  if (!installDir) {
    throw new HttpError(
      409,
      'this install cannot upgrade itself: HAIVE_INSTALL_DIR_HOST is not set, so the updater ' +
        'cannot be told where the install lives on the host. Add it to the .env beside ' +
        'docker-compose.yml (the absolute host path of that directory) and recreate the api, ' +
        'or run `haive upgrade` on the host instead.',
    );
  }

  const db = getDb();
  // The updater's own advisory lock and its partial unique index are the real guards; this only
  // spares the operator a container that would refuse and exit.
  if (await findLiveUpgradeRun(db)) throw new HttpError(409, 'an upgrade is already running');

  const project = process.env.COMPOSE_PROJECT_NAME || 'haive';
  // The TARGET release's updater, not this one's: the new release is what knows how to reach
  // itself, and `docker run` pulls it, so a version with no published updater fails here — loudly,
  // before anything has been held — rather than halfway through a maintenance window.
  const image = `${registry()}/haive-updater:${version}`;
  const args = [
    'run',
    '-d',
    // No `--rm`. The api is replaced during this run, so the container's own log is the only
    // narrative an operator has when an upgrade goes wrong; a self-deleting container takes it
    // with it. One stopped container per upgrade is a price worth paying for `docker logs`.
    '--name',
    containerName(CONTAINER_FAMILY.upgrade, version, Date.now()),
    '--network',
    process.env.HAIVE_NETWORK || networkName('network'),
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${installDir}:/install`,
    // NAME only, no `=value`. `docker -e VAR` passes the variable through from the CLIENT's
    // environment, which is this process's, so the database password and the master KEK never
    // appear in an argv that `ps` and every failure message can read.
    '-e',
    'DATABASE_URL',
    '-e',
    'REDIS_URL',
    '-e',
    'CONFIG_ENCRYPTION_KEY',
    '-e',
    `COMPOSE_PROJECT_NAME=${project}`,
    // Without this the updater falls back to the DEFAULT install id and its one-shot containers
    // join `haive-network` — another install's, on any namespaced install.
    '-e',
    `HAIVE_INSTALL_ID=${installId()}`,
    image,
    '--manifest',
    manifestUrl(version),
    '--install-dir',
    '/install',
    '--registry',
    registry(),
    '--postgres-volume',
    process.env.HAIVE_POSTGRES_VOLUME || `${project}_postgres_data`,
    // Where the daemon should write the snapshot, in ITS namespace — see installDirHost above.
    '--snapshot-host-dir',
    process.env.HAIVE_SNAPSHOT_HOST_DIR || `${installDir}/snapshots`,
  ];
  if (body.drainTimeoutSeconds !== undefined) {
    args.push('--drain-timeout', String(body.drainTimeoutSeconds));
  }
  if (body.force) args.push('--force');

  const started = await runDockerClient(args);
  if (!started.ok) {
    // Never echo `args`: the message would be the one place the redaction above was pointless.
    log.error({ image, stderr: started.stderr }, 'could not start the updater');
    throw new HttpError(502, `could not start the updater: ${started.stderr || 'docker failed'}`);
  }

  await recordAuditEvent(db, {
    actorUserId: c.get('userId'),
    action: 'maintenance.start_upgrade',
    targetType: 'system',
    metadata: { from: current, to: version, container: started.containerId, force: !!body.force },
  });
  log.info({ from: current, to: version, container: started.containerId }, 'upgrade started');
  // 202: the work outlives this request, and this process is one of the things it replaces.
  return c.json({ started: true, from: current, to: version, container: started.containerId }, 202);
});

/** Run the docker CLI to completion and report what it said.
 *
 *  Mirrors `lib/sandbox-kill.ts`'s shape — spawn, buffer, kill on a deadline — but does NOT
 *  swallow the failure, because unlike a best-effort sandbox sweep this one has a person waiting
 *  for an answer. */
export function runDockerClient(
  args: string[],
): Promise<{ ok: boolean; containerId: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('docker', args);
    // Generous: `docker run -d` returns as soon as the container starts, but it PULLS the updater
    // image first if this host has never seen it.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, containerId: '', stderr: 'docker run timed out' });
    }, 300_000).unref();
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, containerId: stdout.trim().slice(0, 64), stderr: stderr.trim() });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, containerId: '', stderr: String(err) });
    });
  });
}
