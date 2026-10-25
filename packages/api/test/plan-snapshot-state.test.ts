import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: vi.fn() }));
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
}));
vi.mock('../src/lib/spawn-plan-task.js', () => ({ spawnPlanTask: vi.fn() }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { HAIVE_DATA_FILES, configService } from '@haive/shared';
import { savePlanMirror, pullPlanMirror } from '../src/lib/plan-mirror.js';
import { planRoutes } from '../src/routes/plan.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
app.route('/', planRoutes);
app.onError(errorHandler);

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'plan-snapshot-state-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function writeSnapshotFiles(): Promise<void> {
  for (const rel of [HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown]) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), '{}\n');
  }
}

async function snapshot(mirror: { revision: number; writtenRevision: number } | null) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', storagePath: root });
  if (mirror) fake.insert(schema.planMirrorState, { repositoryId: REPO, ...mirror });
  h.db = fake.db;
  const res = await app.request(`/${REPO}/plan/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as { snapshotState: string; snapshotWritten: boolean };
}

describe('the plan snapshot state', () => {
  it.each(['save', 'pull'] as const)(
    'does not return a bound query value from %s',
    async (operation) => {
      vi.spyOn(configService, 'get').mockResolvedValue('true');
      const fake = createFakeDb({ repositories: schema.repositories, tasks: schema.tasks });
      fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', storagePath: root });
      h.db = fake.db;
      const secret = randomBytes(24).toString('base64url');
      const run = operation === 'save' ? savePlanMirror : pullPlanMirror;
      vi.mocked(run).mockClear();
      vi.mocked(run).mockRejectedValueOnce(
        new DrizzleQueryError('select $1', [secret], new Error(secret)),
      );
      const res = await app.request(`/${REPO}/plan/snapshot/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const text = await res.text();
      expect(res.status).toBe(409);
      expect(run).toHaveBeenCalledOnce();
      expect(
        Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
          text.includes(part),
        ),
      ).toBe(false);
    },
  );

  it('is updating while a write is owed', async () => {
    await writeSnapshotFiles();
    expect(await snapshot({ revision: 3, writtenRevision: 2 })).toMatchObject({
      snapshotState: 'updating',
      snapshotWritten: false,
    });
  });

  it('is written once the files hold the latest revision', async () => {
    await writeSnapshotFiles();
    expect(await snapshot({ revision: 3, writtenRevision: 3 })).toMatchObject({
      snapshotState: 'written',
      snapshotWritten: true,
    });
  });

  it('is missing when the files are gone and no write is owed', async () => {
    expect(await snapshot({ revision: 3, writtenRevision: 3 })).toMatchObject({
      snapshotState: 'missing',
      snapshotWritten: false,
    });
  });

  it('is missing when no write was ever recorded', async () => {
    expect(await snapshot(null)).toMatchObject({
      snapshotState: 'missing',
      snapshotWritten: false,
    });
  });
});
