import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
// The claim's own writes use a condition the fake has no builder for; what it protects is not under test.
vi.mock('@haive/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/database')>()),
  acquireRootClaim: async () => ({ release: async () => true, lost: () => false }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { repoRoutes, resetOnboardingArtifacts } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const FORMAT = '.haive-data/state/format.json';
const RENDER = '.haive-data/state/project/render.json';
const PROJECT_DIR = '.haive-data/state/project';
const STATE_DIR = '.haive-data/state';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const exists = async (root: string, rel: string): Promise<boolean> =>
  (await lstatNoFollow(root, rel)) !== null;

/** A repository root holding what 12 leaves under `.haive-data/state/`, and a plan snapshot beside it. */
async function repoRoot(extra: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reset-project-state-'));
  dirs.push(root);
  const files = {
    [FORMAT]: '{"schemaVersion":1}\n',
    [RENDER]: '{"framework":null}\n',
    '.haive-data/plan.json': '{}\n',
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, 'utf8');
  }
  return root;
}

const noProvenance = {
  writtenHashes: new Map<string, string>(),
  haiveDirs: new Set<string>(),
  haiveEntries: new Map<string, string | null>(),
};

describe('the reset takes back the project state onboarding recorded', () => {
  it('removes both record files and the two directories that held them', async () => {
    const root = await repoRoot();

    const { removed } = await resetOnboardingArtifacts(root, noProvenance);

    for (const rel of [FORMAT, RENDER, PROJECT_DIR, STATE_DIR]) {
      expect(await exists(root, rel), rel).toBe(false);
      expect(removed, rel).toContain(rel);
    }
    // `.haive-data` holds more than onboarding's own: the plan snapshot is not the reset's.
    expect(await exists(root, '.haive-data/plan.json')).toBe(true);
  });

  it('keeps `.haive-data/state` while a file somebody put there is in it', async () => {
    const root = await repoRoot({ [`${STATE_DIR}/mine.md`]: 'mine\n' });

    const { removed } = await resetOnboardingArtifacts(root, noProvenance);

    expect(await exists(root, FORMAT)).toBe(false);
    expect(await exists(root, RENDER)).toBe(false);
    expect(await exists(root, PROJECT_DIR)).toBe(false);
    expect(await readFile(path.join(root, STATE_DIR, 'mine.md'), 'utf8')).toBe('mine\n');
    expect(removed).not.toContain(STATE_DIR);
  });

  it('keeps `.haive-data/state/project`, and so `.haive-data/state`, while a file of theirs is in it', async () => {
    const root = await repoRoot({ [`${PROJECT_DIR}/mine.json`]: '{}\n' });

    const { removed } = await resetOnboardingArtifacts(root, noProvenance);

    expect(await exists(root, RENDER)).toBe(false);
    expect(await exists(root, FORMAT)).toBe(false);
    expect(await readFile(path.join(root, PROJECT_DIR, 'mine.json'), 'utf8')).toBe('{}\n');
    expect(removed).not.toContain(PROJECT_DIR);
    expect(removed).not.toContain(STATE_DIR);
  });
});

/** The statements the route's closing transaction makes, against the fake. The provenance query joins
 *  `task_steps` to `tasks`, which the fake has no builder for; a repository with no onboarding run
 *  has no rows to read there. */
async function setup(root: string) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    onboardingArtifacts: schema.onboardingArtifacts,
    projectStateSync: schema.projectStateSync,
  });
  const context = {
    projectInfo: {},
    framework: null,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    rtkChoiceRecorded: true,
  };
  for (const [id, storagePath] of [
    [REPO, root],
    [OTHER, '/elsewhere'],
  ] as const) {
    fake.insert(schema.repositories, {
      id,
      userId: USER,
      name: id,
      status: 'ready',
      storagePath,
      onboardedAt: new Date('2026-01-01T00:00:00Z'),
      renderContext: context,
    });
    fake.insert(schema.projectStateSync, { repositoryId: id, baseSnapshot: { render: context } });
  }
  const noRows = (): unknown => {
    const query: Record<string, unknown> = {};
    for (const method of ['innerJoin', 'where', 'orderBy']) query[method] = () => query;
    query.then = (ok: (rows: unknown[]) => unknown, bad: (err: unknown) => unknown) =>
      Promise.resolve([]).then(ok, bad);
    return query;
  };
  h.db = {
    ...fake.db,
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) =>
        table === schema.taskSteps ? noRows() : fake.db.select(fields).from(table as never),
    }),
  };
  return fake;
}

const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);

const reset = () => app.request(`/${REPO}/onboarding-artifacts`, { method: 'DELETE' });

describe('resetting a repository through the route', () => {
  it('takes the record files and their directories off its checkout', async () => {
    const root = await repoRoot();
    await setup(root);

    const res = await reset();

    expect(res.status).toBe(200);
    const { removed } = (await res.json()) as { removed: string[] };
    expect(removed).toEqual(expect.arrayContaining([FORMAT, RENDER, PROJECT_DIR, STATE_DIR]));
    expect(await exists(root, STATE_DIR)).toBe(false);
  });

  it('clears the render context it recorded, beside the onboarded stamp, and only on that repository', async () => {
    const fake = await setup(await repoRoot());

    expect((await reset()).status).toBe(200);

    const rows = fake.rows(schema.repositories);
    const mine = rows.find((r) => r.id === REPO)!;
    expect(mine.onboardedAt).toBeNull();
    expect(mine.onboardingResetAt).toBeInstanceOf(Date);
    expect(mine.renderContext).toBeNull();
    expect(rows.find((r) => r.id === OTHER)!.renderContext).not.toBeNull();
  });

  it('drops the sync record that goes with it, and only that repository’s', async () => {
    const fake = await setup(await repoRoot());

    expect((await reset()).status).toBe(200);

    expect(fake.rows(schema.projectStateSync).map((r) => r.repositoryId)).toEqual([OTHER]);
  });
});
