#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { configService } from '@haive/shared';
import { parseReleaseManifest, type ReleaseManifest } from '@haive/shared/release';
import * as dk from './docker.js';
import { ensureJournal, findLiveRun, finishRun, startRun, tryLock } from './journal.js';
import { preflight } from './preflight.js';
import {
  phaseCommit,
  phaseDraining,
  phaseMaintenance,
  phaseMigrate,
  phaseSnapshot,
  phaseVerify,
  readEnvVar,
  recordSnapshot,
  resume,
  rollback,
  type UpgradeContext,
} from './run.js';

/**
 * `haive upgrade`.
 *
 * Runs as a ONE-SHOT container that is not part of the compose project it swaps — a process cannot
 * `compose up -d` itself out of existence and survive to verify the result. Two entry points reach
 * this same code: the admin UI (the worker spawns it detached) and a host-side invocation, which is
 * the one that still works when the stack is down.
 */

const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3, busy: 4, rolledBack: 5 } as const;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function emit(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

async function loadManifest(source: string): Promise<ReleaseManifest> {
  const text = /^https?:\/\//.test(source)
    ? await (await fetch(source)).text()
    : await readFile(source, 'utf8');
  return parseReleaseManifest(JSON.parse(text));
}

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    emit('error', { message: 'DATABASE_URL and REDIS_URL are required' });
    return EXIT.usage;
  }

  const installDir = arg('install-dir', process.env.HAIVE_INSTALL_DIR ?? '/install')!;
  const registry = arg('registry', process.env.HAIVE_REGISTRY ?? 'ghcr.io/martinambrus')!;
  const apiUrl = arg('api-url', process.env.HAIVE_API_URL ?? 'http://api:3001')!;
  const network = arg('network', process.env.HAIVE_NETWORK ?? 'haive-network')!;
  // As the DAEMON sees it. Defaults to the container-side path only because a host-run updater has
  // one view; a containerised one must be told, or the snapshot lands somewhere nobody looks.
  const snapshotDir = arg(
    'snapshot-host-dir',
    process.env.HAIVE_SNAPSHOT_HOST_DIR ?? arg('snapshot-dir', '/snapshots'),
  )!;
  const pgVolume = arg('postgres-volume', process.env.HAIVE_POSTGRES_VOLUME ?? '')!;
  const envFile = `${installDir}/.env`;

  const compose: dk.ComposeContext = {
    dir: installDir,
    files: ['docker-compose.yml', 'docker-compose.run.yml'],
  };

  const sql = postgres(databaseUrl, { max: 1, max_lifetime: 0 });
  try {
    await configService.initialize(redisUrl);
    await ensureJournal(sql);

    // One upgrade at a time. The lock guards concurrency; the journal's partial unique index is
    // what survives a crashed updater, and is why an interrupted run is FOUND rather than raced.
    if (!(await tryLock(sql))) {
      emit('error', { message: 'another upgrade holds the lock' });
      return EXIT.busy;
    }

    const fromVersion = (await readEnvVar(envFile, 'HAIVE_VERSION')) ?? 'unknown';
    const live = await findLiveRun(sql);

    // An interrupted run is finished or undone before anything new is considered. Starting a
    // second upgrade over a half-finished one is the one thing that must never happen.
    if (live) {
      const ctx: UpgradeContext = {
        sql,
        runId: live.id,
        compose,
        envFile,
        snapshotHostDir: snapshotDir,
        fromVersion: live.fromVersion,
        target: parseReleaseManifest({
          manifestVersion: 1,
          version: live.toVersion,
          builtAt: live.startedAt.toISOString(),
          minFrom: '0.0.0',
          migrationHead: String(live.metadata.migrationHead ?? ''),
        }),
        registry,
        apiUrl,
        postgresVolume: pgVolume,
        network,
        drainDeadlineMs: 0,
        forceDrain: true,
        log: emit,
      };
      await resume(ctx, live.phase);
      return EXIT.ok;
    }

    const manifestSource = arg('manifest');
    if (!manifestSource) {
      emit('error', { message: '--manifest <url|path> is required' });
      return EXIT.usage;
    }
    const target = await loadManifest(manifestSource);

    const currentImages = ['api', 'worker', 'web'].map(
      (s) => `${registry}/haive-${s}:${fromVersion}`,
    );
    const check = preflight({
      currentVersion: fromVersion,
      target,
      localImages: await dk.localImages(),
      currentImages,
      freeBytes: Number(arg('free-bytes', String(Number.MAX_SAFE_INTEGER))),
      snapshotBytes: Number(arg('snapshot-bytes', '0')),
    });
    if (!check.ok) {
      emit('refused', { refusal: check.refusal, message: check.message });
      return EXIT.refused;
    }
    emit('preflight-ok', { from: fromVersion, to: target.version });

    // `--check` stops here, having changed nothing. This is also where a support conversation
    // should begin.
    if (flag('check')) return EXIT.ok;

    // Pull BEFORE any hold is applied: a failed pull must cost nothing.
    await dk.pullImages(compose, { ...process.env, HAIVE_VERSION: target.version });
    emit('pulled', { version: target.version });

    const runId = await startRun(sql, {
      fromVersion,
      toVersion: target.version,
      channel: target.channel,
      metadata: { migrationHead: target.migrationHead },
    });

    const ctx: UpgradeContext = {
      sql,
      runId,
      compose,
      envFile,
      snapshotHostDir: snapshotDir,
      fromVersion,
      target,
      registry,
      apiUrl,
      postgresVolume: pgVolume,
      network,
      drainDeadlineMs: Number(arg('drain-timeout', '1800')) * 1000,
      forceDrain: flag('force'),
      log: emit,
    };

    try {
      await phaseDraining(ctx);
      await phaseMaintenance(ctx);
      if (pgVolume) {
        const file = await phaseSnapshot(ctx);
        await recordSnapshot(ctx, file);
      } else {
        emit('snapshot-skipped', { reason: 'no --postgres-volume given' });
      }
      await phaseMigrate(ctx);

      if (!(await phaseVerify(ctx))) {
        await rollback(ctx, 'the new containers never reported the target version');
        return EXIT.rolledBack;
      }
      await phaseCommit(ctx);
      return EXIT.ok;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit('error', { message });
      // Anything that throws before commit is reversible by construction; say so and undo it
      // rather than leaving the install held.
      await rollback(ctx, message).catch((e) =>
        emit('error', { message: `rollback failed: ${e}` }),
      );
      await finishRun(sql, runId, 'rolled_back', message).catch(() => {});
      return EXIT.rolledBack;
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

try {
  process.exit(await main());
} catch (err) {
  emit('error', { message: err instanceof Error ? err.message : String(err) });
  process.exit(EXIT.failed);
}
