#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postgres from 'postgres';
import { configService, networkName } from '@haive/shared';
import { parseReleaseManifest, type ReleaseManifest } from '@haive/shared/release';
import * as dk from './docker.js';
import {
  ensureJournal,
  findLiveRun,
  lastDoneChannel,
  recordRunError,
  startRun,
  tryLock,
} from './journal.js';
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
  requireChannelRegistry,
  type ImageSettings,
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
const CHANNEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function resolveChannel(requested: string | undefined, installed: string): string {
  const channel = installed || 'public';
  if (!CHANNEL_PATTERN.test(channel)) throw new Error('invalid install channel');
  if (requested !== undefined && requested !== channel)
    throw new Error('--channel disagrees with install HAIVE_CHANNEL');
  return channel;
}

/** Set before recovery and manifest pulls, and again after the post-lock re-read; every Docker subprocess inherits it. */
export function applyInstallDockerConfig(
  settings: Pick<ImageSettings, 'HAIVE_CHANNEL' | 'DOCKER_CONFIG'>,
  installDir: string,
  // Required, never defaulted: a default would re-read the env a previous call overwrote.
  launchDockerConfig: string | undefined,
): void {
  if (!settings.HAIVE_CHANNEL || settings.HAIVE_CHANNEL === 'public') return;
  if (!settings.DOCKER_CONFIG?.startsWith('/') || settings.DOCKER_CONFIG.includes(','))
    throw new Error('channel install requires an absolute DOCKER_CONFIG in .env');
  // The API mounts the host install at /install and explicitly supplies this translation. Judged by
  // the value this process was launched with, since a previous call overwrites the env.
  const mounted = installDir === '/install' && launchDockerConfig === '/install/.docker';
  const hostInstallDir = mounted ? process.env.HAIVE_INSTALL_DIR_HOST : installDir;
  if (!hostInstallDir?.startsWith('/') || hostInstallDir.includes(','))
    throw new Error('channel updater requires an absolute HAIVE_INSTALL_DIR_HOST');
  if (settings.DOCKER_CONFIG !== join(hostInstallDir, '.docker'))
    throw new Error('channel install DOCKER_CONFIG must be <host install dir>/.docker');
  process.env.DOCKER_CONFIG = mounted ? join(installDir, '.docker') : settings.DOCKER_CONFIG;
}

export async function loadManifest(options: {
  manifest?: string;
  manifestImage?: string;
  channelRegistry?: string;
  channel: string;
  version?: string;
}): Promise<ReleaseManifest> {
  const { manifest: source, manifestImage: image, channel, version } = options;
  if (source && image) throw new Error('--manifest and --manifest-image are mutually exclusive');
  if (channel !== 'public' && !image) throw new Error('channel installs require --manifest-image');
  if (image && !version) throw new Error('--manifest-image requires --version <target>');
  if (!source && !image)
    throw new Error('--manifest <url|path> or --manifest-image <ref> is required');
  if (channel !== 'public') {
    const registry = requireChannelRegistry(options.channelRegistry ?? '');
    if (!image!.startsWith(`${registry}/haive-${channel}-release:`))
      throw new Error('manifest image release repository differs from install channel registry');
  }
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
  if (arg('manifest-image') && !arg('version')) {
    emit('error', { message: '--manifest-image requires --version <target>' });
    return EXIT.usage;
  }
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if ((!databaseUrl || !redisUrl) && !flag('dry-plan')) {
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

  let imageSettings = await readImageSettings(envFile);
  const channel = resolveChannel(arg('channel'), imageSettings.HAIVE_CHANNEL);
  const manifestOptions = {
    manifest: arg('manifest'),
    manifestImage: arg('manifest-image'),
    channelRegistry: imageSettings.HAIVE_CHANNEL_REGISTRY,
    channel,
    version: arg('version'),
  };
  // Recovery needs no target, so a missing one is refused only where a target is read.
  const missingTarget = (): string | undefined =>
    channel !== 'public' && !manifestOptions.manifestImage
      ? 'channel installs require --manifest-image'
      : !manifestOptions.manifest && !manifestOptions.manifestImage
        ? '--manifest <url|path> or --manifest-image <ref> is required'
        : undefined;
  const launchDockerConfig = process.env.DOCKER_CONFIG;
  applyInstallDockerConfig(imageSettings, installDir, launchDockerConfig);

  // The dry plan reads no journal. Normal starts recover an interrupted run before fetching a target.
  if (flag('dry-plan')) {
    if (channel === 'public') throw new Error('--dry-plan requires a channel install');
    const usage = missingTarget();
    if (usage) {
      emit('error', { message: usage });
      return EXIT.usage;
    }
    const channelTarget = await loadManifest(manifestOptions);
    emit('image-plan', {
      channel,
      version: channelTarget.version,
      ...channelImagePlan(channelTarget.version, imageSettings, channelTarget.images),
    });
    return EXIT.ok;
  }

  const sql = postgres(databaseUrl!, { max: 1, max_lifetime: 0 });
  try {
    await configService.initialize(redisUrl!);
    await ensureJournal(sql);

    // One upgrade at a time. The lock guards concurrency; the journal's partial unique index is
    // what survives a crashed updater, and is why an interrupted run is FOUND rather than raced.
    if (!(await tryLock(sql))) {
      emit('error', { message: 'another upgrade holds the lock' });
      return EXIT.busy;
    }

    // A preceding upgrader may have changed the pins while this run waited for the lock.
    imageSettings = await readImageSettings(envFile);
    resolveChannel(channel, imageSettings.HAIVE_CHANNEL);
    manifestOptions.channelRegistry = imageSettings.HAIVE_CHANNEL_REGISTRY;
    applyInstallDockerConfig(imageSettings, installDir, launchDockerConfig);

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

    const recordedChannel = await lastDoneChannel(sql);
    const changeChannel = arg('change-channel');
    if (flag('change-channel')) {
      if (!changeChannel || !CHANNEL_PATTERN.test(changeChannel)) {
        emit('error', { message: '--change-channel requires a valid recorded channel name' });
        return EXIT.usage;
      }
      if (recordedChannel === null || recordedChannel === channel) {
        emit('error', {
          message:
            '--change-channel requires a recorded channel different from the current channel',
        });
        return EXIT.usage;
      }
    }
    if (
      recordedChannel !== null &&
      recordedChannel !== channel &&
      changeChannel !== recordedChannel
    ) {
      emit('refused', {
        refusal: 'channel-changed',
        message:
          `upgrade journal records channel ${recordedChannel}, but the resolved channel is ${channel}; ` +
          `use --change-channel ${recordedChannel} to acknowledge the move`,
      });
      return EXIT.refused;
    }

    const usage = missingTarget();
    if (usage) {
      emit('error', { message: usage });
      return EXIT.usage;
    }
    const target = await loadManifest(manifestOptions);

    if (channel !== 'public') channelImagePlan(target.version, imageSettings, target.images);

    const previousImages = await readImageOverrides(envFile, imageSettings);
    if (channel !== 'public' && Object.values(previousImages).some((ref) => !ref)) {
      emit('refused', {
        refusal: 'rollback-images-missing',
        message: 'channel install has no pinned current images',
      });
      return EXIT.refused;
    }
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

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => undefined)) ===
    (await realpath(fileURLToPath(import.meta.url)))
) {
  try {
    process.exit(await main());
  } catch (err) {
    emit('error', { message: err instanceof Error ? err.message : String(err) });
    process.exit(EXIT.failed);
  }
}
