import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { type CliProviderName } from '@haive/shared';
import type { CliProbePathResult } from '@haive/shared';
import { defaultDockerRunner, type DockerRunner } from '../../sandbox/docker-runner.js';
import { resolveImageTag } from '../../sandbox/image-cache.js';
import { ensureComposedImage } from '../../sandbox/composed-image-cache.js';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import type { BaseCliAdapter } from '../../cli-adapters/base-adapter.js';
import type { CliProviderRecord } from '../../cli-adapters/types.js';
import { resolveCliAuthMounts } from '../../sandbox/cli-auth-volume.js';
import {
  buildAuthProbeCommand,
  classifyAuthProbeOutput,
  isAuthProbeSupported,
} from '../../cli-adapters/auth-probe.js';
import { log } from './_shared.js';
import { createSandboxSpawner } from './exec-core.js';
import { handleBuildSandboxImageJob } from './handlers.js';

async function ensureProviderSandboxImage(
  db: Database,
  provider: {
    id: string;
    userId: string;
    name: string;
    cliVersion: string | null;
    sandboxDockerfileExtra: string | null;
  },
): Promise<string | null> {
  const resolution = resolveImageTag({
    name: provider.name as CliProviderName,
    cliVersion: provider.cliVersion?.trim() || null,
    providerId: provider.id,
    sandboxDockerfileExtra: provider.sandboxDockerfileExtra,
  });
  if (!resolution) return null;

  const existing = await defaultDockerRunner.inspect(resolution.tag);
  if (existing.exists) return resolution.tag;

  const fresh = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, provider.id),
    columns: { sandboxImageBuildStatus: true },
  });
  if (fresh?.sandboxImageBuildStatus === 'building') {
    throw new Error('sandbox image build is in progress, please wait for it to finish and retry');
  }

  log.info(
    { providerId: provider.id, tag: resolution.tag },
    'sandbox image cache miss, building inline',
  );
  const result = await handleBuildSandboxImageJob(db, {
    providerId: provider.id,
    userId: provider.userId,
  });
  if (!result.ok) {
    throw new Error(`sandbox image build failed: ${result.error ?? 'unknown'}`);
  }
  return result.imageTag ?? null;
}

export async function resolveSandboxImageTag(
  db: Database,
  taskId: string | null,
  provider: {
    id: string;
    userId: string;
    name: string;
    cliVersion: string | null;
    sandboxDockerfileExtra: string | null;
  },
): Promise<string | null> {
  if (taskId) {
    const composedTag = await ensureComposedImage(db, taskId, {
      name: provider.name as CliProviderName,
      cliVersion: provider.cliVersion?.trim() || null,
      sandboxDockerfileExtra: provider.sandboxDockerfileExtra,
    });
    if (composedTag) return composedTag;
  }
  return ensureProviderSandboxImage(db, provider);
}

export async function probeCliPath(
  db: Database,
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  secrets: Record<string, string> = {},
): Promise<CliProbePathResult> {
  const startedAt = Date.now();
  const resolvedCommand = resolveProviderExecutable(adapter, provider);
  let sandboxImage: string | null;
  try {
    sandboxImage = await ensureProviderSandboxImage(db, provider);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
  let authMounts: Awaited<ReturnType<typeof resolveCliAuthMounts>> = [];
  if (isAuthProbeSupported(provider.name)) {
    authMounts = resolveCliAuthMounts(
      {
        userId: provider.userId,
        providerId: provider.id,
        providerName: provider.name,
        isolateAuth: provider.isolateAuth,
      },
      { writable: true },
    );
  }
  const spawner = createSandboxSpawner(
    provider.wrapperContent,
    sandboxImage,
    null,
    SANDBOX_WORKDIR,
    null,
    [],
    authMounts,
  );
  try {
    const versionResult = await spawner(
      {
        command: resolvedCommand,
        args: ['--version'],
        env: provider.envVars ?? {},
      },
      { timeoutMs: 15_000 },
    );
    if (versionResult.exitCode !== 0) {
      const error =
        versionResult.error ??
        (versionResult.stderr.trim() ||
          `exit ${versionResult.exitCode ?? 'unknown'} from sandbox probe`);
      return { ok: false, error, durationMs: Date.now() - startedAt };
    }
    const versionDetail =
      versionResult.stdout.trim() || versionResult.stderr.trim() || 'binary reachable';

    if (!isAuthProbeSupported(provider.name)) {
      return { ok: true, detail: versionDetail, durationMs: Date.now() - startedAt };
    }

    const authSpec = buildAuthProbeCommand(provider, resolvedCommand);
    const authResult = await spawner(
      {
        command: authSpec.command,
        args: authSpec.args,
        env: { ...authSpec.env, ...secrets },
      },
      { timeoutMs: 25_000 },
    );
    const classification = classifyAuthProbeOutput({
      stdout: authResult.stdout,
      stderr: authResult.stderr,
      exitCode: authResult.exitCode ?? -1,
      timedOut: authResult.timedOut,
    });
    const durationMs = Date.now() - startedAt;
    if (classification.status === 'ok') {
      return {
        ok: true,
        detail: versionDetail,
        durationMs,
        authStatus: 'ok',
        authMessage: classification.message,
      };
    }
    return {
      ok: false,
      detail: versionDetail,
      error: classification.message,
      durationMs,
      authStatus: classification.status,
      authMessage: classification.message,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

function resolveProviderExecutable(adapter: BaseCliAdapter, provider: CliProviderRecord): string {
  const wrapper = provider.wrapperPath?.trim();
  if (wrapper) return wrapper;
  const explicit = provider.executablePath?.trim();
  if (explicit) return explicit;
  return adapter.defaultExecutable;
}

export async function markProvidersReady(
  db: Database,
  imageTag: string,
  providerId: string,
  shared: boolean,
): Promise<void> {
  const now = new Date();
  if (shared) {
    await db
      .update(schema.cliProviders)
      .set({
        sandboxImageTag: imageTag,
        sandboxImageBuildStatus: 'ready',
        sandboxImageBuildError: null,
        sandboxImageBuiltAt: now,
        updatedAt: now,
      })
      .where(eq(schema.cliProviders.sandboxImageTag, imageTag));
  }
  await db
    .update(schema.cliProviders)
    .set({
      sandboxImageTag: imageTag,
      sandboxImageBuildStatus: 'ready',
      sandboxImageBuildError: null,
      sandboxImageBuiltAt: now,
      updatedAt: now,
    })
    .where(eq(schema.cliProviders.id, providerId));
}

export async function removeOrphanedPreviousImage(
  db: Database,
  args: { providerId: string; previousDbTag: string | null; newTag: string },
  runner: DockerRunner = defaultDockerRunner,
): Promise<{
  removed: boolean;
  reason: 'no-previous' | 'same-tag' | 'still-in-use' | 'missing' | 'remove-failed' | 'removed';
}> {
  const { previousDbTag, newTag, providerId } = args;
  if (!previousDbTag) return { removed: false, reason: 'no-previous' };
  if (previousDbTag === newTag) return { removed: false, reason: 'same-tag' };
  const stillInUse = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.sandboxImageTag, previousDbTag),
    columns: { id: true },
  });
  if (stillInUse) {
    log.info(
      { providerId, previousDbTag, newTag, otherProviderId: stillInUse.id },
      'keeping previous sandbox image, still referenced by another provider',
    );
    return { removed: false, reason: 'still-in-use' };
  }
  const inspected = await runner.inspect(previousDbTag);
  if (!inspected.exists) return { removed: false, reason: 'missing' };
  const removeResult = await runner.remove(previousDbTag);
  if (removeResult.ok) {
    log.info({ providerId, previousDbTag, newTag }, 'removed orphaned previous sandbox image');
    return { removed: true, reason: 'removed' };
  }
  log.warn(
    {
      providerId,
      previousDbTag,
      newTag,
      stderr: removeResult.stderr,
      error: removeResult.error,
    },
    'failed to remove orphaned previous sandbox image',
  );
  return { removed: false, reason: 'remove-failed' };
}
