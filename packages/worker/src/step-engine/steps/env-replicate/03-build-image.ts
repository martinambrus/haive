import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepDefinition } from '../../step-definition.js';
import { defaultDockerRunner, type DockerRunner } from '../../../sandbox/docker-runner.js';
import { getTaskEnvTemplate } from './_shared.js';

export interface BuildImageDetect {
  envTemplateId: string;
  name: string;
  baseImage: string;
  dockerfile: string;
  currentImageId: string | null;
  status: string;
}

export interface BuildImageApply {
  envTemplateId: string;
  imageTag: string;
  imageId: string | null;
  skipped: boolean;
  durationMs: number;
}

const DEFAULT_TAG_PREFIX = 'haive-env';

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createBuildImageStep(
  runner: DockerRunner,
): StepDefinition<BuildImageDetect, BuildImageApply> {
  return {
    metadata: {
      id: '03-build-image',
      workflowType: 'env_replicate',
      index: 3,
      title: 'Build environment image',
      description: 'Builds the Docker image declared in the generated Dockerfile.',
      requiresCli: false,
    },

    async detect(ctx) {
      const row = await getTaskEnvTemplate(ctx.db, ctx.taskId);
      if (!row) {
        throw new Error(`env template for task ${ctx.taskId} not found`);
      }
      if (!row.generatedDockerfile) {
        throw new Error('dockerfile not generated yet; run step 02 first');
      }
      return {
        envTemplateId: row.id,
        name: row.name,
        baseImage: row.baseImage,
        dockerfile: row.generatedDockerfile,
        currentImageId: row.builtImageId,
        status: row.status,
      };
    },

    form(_ctx, detected): FormSchema {
      const defaultTag = `${DEFAULT_TAG_PREFIX}-${slugifyName(detected.name)}:latest`;
      const alreadyBuilt = detected.currentImageId !== null && detected.status === 'ready';
      const fields: FormSchema['fields'] = [
        {
          type: 'text',
          id: 'imageTag',
          label: 'Image tag',
          default: defaultTag,
          required: true,
        },
        {
          type: 'checkbox',
          id: 'forceRebuild',
          label: alreadyBuilt
            ? 'Rebuild even though an image already exists'
            : 'Build the image now',
          default: !alreadyBuilt,
        },
      ];
      return {
        title: 'Build image',
        description: alreadyBuilt
          ? `Image already built (${detected.currentImageId}). Leave the rebuild box unchecked to reuse it.`
          : 'Build the sandbox image from the generated Dockerfile.',
        fields,
        submitLabel: alreadyBuilt ? 'Continue' : 'Build image',
      };
    },

    async apply(ctx, args) {
      const detected = args.detected;
      const imageTag = String(args.formValues.imageTag ?? '').trim();
      const forceRebuild = Boolean(args.formValues.forceRebuild);
      if (!imageTag) throw new Error('imageTag is required');

      if (detected.currentImageId && !forceRebuild && detected.status === 'ready') {
        ctx.logger.info(
          {
            envTemplateId: detected.envTemplateId,
            imageId: detected.currentImageId,
          },
          'reusing existing image',
        );
        return {
          envTemplateId: detected.envTemplateId,
          imageTag,
          imageId: detected.currentImageId,
          skipped: true,
          durationMs: 0,
        };
      }

      await ctx.db
        .update(schema.envTemplates)
        .set({ status: 'building', updatedAt: new Date() })
        .where(eq(schema.envTemplates.id, detected.envTemplateId));

      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'haive-env-build-'));
      try {
        const dockerfilePath = path.join(tempDir, 'Dockerfile');
        await writeFile(dockerfilePath, detected.dockerfile, 'utf8');
        const contextDir = ctx.repoPath || tempDir;
        ctx.logger.info(
          {
            envTemplateId: detected.envTemplateId,
            imageTag,
            contextDir,
          },
          'docker build starting',
        );
        const buildResult = await runner.build({
          contextDir,
          dockerfilePath,
          tag: imageTag,
          onStdoutChunk: (chunk) => ctx.logger.debug({ chunk }, 'docker stdout'),
          onStderrChunk: (chunk) => ctx.logger.debug({ chunk }, 'docker stderr'),
          signal: ctx.signal,
        });
        if (buildResult.exitCode !== 0) {
          await ctx.db
            .update(schema.envTemplates)
            .set({ status: 'failed', updatedAt: new Date() })
            .where(eq(schema.envTemplates.id, detected.envTemplateId));
          const tail = buildResult.stderr.slice(-2000);
          throw new Error(
            `docker build failed with exit ${buildResult.exitCode}: ${tail || buildResult.error || 'no stderr'}`,
          );
        }
        await ctx.db
          .update(schema.envTemplates)
          .set({
            status: 'ready',
            imageTag,
            builtImageId: buildResult.imageId ?? imageTag,
            lastBuiltAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.envTemplates.id, detected.envTemplateId));
        ctx.logger.info(
          {
            envTemplateId: detected.envTemplateId,
            imageTag,
            imageId: buildResult.imageId,
            durationMs: buildResult.durationMs,
          },
          'docker build complete',
        );
        return {
          envTemplateId: detected.envTemplateId,
          imageTag,
          imageId: buildResult.imageId,
          skipped: false,
          durationMs: buildResult.durationMs,
        };
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}

export const buildImageStep = createBuildImageStep(defaultDockerRunner);
