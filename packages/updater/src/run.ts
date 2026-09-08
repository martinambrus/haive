import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { CONFIG_KEYS, configService } from '@haive/shared';
import type { ReleaseManifest } from '@haive/shared/release';
import * as dk from './docker.js';
import { enterPhase, finishRun, mergeMetadata, type RunMetadata } from './journal.js';
import { decideResume, type UpgradePhase } from './phases.js';

export interface UpgradeContext {
  sql: Sql;
  runId: string;
  compose: dk.ComposeContext;
  /** Absolute path of the install's `.env`, the file that PINS the running version. */
  envFile: string;
  /** Where snapshots are written. Must be a host path the daemon can mount. */
  snapshotDir: string;
  fromVersion: string;
  target: ReleaseManifest;
  registry: string;
  /** Base URL of the api, for the health gate. */
  apiUrl: string;
  /** Postgres data volume to snapshot. */
  postgresVolume: string;
  /** Docker network the one-shot containers join to reach postgres. */
  network: string;
  /** How long to wait for in-flight work before forcing. */
  drainDeadlineMs: number;
  /** Force past the drain deadline instead of failing. */
  forceDrain: boolean;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

/** Rewrite a single `KEY=value` line in the install's .env.
 *
 *  This file IS the pin — the run overlay reads `HAIVE_VERSION` from it and refuses to default —
 *  so rewriting one line is both how an upgrade takes effect and how a rollback undoes it. Written
 *  by replacing the line rather than appending, or a rollback would leave two and compose would
 *  take the last. */
export async function setEnvVar(envFile: string, key: string, value: string): Promise<void> {
  const text = await readFile(envFile, 'utf8');
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const next = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
  await writeFile(envFile, next, 'utf8');
}

export async function readEnvVar(envFile: string, key: string): Promise<string | null> {
  const text = await readFile(envFile, 'utf8');
  return new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null;
}

/** Compose reads the pin from the environment as well as from .env, so the version being acted on
 *  is passed explicitly rather than relying on the file having been rewritten already. */
function composeEnv(version: string): NodeJS.ProcessEnv {
  return { ...process.env, HAIVE_VERSION: version };
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

/** Live work that still holds a maintenance window open. */
async function liveTaskCount(sql: Sql): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM tasks
     WHERE status IN ('created','queued','running','paused','waiting_user','waiting_pr')`;
  return Number(rows[0]?.n ?? 0);
}

export async function phaseDraining(ctx: UpgradeContext): Promise<void> {
  await enterPhase(ctx.sql, ctx.runId, 'draining');
  await configService.set(CONFIG_KEYS.MAINTENANCE_STATE, 'draining');
  ctx.log('draining', { deadlineMs: ctx.drainDeadlineMs });

  const deadline = Date.now() + ctx.drainDeadlineMs;
  for (;;) {
    const live = await liveTaskCount(ctx.sql);
    if (live === 0) {
      ctx.log('drained', { live: 0 });
      return;
    }
    if (Date.now() >= deadline) {
      // A deadline with no declared fallback is how maintenance windows get skipped: the operator
      // waits forever on somebody else's task. Forcing is a CHOICE the caller made, not a default.
      if (ctx.forceDrain) {
        ctx.log('drain-forced', { live });
        return;
      }
      throw new Error(
        `${live} task(s) are still live after ${Math.round(ctx.drainDeadlineMs / 1000)}s. ` +
          `Re-run with --force to stop them, or wait and try again.`,
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function phaseMaintenance(ctx: UpgradeContext): Promise<void> {
  await enterPhase(ctx.sql, ctx.runId, 'maintenance');
  await configService.set(CONFIG_KEYS.MAINTENANCE_STATE, 'maintenance');
  ctx.log('maintenance');
}

export async function phaseSnapshot(ctx: UpgradeContext): Promise<string> {
  // Recorded BEFORE Postgres stops, because the journal lives in Postgres. That ordering is also
  // why `decideResume('snapshot')` is `reverse`: if the updater dies here the journal's last word
  // is `snapshot`, and nothing but holds has changed.
  await enterPhase(ctx.sql, ctx.runId, 'snapshot');
  const file = `pg-${ctx.fromVersion}-${Date.now()}.tgz`;
  ctx.log('snapshot-start', { volume: ctx.postgresVolume, file });

  await dk.composeStop(ctx.compose, composeEnv(ctx.fromVersion), ['postgres']);
  try {
    await dk.snapshotVolume(ctx.postgresVolume, ctx.snapshotDir, file);
  } finally {
    // Always bring it back, even on a failed snapshot: everything after this needs a database, and
    // leaving it stopped turns a recoverable failure into an outage.
    await dk.composeUp(ctx.compose, composeEnv(ctx.fromVersion), ['postgres']);
  }
  ctx.log('snapshot-done', { file });
  return file;
}

export async function phaseMigrate(ctx: UpgradeContext): Promise<void> {
  await enterPhase(ctx.sql, ctx.runId, 'migrate');
  const image = `${ctx.registry}/haive-api:${ctx.target.version}`;
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

export async function phaseVerify(ctx: UpgradeContext): Promise<boolean> {
  await enterPhase(ctx.sql, ctx.runId, 'verify');
  await setEnvVar(ctx.envFile, 'HAIVE_VERSION', ctx.target.version);
  await dk.composeUp(ctx.compose, composeEnv(ctx.target.version));
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
  await setEnvVar(ctx.envFile, 'HAIVE_VERSION', ctx.fromVersion);
  await dk.composeUp(ctx.compose, composeEnv(ctx.fromVersion));
  await configService.set(CONFIG_KEYS.MAINTENANCE_STATE, 'normal');
  await finishRun(ctx.sql, ctx.runId, 'rolled_back', reason);
  ctx.log('rolled-back', { version: ctx.fromVersion });
}

export async function phaseCommit(ctx: UpgradeContext): Promise<void> {
  await enterPhase(ctx.sql, ctx.runId, 'commit');
  // ONLY here, and this is the whole reason the data migrations were split. These delete rows with
  // no tombstone, some in a database the snapshot never covered, so running them before the health
  // gate would mean a rollback restores old images onto data the new version already destroyed.
  const image = `${ctx.registry}/haive-worker:${ctx.target.version}`;
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

  await configService.set(CONFIG_KEYS.MAINTENANCE_STATE, 'normal');
  await finishRun(ctx.sql, ctx.runId, 'done');
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
  const patch: RunMetadata = { snapshot: join(ctx.snapshotDir, file) };
  await mergeMetadata(ctx.sql, ctx.runId, patch);
}
