import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { FormValues } from '@haive/shared';
import {
  envTemplateHash,
  generateDockerfileStep,
} from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import type { GenerateDockerfileDetect } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

// apply() relinks this task when another template already carries the same Dockerfile
// hash, then drops the superseded row. That row can be SHARED (02 relinks tasks onto
// each other's templates, 01 later updates the shared row in place), and the FK is
// ON DELETE SET NULL — so deleting it under a live task nulls that task's link.

const DOCKERFILE = 'FROM ubuntu:24.04\nRUN echo hi\n';

interface Harness {
  ctx: StepContext;
  infos: Record<string, unknown>[];
  deleted: string[];
  linked: unknown[];
}

/** `hashMatch` stands in for the row `findEnvTemplateByHash` resolves the submitted
 *  Dockerfile + declared deps to; `sharingTaskIds` for the still-live OTHER tasks the
 *  reference query finds on the superseded row. */
function makeHarness(hashMatch: { id: string } | null, sharingTaskIds: string[]): Harness {
  const infos: Record<string, unknown>[] = [];
  const deleted: string[] = [];
  const linked: unknown[] = [];
  const db = {
    query: {
      envTemplates: { findFirst: vi.fn(async () => hashMatch ?? undefined) },
    },
    select: () => ({
      from: () => ({
        where: async () => sharingTaskIds.map((id) => ({ id })),
      }),
    }),
    update: () => ({ set: (v: unknown) => ({ where: async () => linked.push(v) }) }),
    delete: () => ({
      where: async () => deleted.push('tpl-current'),
    }),
  } as unknown as Database;
  const ctx = {
    taskId: 'task-1',
    userId: 'user-1',
    db,
    logger: { info: (o: Record<string, unknown>) => infos.push(o) },
  } as unknown as StepContext;
  return { ctx, infos, deleted, linked };
}

const detected: GenerateDockerfileDetect = {
  envTemplateId: 'tpl-current',
  baseImage: 'ubuntu:24.04',
  declaredDeps: {},
  currentDockerfile: DOCKERFILE,
};

function run(h: Harness) {
  return generateDockerfileStep.apply(h.ctx, {
    detected,
    formValues: { dockerfile: DOCKERFILE } as FormValues,
  } as Parameters<typeof generateDockerfileStep.apply>[1]);
}

describe('02-generate-dockerfile apply dedupe delete', () => {
  it('deletes the superseded row when no other live task references it', async () => {
    const h = makeHarness({ id: 'tpl-shared' }, []);
    const out = await run(h);
    expect(out.envTemplateId).toBe('tpl-shared');
    expect(h.deleted).toEqual(['tpl-current']);
  });

  it('keeps the superseded row when a live task still references it', async () => {
    const h = makeHarness({ id: 'tpl-shared' }, ['task-2']);
    const out = await run(h);
    // Still relinks THIS task — only the destructive half is skipped.
    expect(out.envTemplateId).toBe('tpl-shared');
    expect(h.deleted).toEqual([]);
    expect(h.infos[0]?.keptForTasks).toEqual(['task-2']);
  });

  it('never deletes when the hash resolves to the row this task already holds', async () => {
    const h = makeHarness({ id: 'tpl-current' }, ['task-2']);
    const out = await run(h);
    expect(out.envTemplateId).toBe('tpl-current');
    expect(h.deleted).toEqual([]);
  });

  it('rejects an empty Dockerfile before touching any row', async () => {
    const h = makeHarness({ id: 'tpl-shared' }, []);
    await expect(
      generateDockerfileStep.apply(h.ctx, {
        detected,
        formValues: { dockerfile: '  ' } as FormValues,
      } as Parameters<typeof generateDockerfileStep.apply>[1]),
    ).rejects.toThrow('dockerfile cannot be empty');
    expect(h.deleted).toEqual([]);
  });
});

describe('envTemplateHash', () => {
  // A DDEV project renders the same Dockerfile whatever php/database/webserver it
  // declares (renderDockerfile skips those blocks for ddev and never reads webserver),
  // so the text alone cannot separate environments — and `env_templates_user_hash_idx`
  // is UNIQUE on the stored hash, which is what turns a wrong key into a wrong merge.
  const DEPS = { containerTool: 'ddev', webserver: 'apache-fpm' };

  it('separates environments that render identical Dockerfiles', () => {
    expect(envTemplateHash(DOCKERFILE, DEPS)).not.toBe(
      envTemplateHash(DOCKERFILE, { ...DEPS, webserver: 'nginx-fpm' }),
    );
  });

  it('is stable for the same Dockerfile and deps regardless of key order', () => {
    expect(envTemplateHash(DOCKERFILE, DEPS)).toBe(
      envTemplateHash(DOCKERFILE, { webserver: 'apache-fpm', containerTool: 'ddev' }),
    );
  });

  it('still separates different Dockerfiles under identical deps', () => {
    expect(envTemplateHash(DOCKERFILE, DEPS)).not.toBe(
      envTemplateHash(`${DOCKERFILE}RUN echo more\n`, DEPS),
    );
  });
});
