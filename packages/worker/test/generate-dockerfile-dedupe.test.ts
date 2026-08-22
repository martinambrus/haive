import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { FormValues } from '@haive/shared';
import { generateDockerfileStep } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
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

/** `hashMatch` stands in for the rows `findEnvTemplatesByHash` resolves the submitted
 *  Dockerfile to; `sharingTaskIds` for the still-live OTHER tasks the reference query
 *  finds on the superseded row. */
function makeHarness(
  hashMatch: { id: string; declaredDeps?: Record<string, unknown> } | null,
  sharingTaskIds: string[],
): Harness {
  const infos: Record<string, unknown>[] = [];
  const deleted: string[] = [];
  const linked: unknown[] = [];
  const db = {
    query: {
      envTemplates: { findMany: vi.fn(async () => (hashMatch ? [hashMatch] : [])) },
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

  it('does not merge onto a row whose declared deps differ', async () => {
    // Same Dockerfile bytes, different environment: a DDEV project renders the same
    // file whatever php/database/webserver it declares, so merging would hand this
    // task the other row's deps (the nginx-fpm-for-an-apache-project bug).
    const h = makeHarness({ id: 'tpl-shared', declaredDeps: { webserver: 'nginx-fpm' } }, []);
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
