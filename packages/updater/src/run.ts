import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ISql, Sql } from 'postgres';
import {
  CONFIG_KEYS,
  ConfigUnavailableError,
  configService,
  drainTaskStatuses,
  NEW_WORK_FENCE_KEY,
  parseMaintenanceState,
  type MaintenanceState,
} from '@haive/shared';
import type { ReleaseManifest } from '@haive/shared/release';
import * as dk from './docker.js';
import { inInstall } from './install-files.js';
import { IMAGE_KEYS, imageFor, type ImageOverrides } from './images.js';
import {
  enterPhase,
  finishRun,
  mergeMetadata,
  readFoundState,
  recordFoundState,
  type RunMetadata,
} from './journal.js';
import { decideResume, type UpgradePhase } from './phases.js';
import {
  backupBundle,
  swapBundle,
  restoreBundle,
  pruneBundles,
  type BundleState,
} from './bundle-swap.js';

export interface UpgradeContext {
  sql: Sql;
  runId: string;
  compose: dk.ComposeContext;
  /** Absolute path of the install's `.env`, the file that PINS the running version. */
  envFile: string;
  /** Where snapshots are written, as the DAEMON sees it.
   *
   *  Not as this container sees it. Paths in `docker run -v` are resolved by the daemon on the
   *  HOST, so passing the updater's own mount point silently writes the snapshot to a same-named
   *  host directory the daemon creates — MEASURED: a 9.9 MB dump landed at `/snapshots` on the
   *  host while the operator's install directory stayed empty, after a `snapshot-done` log line.
   *  Same daemon's-view-vs-container's-view problem the worker already names HOST_REPO_ROOT_REAL. */
  snapshotHostDir: string;
  fromVersion: string;
  target: ReleaseManifest;
  registry: string;
  previousImages?: ImageOverrides;
  targetImages?: ImageOverrides;
  /** Durable backup state, journalled before any installed bundle file is replaced. */
  bundle?: BundleState;
  /** Base URL of the api, for the health gate. */
  apiUrl: string;
  /** Postgres data volume to snapshot. */
  postgresVolume: string;
  /** Docker network the one-shot containers join to reach postgres. */
  network: string;
  /** How long to wait for in-flight work before forcing. */
  drainDeadlineMs: number;
  /** When that wait ends: fixed by the first drain wait and shared by every wait after it. */
  drainDeadlineAt?: number;
  /** Milliseconds between live-work counts and between recounts; 5000 when unset. */
  drainPollMs?: number;
  /** Milliseconds between retries of a maintenance-state write; 3000 when unset. */
  maintenanceWritePauseMs?: number;
  /** Force past the drain deadline instead of failing. */
  forceDrain: boolean;
  /** Set by phaseDraining when it forced past live work, so phaseMaintenance skips the recount. */
  drainForced?: boolean;
  /** The maintenance state at the last look (draining phase, then each recount); the waits use it. */
  lastState?: MaintenanceState;
  /** Set when the draining phase starts and cleared once this run has recorded the state it found:
   *  while set it has written no maintenance state, so a rollback leaves the stored one alone. A
   *  restarted updater never runs that phase, so it never sets it and puts back what the journal holds. */
  stateUntouched?: boolean;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

/** Rewrite a single `KEY=value` line in the install's .env.
 *
 *  This file IS the pin — the run overlay reads `HAIVE_VERSION` from it and refuses to default —
 *  so rewriting one line is both how an upgrade takes effect and how a rollback undoes it. Written
 *  by replacing the line rather than appending, or a rollback would leave two and compose would
 *  take the last. */
export async function setEnvVar(envFile: string, key: string, value: string): Promise<void> {
  await inInstall(dirname(envFile), async (dir) => {
    const name = basename(envFile);
    const current = await dir.read(name);
    if (!current) throw new Error('install env file is missing');
    const text = current.bytes.toString('utf8');
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    const next = pattern.test(text)
      ? text.replace(pattern, () => line)
      : `${text.trimEnd()}\n${line}\n`;
    await dir.atomic(name, Buffer.from(next), current.owner);
  });
}

export async function readEnvVar(envFile: string, key: string): Promise<string | null> {
  const text = await readFile(envFile, 'utf8');
  return new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null;
}

/** Compose reads the pin from the environment as well as from .env, so the version being acted on
 *  is passed explicitly rather than relying on the file having been rewritten already. */
function composeEnv(
  version: string,
  images?: ImageOverrides,
  registry?: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HAIVE_VERSION: version,
    ...(registry ? { HAIVE_REGISTRY: registry } : {}),
    ...images,
  };
}

async function writeImages(ctx: UpgradeContext, images?: ImageOverrides): Promise<void> {
  if (images) for (const key of IMAGE_KEYS) await setEnvVar(ctx.envFile, key, images[key]);
}

/** Poll `GET /version` until it reports the expected release, or give up.
 *
 *  `/health` cannot answer this: it returns a fixed `{status, service}` that a container running
 *  the PREVIOUS image reports just as cheerfully, which is precisely the half-upgraded state this
 *  gate exists to catch. */
async function awaitVersion(
  apiUrl: string,
  expected: string,
  expectedHead: string,
  timeoutMs: number,
  log: UpgradeContext['log'],
): Promise<{ ok: boolean; saw?: string; head?: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let saw: string | undefined;
  let head: string | null | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/version`);
      if (res.ok) {
        const body = (await res.json()) as { version?: string; migrationHead?: string | null };
        saw = body.version;
        head = body.migrationHead ?? null;
        if (saw === expected && head === expectedHead) return { ok: true, saw, head };
      }
    } catch {
      // Not up yet. A container mid-restart refusing a connection is the expected state here, not
      // an error worth reporting on every poll.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log('verify-timeout', { expected, expectedHead, saw, head });
  return { ok: false, saw, head };
}

/** Wait for Postgres to accept queries again.
 *
 *  The snapshot STOPS Postgres, which severs this process's own connection — and the journal lives
 *  in Postgres, so the very next write fails. MEASURED: `connect ECONNREFUSED` immediately after a
 *  successful snapshot, which rolled back a perfectly good upgrade. postgres.js reconnects on its
 *  own but not instantly, and the server needs a moment after the container starts. */
async function awaitDatabase(sql: Sql, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Live work that still holds a maintenance window open: tasks, and the background jobs a route queues. */
export async function liveWorkCount(
  sql: ISql<{}>,
  state: MaintenanceState = 'normal',
): Promise<number> {
  // A dead task and a draft that never started run nothing; /admin/maintenance leaves both out too.
  const rows = await sql<{ n: string }[]>`
    SELECT (
      (SELECT count(*) FROM tasks
        WHERE status = ANY(${drainTaskStatuses(state)}::task_status[])
          AND dead_at IS NULL)
      + (SELECT count(*) FROM repositories WHERE status = 'cloning')
      + (SELECT count(*) FROM custom_bundles WHERE status = 'syncing')
      + (SELECT count(*) FROM cli_providers
          WHERE sandbox_image_build_status = 'building' OR model_provision_status = 'provisioning')
    )::text AS n`;
  return Number(rows[0]?.n ?? 0);
}

/** A session lock belongs to one connection, so lock and unlock share a reserved one. */
async function underFence<T>(sql: Sql, work: (fence: ISql<{}>) => Promise<T>): Promise<T> {
  const fence = await sql.reserve();
  try {
    await fence`SELECT pg_advisory_lock(hashtextextended(${NEW_WORK_FENCE_KEY}, 0))`;
    try {
      return await work(fence);
    } finally {
      await fence`SELECT pg_advisory_unlock(hashtextextended(${NEW_WORK_FENCE_KEY}, 0))`;
    }
  } finally {
    fence.release();
  }
}

/** A recreated Redis needs 1-3 s; 20 x 3 s rides that out. */
const MAINTENANCE_WRITE_ATTEMPTS = 20;
const MAINTENANCE_WRITE_PAUSE_MS = 3000;

/** Retries only while the config store is unavailable. Each attempt takes and releases the fence, so no sleep holds it. */
async function setMaintenanceState(ctx: UpgradeContext, state: MaintenanceState): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await underFence(ctx.sql, () => configService.set(CONFIG_KEYS.MAINTENANCE_STATE, state));
      return;
    } catch (err) {
      if (!(err instanceof ConfigUnavailableError) || attempt >= MAINTENANCE_WRITE_ATTEMPTS) {
        throw err;
      }
      ctx.log('maintenance-write-retry', { state, attempt });
      await new Promise((resolve) =>
        setTimeout(resolve, ctx.maintenanceWritePauseMs ?? MAINTENANCE_WRITE_PAUSE_MS),
      );
    }
  }
}

/** Writes draining over normal only: a draining or maintenance an administrator set is already a hold. */
async function holdDraining(ctx: UpgradeContext): Promise<MaintenanceState> {
  return underFence(ctx.sql, async (fence) => {
    const found = parseMaintenanceState(
      await configService.getFresh(CONFIG_KEYS.MAINTENANCE_STATE),
    );
    await recordFoundState(fence, ctx.runId, found);
    ctx.stateUntouched = false;
    if (found === 'normal') await configService.set(CONFIG_KEYS.MAINTENANCE_STATE, 'draining');
    return found;
  });
}

/** Read from the journal, not the context: a restarted updater never ran the draining phase. */
async function restoreMaintenanceState(ctx: UpgradeContext): Promise<void> {
  if (ctx.stateUntouched) {
    ctx.log('maintenance-restore-skipped', {
      reason: 'this run recorded no found state and wrote none',
    });
    return;
  }
  const found = await readFoundState(ctx.sql, ctx.runId);
  if (found === null) {
    await mergeMetadata(ctx.sql, ctx.runId, { restoreSkipped: 'found_state_unknown' });
    ctx.log('maintenance-restore-skipped', {
      reason: 'prior maintenance state is unknown; keeping the current state',
    });
    return;
  }
  await setMaintenanceState(ctx, found);
}

/** Recounts under the fence: a draining or held install with nothing live enters maintenance. */
async function enterMaintenance(ctx: UpgradeContext): Promise<boolean> {
  const { entered, state, live } = await underFence(ctx.sql, async (fence) => {
    const state = parseMaintenanceState(
      await configService.getFresh(CONFIG_KEYS.MAINTENANCE_STATE),
    );
    ctx.lastState = state;
    // The updater's pool is one connection and the fence holds it, so the count runs on the fence.
    const live = await liveWorkCount(fence, state);
    const entered = state !== 'normal' && live === 0;
    if (state === 'normal') await configService.set(CONFIG_KEYS.MAINTENANCE_STATE, 'draining');
    if (entered && state === 'draining') {
      await configService.set(CONFIG_KEYS.MAINTENANCE_STATE, 'maintenance');
    }
    return { entered, state, live };
  });
  if (!entered) ctx.log('drain-reopened', { state, live });
  return entered;
}

function pause(ctx: UpgradeContext): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, ctx.drainPollMs ?? 5000));
}

function drainDeadline(ctx: UpgradeContext): number {
  return (ctx.drainDeadlineAt ??= Date.now() + ctx.drainDeadlineMs);
}

/** Ends a drain whose recount still finds admissions reopened once the one deadline has passed. */
function reopenedAtDeadline(ctx: UpgradeContext): boolean {
  if (!ctx.forceDrain) {
    throw new Error(
      `Admissions were reopened after ${Math.round(ctx.drainDeadlineMs / 1000)}s of draining. ` +
        `Re-run with --force to enter maintenance anyway, or wait and try again.`,
    );
  }
  ctx.log('drain-forced', { live: 0 });
  return true;
}

/** Waits until no work is live; true when the deadline passed and the caller chose to force. */
async function awaitDrain(ctx: UpgradeContext): Promise<boolean> {
  const deadline = drainDeadline(ctx);
  for (;;) {
    const live = await liveWorkCount(ctx.sql, ctx.lastState);
    if (live === 0) {
      ctx.log('drained', { live: 0 });
      return false;
    }
    if (Date.now() >= deadline) {
      // A deadline with no declared fallback is how maintenance windows get skipped: the operator
      // waits forever on somebody else's task. Forcing is a CHOICE the caller made, not a default.
      if (ctx.forceDrain) {
        ctx.log('drain-forced', { live });
        return true;
      }
      throw new Error(
        `${live} task(s) or background job(s) are still live after ${Math.round(ctx.drainDeadlineMs / 1000)}s. ` +
          `Re-run with --force to stop them, or wait and try again.`,
      );
    }
    await pause(ctx);
  }
}

export async function phaseDraining(ctx: UpgradeContext): Promise<void> {
  ctx.stateUntouched = true;
  await enterPhase(ctx.sql, ctx.runId, 'draining');
  const found = await holdDraining(ctx);
  ctx.lastState = found;
  ctx.log('draining', { deadlineMs: ctx.drainDeadlineMs, found });
  ctx.drainForced = await awaitDrain(ctx);
}

export async function phaseMaintenance(ctx: UpgradeContext): Promise<void> {
  await enterPhase(ctx.sql, ctx.runId, 'maintenance');
  let forced = ctx.drainForced === true;
  while (!forced && !(await enterMaintenance(ctx))) {
    await enterPhase(ctx.sql, ctx.runId, 'draining');
    forced = await awaitDrain(ctx);
    if (!forced && Date.now() >= drainDeadline(ctx)) forced = reopenedAtDeadline(ctx);
    // Without this pause, a state rewritten again and again with nothing live spins the recount.
    if (!forced) await pause(ctx);
    await enterPhase(ctx.sql, ctx.runId, 'maintenance');
  }
  if (forced) await setMaintenanceState(ctx, 'maintenance');
  ctx.log('maintenance');
}

export async function phaseSnapshot(ctx: UpgradeContext): Promise<string> {
  // Recorded BEFORE Postgres stops, because the journal lives in Postgres. That ordering is also
  // why `decideResume('snapshot')` is `reverse`: if the updater dies here the journal's last word
  // is `snapshot`, and nothing but holds has changed.
  await enterPhase(ctx.sql, ctx.runId, 'snapshot');
  const file = `pg-${ctx.fromVersion}-${Date.now()}.tgz`;
  ctx.log('snapshot-start', { volume: ctx.postgresVolume, file });

  await dk.composeStop(ctx.compose, composeEnv(ctx.fromVersion, ctx.previousImages, ctx.registry), [
    'postgres',
  ]);
  try {
    await dk.snapshotVolume(ctx.postgresVolume, ctx.snapshotHostDir, file);
  } finally {
    // Always bring it back, even on a failed snapshot: everything after this needs a database, and
    // leaving it stopped turns a recoverable failure into an outage.
    await dk.composeUp(ctx.compose, composeEnv(ctx.fromVersion, ctx.previousImages, ctx.registry), [
      'postgres',
    ]);
    // And WAIT for it. The journal is in this database; without this the next write races the
    // restart and loses.
    await awaitDatabase(ctx.sql);
  }
  ctx.log('snapshot-done', { file });
  return file;
}

export async function phaseMigrate(ctx: UpgradeContext): Promise<void> {
  await enterPhase(ctx.sql, ctx.runId, 'migrate');
  const image = imageFor('api', ctx.target.version, ctx.registry, ctx.targetImages);
  // Run from the TARGET image, never the current one: the migrations being applied are the new
  // release's, and the old image does not have them.
  const out = await dk.runOneShot(
    image,
    ['node', 'packages/database/dist/migrate/index.js'],
    { DATABASE_URL: process.env.DATABASE_URL ?? '' },
    ctx.network,
  );
  ctx.log('migrated', { tail: out.split('\n').slice(-1)[0] ?? '' });
}

/** Immediately after startRun, before draining or changing any installed bundle file. */
export async function recordBundleBackup(ctx: UpgradeContext): Promise<void> {
  if (!ctx.target.bundle) return;
  const bundle = await backupBundle(ctx.compose, ctx.runId, ctx.target);
  await mergeMetadata(ctx.sql, ctx.runId, { bundle });
  ctx.bundle = bundle;
}

export async function phaseVerify(ctx: UpgradeContext): Promise<boolean> {
  await enterPhase(ctx.sql, ctx.runId, 'verify');
  await writeImages(ctx, ctx.targetImages);
  if (ctx.target.bundle && !ctx.bundle) throw new Error('bundle backup was not journalled');
  if (ctx.bundle) await swapBundle(ctx.compose, ctx.bundle, ctx.target.version);
  await setEnvVar(ctx.envFile, 'HAIVE_VERSION', ctx.target.version);
  await dk.composeUp(ctx.compose, composeEnv(ctx.target.version, ctx.targetImages, ctx.registry));
  ctx.log('verify-start', { expect: ctx.target.version });

  const result = await awaitVersion(
    ctx.apiUrl,
    ctx.target.version,
    ctx.target.migrationHead,
    180_000,
    ctx.log,
  );
  if (result.ok) ctx.log('verified', { version: result.saw, head: result.head });
  return result.ok;
}

/** Put the previous release back. Additive migrations are LEFT IN PLACE — the old images run
 *  against them perfectly well, and undoing them is neither possible nor necessary. */
export async function rollback(ctx: UpgradeContext, reason: string): Promise<void> {
  ctx.log('rollback', { to: ctx.fromVersion, reason });
  if (ctx.bundle) await restoreBundle(ctx.compose, ctx.bundle);
  await writeImages(ctx, ctx.previousImages);
  await setEnvVar(ctx.envFile, 'HAIVE_VERSION', ctx.fromVersion);
  await dk.composeUp(ctx.compose, composeEnv(ctx.fromVersion, ctx.previousImages, ctx.registry));
  await restoreMaintenanceState(ctx);
  await finishRun(ctx.sql, ctx.runId, 'rolled_back', reason);
  ctx.log('rolled-back', { version: ctx.fromVersion });
}

export async function phaseCommit(ctx: UpgradeContext): Promise<void> {
  await enterPhase(ctx.sql, ctx.runId, 'commit');
  // ONLY here, and this is the whole reason the data migrations were split. These delete rows with
  // no tombstone, some in a database the snapshot never covered, so running them before the health
  // gate would mean a rollback restores old images onto data the new version already destroyed.
  const image = imageFor('worker', ctx.target.version, ctx.registry, ctx.targetImages);
  const out = await dk.runOneShot(
    image,
    ['node', 'packages/worker/dist/destructive-data-migrations-cli.js'],
    {
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      REDIS_URL: process.env.REDIS_URL ?? '',
      CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY ?? '',
    },
    ctx.network,
  );
  ctx.log('destructive-data-migrations', { tail: out.split('\n').slice(-1)[0] ?? '' });

  await restoreMaintenanceState(ctx);
  await finishRun(ctx.sql, ctx.runId, 'done');
  if (ctx.bundle) {
    try {
      await pruneBundles(ctx.compose, ctx.bundle, ctx.log);
    } catch {
      ctx.log('bundle-prune-failed', {
        reason: 'commit succeeded; keeping remaining backup and staging files',
      });
    }
  }
  ctx.log('done', { version: ctx.target.version });
}

/** Resume an interrupted run: finish it or undo it, never guess. */
export async function resume(ctx: UpgradeContext, phase: UpgradePhase): Promise<void> {
  const decision = decideResume(phase);
  ctx.log('resume', { phase, action: decision.action, reason: decision.reason });
  if (decision.action === 'forward') {
    await phaseCommit(ctx);
  } else {
    await rollback(ctx, `interrupted during ${phase}: ${decision.reason}`);
  }
}

export async function recordSnapshot(ctx: UpgradeContext, file: string): Promise<void> {
  // The HOST path, because that is where an operator will actually find it.
  const patch: RunMetadata = { snapshot: join(ctx.snapshotHostDir, file) };
  await mergeMetadata(ctx.sql, ctx.runId, patch);
}
