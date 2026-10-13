import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  userSecretsService: { get: async () => null },
}));

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { RTK_ENABLED_UNIT, conflictSide } from '@haive/shared/project-state';
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const OTHER_REPO = '00000000-0000-4000-8000-0000000000c2';

const app = new Hono<AppEnv>();
app.route('/', toolingUpgradeRoutes);
app.onError(errorHandler);

function setup() {
  const fake = createFakeDb({
    repositories: schema.repositories,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
    envTemplates: schema.envTemplates,
    toolPackageVersions: schema.toolPackageVersions,
    stepGuidance: schema.stepGuidance,
  });
  for (const id of [REPO, OTHER_REPO]) {
    fake.insert(schema.repositories, {
      id,
      userId: USER,
      name: id,
      source: 'local_path',
      rtkEnabled: true,
    });
    fake.insert(schema.projectStateConflicts, {
      repositoryId: id,
      unit: RTK_ENABLED_UNIT,
      base: conflictSide(true),
      local: conflictSide(true),
      incoming: conflictSide(false),
    });
  }
  h.db = fake.db;
  const rowOf = (repositoryId: string) =>
    fake.rows(schema.projectStateConflicts).find((r) => r.repositoryId === repositoryId)!;
  const repoRtk = () => fake.rows(schema.repositories).find((r) => r.id === REPO)!.rtkEnabled;
  return { fake, rowOf, repoRtk };
}

const patch = (body: Record<string, unknown>) =>
  app.request(`/${REPO}/tooling`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

let s: ReturnType<typeof setup>;
beforeEach(() => {
  s = setup();
});

describe('switching RTK off on the tooling page and a pending RTK question', () => {
  it('closes the question as converged, by the user, in the same write as the column', async () => {
    expect((await patch({ rtkEnabled: false })).status).toBe(200);

    expect(s.repoRtk()).toBe(false);
    expect(s.rowOf(REPO)).toMatchObject({ resolution: 'converged', resolvedBy: USER });
    expect(s.rowOf(REPO).resolvedAt).toBeInstanceOf(Date);
  });

  it('leaves another repository question alone', async () => {
    await patch({ rtkEnabled: false });

    expect(s.rowOf(OTHER_REPO)).toMatchObject({ resolution: null, resolvedAt: null });
  });

  it('keeps the question when RTK is switched on or the request does not touch RTK', async () => {
    await patch({ rtkEnabled: true });
    await patch({ prWorkflowEnabled: true });

    expect(s.rowOf(REPO)).toMatchObject({ resolution: null, resolvedAt: null });
  });

  it('leaves an answered question as it was answered', async () => {
    const answered = new Date(1000);
    await s.fake.db
      .update(schema.projectStateConflicts)
      .set({ resolution: 'keep_mine', resolvedAt: answered })
      .where(eq(schema.projectStateConflicts.repositoryId, REPO));

    await patch({ rtkEnabled: false });

    expect(s.rowOf(REPO)).toMatchObject({ resolution: 'keep_mine', resolvedAt: answered });
  });

  it('writes nothing when the request is refused', async () => {
    expect((await patch({ verifyCommands: { build: 'make' }, rtkEnabled: false })).status).toBe(
      400,
    );

    expect(s.repoRtk()).toBe(true);
    expect(s.rowOf(REPO).resolvedAt).toBeNull();
  });
});
