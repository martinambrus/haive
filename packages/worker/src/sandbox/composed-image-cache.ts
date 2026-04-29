import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, type CliProviderName } from '@haive/shared';
import {
  composeSandboxImage,
  SANDBOX_CORE_IMAGE,
  type SandboxImageComposition,
} from './image-composer.js';
import { defaultDockerRunner, type DockerRunner } from './docker-runner.js';

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
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { envTemplateId: true },
  });
  if (!task?.envTemplateId) return null;

  const envTemplate = await db.query.envTemplates.findFirst({
    where: eq(schema.envTemplates.id, task.envTemplateId),
  });
  if (!envTemplate?.generatedDockerfile || envTemplate.status !== 'ready') return null;

  const baseImageId = await resolveBaseImageId(runner);
  const composition = composeSandboxImage({
    envTemplateDockerfile: envTemplate.generatedDockerfile,
    provider,
    baseImageId,
  });

  const inspected = await runner.inspect(composition.tag);
  if (inspected.exists) {
    log.info({ tag: composition.tag, hash: composition.hash }, 'composed image cache hit');
    return composition.tag;
  }

  log.info({ tag: composition.tag, hash: composition.hash }, 'composed image cache miss, building');
  await buildComposedImage(composition, runner);
  return composition.tag;
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
