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

// ESC-built (not a literal control char) so it doesn't trip no-control-regex.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
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
      // Under auto-continue this step runs unattended on its defaults: first
      // build → build with the auto-generated tag; already built → reuse
      // (rebuild box unticked). See form() for the per-state field set.
      autoSubmitDefaults: true,
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
      ];
      // The rebuild checkbox only matters when an image already exists. On the
      // first build there is nothing to reuse — apply() builds regardless of the
      // flag (currentImageId is null) — so the box would be a no-op; omit it.
      if (alreadyBuilt) {
        fields.push({
          type: 'checkbox',
          id: 'forceRebuild',
          label: 'Rebuild even though an image already exists',
          default: false,
        });
      }
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
      // Live progress for the multi-minute build: `docker --progress=plain` emits
      // one line per stage (mostly on stderr). Surface the latest line plus an
      // elapsed counter to the step status line — polled by the UI every ~2s — so
      // the build never looks frozen. Mirrors ensureDdevWithProgress (_app-runtime).
      const buildStartedAt = Date.now();
      let lastBuildLine = 'preparing build context…';
      let lineBuf = '';
      const trackLine = (chunk: string): void => {
        lineBuf += chunk;
        let nl: number;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const clean = stripAnsi(lineBuf.slice(0, nl)).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (clean) lastBuildLine = clean.slice(0, 140);
        }
      };
      let heartbeat: ReturnType<typeof setInterval> | null = null;
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
        await ctx.emitProgress('Building image…');
        heartbeat = setInterval(() => {
          const secs = Math.round((Date.now() - buildStartedAt) / 1000);
          void ctx.emitProgress(`Building image… ${secs}s — ${lastBuildLine}`.slice(0, 200));
        }, 2500);
        const buildResult = await runner.build({
          contextDir,
          dockerfilePath,
          tag: imageTag,
          onStdoutChunk: (chunk) => {
            ctx.logger.debug({ chunk }, 'docker stdout');
            trackLine(chunk);
          },
          onStderrChunk: (chunk) => {
            ctx.logger.debug({ chunk }, 'docker stderr');
            trackLine(chunk);
          },
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
        if (heartbeat) clearInterval(heartbeat);
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}

export const buildImageStep = createBuildImageStep(defaultDockerRunner);
