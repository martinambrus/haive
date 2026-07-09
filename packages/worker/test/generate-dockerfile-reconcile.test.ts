import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { FormValues } from '@haive/shared';
import { generateDockerfileStep } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import type { GenerateDockerfileDetect } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

// A prior task's Dockerfile is replayed by the runner's reuse path. The hook keeps it
// only when the env template it was saved on declares the same deps as this task.

const DDEV_DEPS = { containerTool: 'ddev', runtimes: ['php'] };
const PLAIN_DEPS = { containerTool: 'none', runtimes: ['php'] };

const PRIOR_DOCKERFILE = 'FROM ubuntu:24.04\nRUN apt-get install -y php8.3\n';
const FRESH_DOCKERFILE = 'FROM ubuntu:24.04\nRUN echo ddev\n';

/** Stands in for the env template row `findEnvTemplateByHash` resolves the reused
 *  Dockerfile bytes to. `null` = no template carries that hash any more. */
function makeCtx(sourceRow: { id: string; declaredDeps: unknown } | null): {
  ctx: StepContext;
  infos: unknown[];
} {
  const infos: unknown[] = [];
  const db = {
    query: {
      envTemplates: { findFirst: vi.fn(async () => sourceRow ?? undefined) },
    },
  } as unknown as Database;
  const ctx = {
    userId: 'user-1',
    db,
    logger: { info: (o: unknown) => infos.push(o) },
  } as unknown as StepContext;
  return { ctx, infos };
}

function detect(declaredDeps: unknown): GenerateDockerfileDetect {
  return {
    envTemplateId: 'tpl-new',
    baseImage: 'ubuntu:24.04',
    declaredDeps: declaredDeps as Record<string, unknown>,
    currentDockerfile: FRESH_DOCKERFILE,
  };
}

const reconcile = generateDockerfileStep.reconcileReusedFormValues!;

describe('02-generate-dockerfile reconcileReusedFormValues', () => {
  it('drops a reused Dockerfile whose source template declared different deps', async () => {
    // The repo gained DDEV, so 01 wrote containerTool=ddev; the replayed Dockerfile
    // still comes from the containerTool=none template. Left alone, apply() would hash
    // it, dedupe onto that old template and discard the ddev row 01 just wrote.
    const { ctx, infos } = makeCtx({ id: 'tpl-old', declaredDeps: PLAIN_DEPS });
    const out = await reconcile(ctx, detect(DDEV_DEPS), {
      dockerfile: PRIOR_DOCKERFILE,
    } as FormValues);
    expect(out.dockerfile).toBe(FRESH_DOCKERFILE);
    expect(infos).toHaveLength(1);
  });

  it('keeps a hand-edited Dockerfile when the declared deps are unchanged', async () => {
    const { ctx, infos } = makeCtx({ id: 'tpl-old', declaredDeps: DDEV_DEPS });
    const out = await reconcile(ctx, detect(DDEV_DEPS), {
      dockerfile: PRIOR_DOCKERFILE,
    } as FormValues);
    expect(out.dockerfile).toBe(PRIOR_DOCKERFILE);
    expect(infos).toHaveLength(0);
  });

  it('compares deps regardless of key order', async () => {
    const { ctx } = makeCtx({
      id: 'tpl-old',
      declaredDeps: { runtimes: ['php'], containerTool: 'ddev' },
    });
    const out = await reconcile(ctx, detect(DDEV_DEPS), {
      dockerfile: PRIOR_DOCKERFILE,
    } as FormValues);
    expect(out.dockerfile).toBe(PRIOR_DOCKERFILE);
  });

  it('re-renders when no template carries the reused Dockerfile any more', async () => {
    const { ctx } = makeCtx(null);
    const out = await reconcile(ctx, detect(DDEV_DEPS), {
      dockerfile: PRIOR_DOCKERFILE,
    } as FormValues);
    expect(out.dockerfile).toBe(FRESH_DOCKERFILE);
  });

  it('leaves an empty reused value alone so validation reports the missing field', async () => {
    const { ctx } = makeCtx(null);
    const reused = { dockerfile: '   ' } as FormValues;
    expect(await reconcile(ctx, detect(DDEV_DEPS), reused)).toBe(reused);
  });
});
