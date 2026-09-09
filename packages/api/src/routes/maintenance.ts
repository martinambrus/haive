import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  CONTAINER_FAMILY,
  configService,
  containerName,
  decryptEmail,
  getHaiveVersion,
  installId,
  isDevVersion,
  logger,
  maintenanceStateSchema,
  networkName,
  parseMaintenanceState,
} from '@haive/shared';
import { getDb } from '../db.js';
import { recordAuditEvent } from '../lib/audit.js';
import { clearTaskPause, stopActiveCliInvocations } from '../lib/task-control.js';
import { appendTaskEvent } from './tasks/_helpers.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

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

/** Task states that still hold a maintenance window open. `waiting_user` counts: a task parked on
 *  a form is live work whose owner will come back to it, and stopping it loses their place. */
const LIVE_TASK_STATES = [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_pr',
] as const;

const setStateSchema = z.object({ state: maintenanceStateSchema });

maintenanceRoutes.get('/', async (c) => {
  const state = parseMaintenanceState(await configService.get(CONFIG_KEYS.MAINTENANCE_STATE));
  return c.json({ state });
});

maintenanceRoutes.put('/', async (c) => {
  const { state } = setStateSchema.parse(await c.req.json());
  const previous = parseMaintenanceState(await configService.get(CONFIG_KEYS.MAINTENANCE_STATE));
  await configService.set(CONFIG_KEYS.MAINTENANCE_STATE, state);
  await recordAuditEvent(getDb(), {
    actorUserId: c.get('userId'),
    action: 'maintenance.set_state',
    targetType: 'system',
    metadata: { from: previous, to: state },
  });
  log.info({ from: previous, to: state }, 'maintenance state changed');
  return c.json({ state, previous });
});

/**
 * What is still holding the window open.
 *
 * Names the OWNER, not just the task. An admin who can see "3 tasks are running" can only guess;
 * one who can see whose they are can go and ask, which is the difference between a drain that
 * finishes and a drain that gets forced.
 */
maintenanceRoutes.get('/blocking', async (c) => {
  const db = getDb();
  const rows = await db
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
    .where(inArray(schema.tasks.status, [...LIVE_TASK_STATES]))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(200);
  const fieldKey = await configService.getEncryptionKey();

  // A task with a live CLI is the one a drain actually has to wait for; a parked one is only
  // holding a slot. Surfaced separately so the operator can tell "still working" from "waiting".
  const live = await db
    .select({ taskId: schema.cliInvocations.taskId })
    .from(schema.cliInvocations)
    .where(and(isNull(schema.cliInvocations.endedAt), isNull(schema.cliInvocations.supersededAt)));
  const withLiveCli = new Set(live.map((r) => r.taskId));

  return c.json({
    tasks: rows.map(({ ownerEmailEncrypted, ...r }) => ({
      ...r,
      ownerEmail: ownerEmailEncrypted ? decryptEmail(ownerEmailEncrypted, fieldKey) : null,
      hasLiveCli: withLiveCli.has(r.id),
    })),
    total: rows.length,
    // The listing is capped; say so rather than letting an operator read a truncated list as the
    // whole picture and force a drain that still had work behind it.
    capped: rows.length === 200,
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
  const audit = async (metadata: Record<string, unknown>) => {
    await recordAuditEvent(db, {
      actorUserId,
      action: `task.admin_${action}`,
      targetType: 'task',
      targetId: taskId,
      metadata: { ownerUserId: task.userId, ...metadata },
    });
  };

  switch (action) {
    case 'pause': {
      if (task.status === 'completed' || task.status === 'cancelled') {
        throw new HttpError(409, `Cannot pause a ${task.status} task`);
      }
      // Idempotent, and it keeps the ORIGINAL timestamp for the same reason the owner path does:
      // that stamp anchors the runtime reaper's paused-grace.
      if (task.pausedAt) return c.json({ ok: true, pausedAt: task.pausedAt.toISOString() });
      const pausedAt = new Date();
      await db
        .update(schema.tasks)
        .set({ pausedAt, updatedAt: pausedAt })
        .where(eq(schema.tasks.id, taskId));
      await appendTaskEvent(db, taskId, null, 'task.paused', {
        by: actorUserId,
        byAdmin: true,
        reason: 'maintenance',
      });
      await audit({ pausedAt: pausedAt.toISOString() });
      return c.json({ ok: true, pausedAt: pausedAt.toISOString() });
    }
    case 'resume': {
      if (!task.pausedAt) return c.json({ ok: true, pausedAt: null });
      await clearTaskPause(db, taskId);
      await appendTaskEvent(db, taskId, null, 'task.resumed', { by: actorUserId, byAdmin: true });
      await audit({});
      return c.json({ ok: true, pausedAt: null });
    }
    case 'stop': {
      const result = await stopActiveCliInvocations(db, taskId, {
        failTask: true,
        actor: 'admin',
      });
      await appendTaskEvent(db, taskId, null, 'task.stopped', {
        by: actorUserId,
        byAdmin: true,
        reason: 'maintenance',
        ...result,
      });
      await audit(result);
      log.info({ taskId, ...result }, 'admin stopped a task for maintenance');
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

// A type alias, not an interface: `db.execute<T>` constrains T to `Record<string, unknown>`, and
// only a type literal picks up the implicit index signature that satisfies it.
type UpgradeRunRow = {
  id: string;
  from_version: string;
  to_version: string;
  phase: string;
  status: string;
  error: string | null;
  started_at: Date;
  ended_at: Date | null;
};

/** Upgrade history, and whether this install can start one at all. */
maintenanceRoutes.get('/upgrade', async (c) => {
  let runs: UpgradeRunRow[] = [];
  try {
    const rows = await getDb().execute<UpgradeRunRow>(
      sql`SELECT id, from_version, to_version, phase, status, error, started_at, ended_at
            FROM upgrade_runs ORDER BY started_at DESC LIMIT 20`,
    );
    runs = rows as unknown as UpgradeRunRow[];
  } catch (err) {
    // The journal is created by the updater itself, so an install that has never upgraded has no
    // such table. That is a legitimate state — "no runs" — not an error worth failing on.
    log.debug({ err }, 'upgrade journal not readable');
  }

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
  try {
    const live = (await db.execute<{ id: string }>(
      sql`SELECT id FROM upgrade_runs WHERE status = 'running' LIMIT 1`,
    )) as unknown as { id: string }[];
    // The updater's own advisory lock and its partial unique index are the real guards; this only
    // spares the operator a container that would refuse and exit.
    if (live.length > 0) throw new HttpError(409, 'an upgrade is already running');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    log.debug({ err }, 'no upgrade journal yet; nothing can be running');
  }

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
function runDockerClient(
  args: string[],
): Promise<{ ok: boolean; containerId: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('docker', args);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) =>
      resolve({ ok: code === 0, containerId: stdout.trim().slice(0, 64), stderr: stderr.trim() }),
    );
    child.on('error', (err) => resolve({ ok: false, containerId: '', stderr: String(err) }));
    // Generous: `docker run -d` returns as soon as the container starts, but it PULLS the updater
    // image first if this host has never seen it.
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, containerId: '', stderr: 'docker run timed out' });
    }, 300_000).unref();
  });
}
