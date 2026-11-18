import {
  parseImageReferences,
  composedRequestedInputsHash,
  ComposedImageNotVerifiedError,
  type ComposedImageInputs,
  type ComposedImageReference,
} from '../lsp/composed-image-refs.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, DEFAULT_RTK_VERSION, type CliProviderName } from '@haive/shared';
import {
  composeSandboxImage,
  SANDBOX_CORE_IMAGE,
  type EnvironmentImageRef,
  type SandboxImageComposition,
} from './image-composer.js';
import { defaultDockerRunner, type DockerRunner } from './docker-runner.js';
import { writeGitMcpContext } from './git-mcp-pin.js';
import { ensureSandboxCoreImage } from './sandbox-core-image.js';
import { withImageTagLock } from './image-tag-lock.js';
import { resolveComposedLspInstallContract } from './lsp-install-contract.js';

const log = logger.child({ module: 'composed-image-cache' });

const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

export interface ComposedImageProvider {
  name: CliProviderName;
  cliVersion: string | null;
  sandboxDockerfileExtra: string | null;
}

export async function ensureComposedImage(
  db: Database,
  taskId: string,
  provider: ComposedImageProvider,
  runner: DockerRunner = defaultDockerRunner,
): Promise<string | null> {
  return withEnsuredComposedImage(
    db,
    taskId,
    provider,
    async (composition) => composition.tag,
    runner,
  );
}

/** Keep verification and durable publication in the build's tag turn so the reaper
 * cannot remove an image between its build and the task taking ownership. */
export async function withEnsuredComposedImage<T>(
  db: Database,
  taskId: string,
  provider: ComposedImageProvider,
  use: (composition: ResolvedSandboxImageComposition) => Promise<T>,
  runner: DockerRunner = defaultDockerRunner,
): Promise<T | null> {
  const composition = await resolveSandboxImageComposition(db, taskId, provider, runner, true);
  if (!composition) return null;
  return withResolvedComposedImage(composition, use, runner);
}

export async function withResolvedComposedImage<T>(
  composition: ResolvedSandboxImageComposition,
  use: (composition: ResolvedSandboxImageComposition) => Promise<T>,
  runner: DockerRunner = defaultDockerRunner,
): Promise<T> {
  return withImageTagLock(composition.tag, async () => {
    const inspected = await runner.inspect(composition.tag);
    if (inspected.exists) {
      log.info({ tag: composition.tag, hash: composition.hash }, 'composed image cache hit');
    } else {
      // Contract 2 builds only FROM the environment image; its pasted body needs a context.
      if (composition.installContract === 2) {
        const environment = composition.environmentImage;
        if (!environment)
          throw new Error(
            'Contract-2 composed image cannot be built without its environment image',
          );
        // Re-inspected inside the tag turn: the id resolved earlier may have moved since.
        const current = await runner.inspect(environment.ref);
        if (!current.exists || current.imageId !== environment.imageId)
          throw new ComposedImageNotVerifiedError(ENV_IMAGE_CHANGED);
      }
      log.info(
        { tag: composition.tag, hash: composition.hash },
        'composed image cache miss, building',
      );
      await buildComposedImage(composition, runner);
      // The tag lock does not cover the environment tag, and docker resolves FROM by name
      // during the build: an environment that moved meanwhile may be the parent, so the
      // composed tag (named after the old id) is removed rather than served.
      const environment = composition.installContract === 2 ? composition.environmentImage : null;
      if (environment) {
        const after = await runner.inspect(environment.ref);
        if (!after.exists || after.imageId !== environment.imageId) {
          await runner.remove(composition.tag, { force: true });
          throw new ComposedImageNotVerifiedError(ENV_IMAGE_CHANGED);
        }
      }
    }
    return use(composition);
  });
}

export interface ResolvedSandboxImageComposition extends SandboxImageComposition {
  installContract: 1 | 2;
  inputs: ComposedImageInputs;
  effective?: ComposedImageReference;
  environmentImage?: EnvironmentImageRef;
}

const ENV_IMAGE_CHANGED = 'Environment image is missing or changed; Retry 03, then verify again';

/** The retained environment image a contract-2 composition builds FROM; null when it is
 * absent, has no id, or is not the image the environment build recorded. */
export async function resolveEnvironmentImage(
  envTemplate: { imageTag?: string | null; builtImageId?: string | null },
  runner: DockerRunner,
): Promise<EnvironmentImageRef | null> {
  if (!envTemplate.imageTag) return null;
  const environment = await runner.inspect(envTemplate.imageTag);
  if (
    !environment.exists ||
    !environment.imageId ||
    (envTemplate.builtImageId && envTemplate.builtImageId !== environment.imageId)
  )
    return null;
  return { ref: envTemplate.imageTag, imageId: environment.imageId };
}

/** Shared composition calculation. A peek uses inspect only; only the ensure path may
 * heal/build the base. A missing composed image must not fall through to another image. */
export async function resolveSandboxImageComposition(
  db: Database,
  taskId: string,
  provider: ComposedImageProvider,
  runner: DockerRunner = defaultDockerRunner,
  buildBase = false,
  peekBaseImageId?: () => Promise<string | null>,
  options: {
    inputs?: ComposedImageInputs;
    verifiedProviderId?: string;
    environmentImage?: EnvironmentImageRef;
  } = {},
): Promise<ResolvedSandboxImageComposition | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { envTemplateId: true, repositoryId: true, metadata: true },
  });
  if (!task?.envTemplateId) return null;

  const envTemplate = await db.query.envTemplates.findFirst({
    where: eq(schema.envTemplates.id, task.envTemplateId),
  });
  if (!envTemplate) return null;
  const deps = (envTemplate.declaredDeps ?? {}) as {
    lspInstallContractVersion?: unknown;
    lspServers?: readonly string[] | null;
    lspServerVersions?: Record<string, string | null> | null;
  };
  // A linked row with refused metadata cannot quietly fall back to a provider
  // image, even while its saved environment body is unavailable.
  const contract = resolveComposedLspInstallContract(deps.lspInstallContractVersion, provider.name);
  const launchEntries =
    contract === 2 && options.verifiedProviderId ? parseImageReferences(task.metadata).entries : [];
  // Until some provider holds an effective composed image there is nothing to pin or refuse.
  // The environment steps that build the first one (and their AI repair) launch on the provider
  // image, as a legacy task does before its environment is built; LSP readiness stays false.
  // Once any effective reference exists every refusal below applies.
  if (contract === 2 && options.verifiedProviderId && !launchEntries.some((e) => e.effective))
    return null;
  const effective = launchEntries.find(
    (e) => e.providerId === options.verifiedProviderId,
  )?.effective;
  // Build status controls verification, not an unchanged pinned launch. A user
  // can rebuild the environment without invalidating the image already verified.
  if (!envTemplate.generatedDockerfile || (envTemplate.status !== 'ready' && !effective)) {
    if (contract === 2 && options.verifiedProviderId)
      throw new ComposedImageNotVerifiedError(
        'Requested composed template is not ready; verification after the plugin result is required',
      );
    return null;
  }
  if (contract === 2 && options.verifiedProviderId && !effective)
    throw new ComposedImageNotVerifiedError(
      'Requested composed image has no verified reference; verification after the plugin result is required',
    );
  const pinned = options.inputs ?? effective?.inputs;
  const requestedHash =
    contract === 2
      ? composedRequestedInputsHash(envTemplate.generatedDockerfile, provider, deps)
      : ''; // Legacy selection/pins are deliberately ignored, including malformed values.
  if (pinned && pinned.requestedHash !== requestedHash)
    throw new ComposedImageNotVerifiedError(
      'Requested composed image inputs changed (template body, selection/pins or provider image settings); verification after the plugin result is required; retained prior image was kept',
    );

  // Per-repo RTK version. An explicit pin is honored; an unpinned repo (null)
  // tracks the latest known rtk from the version cache rather than the baked
  // default, so fresh/unpinned repos get the current release. A changed value
  // changes the runtime-tools layer string, hence the composition hash, forcing
  // a fresh composed build. Cache-empty (or no repo) falls back to the
  // composer's DEFAULT_RTK_VERSION.
  let rtkVersion: string | null = null;
  if (task.repositoryId) {
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { rtkVersion: true },
    });
    rtkVersion = repo?.rtkVersion ?? null;
  }
  const rtkPin = rtkVersion || null;
  if (pinned && pinned.rtkPin !== rtkPin)
    throw new ComposedImageNotVerifiedError(
      'Requested repository RTK pin changed; verification after the plugin result is required',
    );
  if (pinned) rtkVersion = pinned.rtkVersion;
  else if (!rtkVersion) {
    const rtkCache = await db.query.toolPackageVersions.findFirst({
      where: eq(schema.toolPackageVersions.name, 'rtk'),
      columns: { versions: true, latestVersion: true },
    });
    rtkVersion = rtkCache?.versions?.[0] ?? rtkCache?.latestVersion ?? null;
  }

  // A pinned launch/peek skips the environment image: it keeps the retained image id and
  // must not depend on the environment still being there.
  let environmentImage: EnvironmentImageRef | undefined;
  if (contract === 2 && !options.verifiedProviderId) {
    environmentImage =
      options.environmentImage ?? (await resolveEnvironmentImage(envTemplate, runner)) ?? undefined;
    if (!environmentImage) throw new ComposedImageNotVerifiedError(ENV_IMAGE_CHANGED);
  }

  const baseImageId = pinned
    ? pinned.baseImageId
    : buildBase
      ? await resolveBaseImageId(runner)
      : peekBaseImageId
        ? await peekBaseImageId()
        : (await runner.inspect(SANDBOX_CORE_IMAGE)).imageId;
  const composition = composeSandboxImage({
    envTemplateDockerfile: envTemplate.generatedDockerfile,
    provider,
    baseImageId,
    rtkVersion,
    lspInstallContractVersion: contract,
    lspServers: deps.lspServers,
    lspServerVersions: deps.lspServerVersions,
    environmentImage,
  });
  return {
    ...composition,
    tag: effective?.tag ?? composition.tag,
    installContract: contract,
    inputs: { rtkVersion: rtkVersion || DEFAULT_RTK_VERSION, baseImageId, rtkPin, requestedHash },
    effective,
    environmentImage,
  };
}

/**
 * Resolves the current image ID of `haive-cli-sandbox:latest` so the composer
 * can mix it into the composition hash. Without this, rebuilding the base
 * image keeps the same `:latest` tag and the composer happily reuses stale
 * per-CLI tags (the dockerfile body string is identical even though the
 * resolved base content has changed). Returns null when the base hasn't been
 * built yet — the composer treats null as "skip the base-id contribution",
 * which is the legacy behavior.
 */
async function resolveBaseImageId(runner: DockerRunner): Promise<string | null> {
  // Best-effort, because this function's contract is already "null when the base is not
  // built" and an env-template composition need not reference the base at all. Rebuilding
  // it here is what stops the silent half of a prune: with no base image the hash below
  // loses its base contribution, so a composed tag built on the OLD base is then served as
  // a cache hit against a rebuilt one — the exact drift this id exists to catch.
  await ensureSandboxCoreImage(SANDBOX_CORE_IMAGE, runner).catch((err: unknown) => {
    log.warn({ err, baseImage: SANDBOX_CORE_IMAGE }, 'sandbox-core base image rebuild failed');
  });
  const inspected = await runner.inspect(SANDBOX_CORE_IMAGE);
  if (!inspected.exists) {
    log.warn(
      { baseImage: SANDBOX_CORE_IMAGE },
      'sandbox-core base image not present at compose time — composed cache key will not reflect base rebuilds until the base is built',
    );
    return null;
  }
  return inspected.imageId;
}

async function buildComposedImage(
  composition: SandboxImageComposition,
  runner: DockerRunner,
): Promise<void> {
  const buildDir = join(tmpdir(), `haive-compose-${randomUUID()}`);
  const dockerfilePath = join(buildDir, 'Dockerfile');
  try {
    await mkdir(buildDir, { recursive: true });
    await writeFile(dockerfilePath, composition.dockerfileBody, 'utf8');
    writeGitMcpContext(buildDir);
    const result = await runner.build({
      contextDir: buildDir,
      dockerfilePath,
      tag: composition.tag,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      const tail = (result.error ?? result.stderr ?? `exit ${result.exitCode}`).slice(-4000);
      throw new Error(`composed image build failed: ${tail}`);
    }
    log.info(
      { tag: composition.tag, durationMs: result.durationMs },
      'composed image build succeeded',
    );
  } finally {
    rm(buildDir, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn({ err, buildDir }, 'failed to cleanup compose build dir');
    });
  }
}
