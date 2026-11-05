#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { configService, networkName } from '@haive/shared';
import { parseReleaseManifest, type ReleaseManifest } from '@haive/shared/release';
import * as dk from './docker.js';
import { ensureJournal, findLiveRun, recordRunError, startRun, tryLock } from './journal.js';
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
import { decideResume } from './phases.js';
import {
  channelImagePlan,
  imageFor,
  journalImages,
  prepareImages,
  readImageOverrides,
  readImageSettings,
} from './images.js';

/**
 * `haive upgrade`.
 *
 * Runs as a ONE-SHOT container that is not part of the compose project it swaps — a process cannot
 * `compose up -d` itself out of existence and survive to verify the result. Two entry points reach
 * this same code: the admin UI (the worker spawns it detached) and a host-side invocation, which is
 * the one that still works when the stack is down.
 */

const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  refused: 3,
  busy: 4,
  rolledBack: 5,
  rollbackFailed: 6,
} as const;

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

/** Match scripts/build-channel.mjs; an unset install channel means public. */
export function resolveChannel(requested: string | undefined, installed: string): string {
  const channel = installed || 'public';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(channel))
    throw new Error('invalid install channel');
  if (requested !== undefined && requested !== channel)
    throw new Error('--channel disagrees with install HAIVE_CHANNEL');
  return channel;
}

export async function loadManifest(options: {
  manifest?: string;
  manifestImage?: string;
  channel: string;
  version?: string;
}): Promise<ReleaseManifest> {
  const { manifest: source, manifestImage: image, channel, version } = options;
  if (source && image) throw new Error('--manifest and --manifest-image are mutually exclusive');
  if (channel !== 'public' && !image) throw new Error('channel installs require --manifest-image');
  if (image && !version) throw new Error('--manifest-image requires --version <target>');
  if (!source && !image)
    throw new Error('--manifest <url|path> or --manifest-image <ref> is required');
  const text = image
    ? await dk.readReleaseManifestImage(image)
    : /^https?:\/\//.test(source!)
      ? await (await fetch(source!)).text()
      : await readFile(source!, 'utf8');
  const target = parseReleaseManifest(JSON.parse(text));
  if (target.channel !== channel) throw new Error('manifest channel differs from install channel');
  if (version !== undefined && target.version !== version)
    throw new Error('manifest version differs from requested target version');
  return target;
}

/** A rollback that throws has not undone the upgrade, so the run stays `running` for the next
 *  updater to find and finish. */
async function undo(ctx: UpgradeContext, reason: string): Promise<number> {
  try {
    await rollback(ctx, reason);
    return EXIT.rolledBack;
  } catch (err) {
    return rollbackFailed(ctx, err);
  }
}

async function rollbackFailed(ctx: UpgradeContext, err: unknown): Promise<number> {
  const message = err instanceof Error ? err.message : String(err);
  await recordRunError(ctx.sql, ctx.runId, `rollback failed: ${message}`).catch(() => {});
  emit('rollback-failed', {
    message,
    next: 'run `haive upgrade` again to finish the rollback',
  });
  return EXIT.rollbackFailed;
}

export async function main(): Promise<number> {
  if (flag('manifest') && flag('manifest-image')) {
    emit('error', { message: '--manifest and --manifest-image are mutually exclusive' });
    return EXIT.usage;
  }
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    emit('error', { message: 'DATABASE_URL and REDIS_URL are required' });
    return EXIT.usage;
  }

  const installDir = arg('install-dir', process.env.HAIVE_INSTALL_DIR ?? '/install')!;
  const registry = arg('registry', process.env.HAIVE_REGISTRY ?? 'ghcr.io/martinambrus')!;
  const apiUrl = arg('api-url', process.env.HAIVE_API_URL ?? 'http://api:3001')!;
  // The one-shot containers this updater runs (migrate, destructive data migrations) join this
  // network to reach postgres by name. A literal `haive-network` here made them join the DEFAULT
  // install's network on a namespaced install — MEASURED: the migrate container resolved `postgres`
  // to a different install's database and died on `password authentication failed`, which the
  // health gate then correctly rolled back. The install id reaches this process as an env var set
  // by whoever launched it.
  const network = arg('network', process.env.HAIVE_NETWORK ?? networkName('network'))!;
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

  const channelSettings = await dk.resolveImageSettings(envFile, ['HAIVE_CHANNEL']);
  const channel = resolveChannel(arg('channel'), channelSettings.HAIVE_CHANNEL ?? '');
  const manifestOptions = {
    manifest: arg('manifest'),
    manifestImage: arg('manifest-image'),
    channel,
    version: arg('version'),
  };
  // A channel must be proven before opening the journal or changing maintenance state.
  const channelTarget =
    channel !== 'public' || manifestOptions.manifestImage
      ? await loadManifest(manifestOptions)
      : undefined;

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
        registry:
          typeof live.metadata.imageRegistry === 'string' ? live.metadata.imageRegistry : registry,
        previousImages: journalImages(live.metadata.previousImages),
        targetImages: journalImages(live.metadata.targetImages),
        apiUrl,
        postgresVolume: pgVolume,
        network,
        drainDeadlineMs: 0,
        forceDrain: true,
        log: emit,
      };
      try {
        await resume(ctx, live.phase);
      } catch (err) {
        if (decideResume(live.phase).action !== 'reverse') throw err;
        return rollbackFailed(ctx, err);
      }
      return EXIT.ok;
    }

    const target = channelTarget ?? (await loadManifest(manifestOptions));

    const imageSettings = await readImageSettings(envFile);
    const previousImages = await readImageOverrides(envFile, imageSettings);
    const currentImages = (['api', 'worker', 'web'] as const).map((s) =>
      imageFor(s, fromVersion, registry, previousImages),
    );
    const check = preflight({
      currentVersion: fromVersion,
      target,
      localImages: await dk.localImages(channel !== 'public'),
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
    if (flag('check')) {
      if (channel !== 'public')
        emit('image-plan', channelImagePlan(target.version, imageSettings, target.images));
      return EXIT.ok;
    }

    // Pull BEFORE any hold is applied: a failed pull must cost nothing.
    const targetImages = await prepareImages(
      compose,
      envFile,
      target.version,
      registry,
      imageSettings,
      channel !== 'public' ? target.images : undefined,
    );
    emit('pulled', { version: target.version });

    const runId = await startRun(sql, {
      fromVersion,
      toVersion: target.version,
      channel: target.channel,
      metadata: {
        migrationHead: target.migrationHead,
        imageRegistry: registry,
        previousImages,
        targetImages,
      },
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
      previousImages,
      targetImages,
      apiUrl,
      postgresVolume: pgVolume,
      network,
      drainDeadlineMs: Number(arg('drain-timeout', '1800')) * 1000,
      forceDrain: flag('force'),
      log: emit,
    };

    let verifyFailed = false;
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

      verifyFailed = !(await phaseVerify(ctx));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit('error', { message });
      // Anything that throws before commit is reversible by construction; say so and undo it
      // rather than leaving the install held.
      return await undo(ctx, message);
    }
    if (verifyFailed) {
      return await undo(ctx, 'the new containers never reported the target version');
    }
    // Past the point of no return (`decideResume`): the run stays at `commit`, and the next run
    // resumes it forward rather than restoring old images onto data already changed.
    try {
      await phaseCommit(ctx);
      return EXIT.ok;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit('error', { message, phase: 'commit', next: 'run the updater again to finish it' });
      return EXIT.failed;
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await main());
  } catch (err) {
    emit('error', { message: err instanceof Error ? err.message : String(err) });
    process.exit(EXIT.failed);
  }
}
