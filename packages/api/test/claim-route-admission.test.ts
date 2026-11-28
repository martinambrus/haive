import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  lock: vi.fn(),
  claims: [] as Array<{ kind: string; released: boolean }>,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  lockNewWorkFenceShared: h.lock,
}));
// The real claim, recorded: its kind and whether it was released.
vi.mock('@haive/database', async (original) => {
  const real = await original<typeof import('@haive/database')>();
  return {
    ...real,
    acquireRootClaim: async (...args: Parameters<typeof real.acquireRootClaim>) => {
      const claim = await real.acquireRootClaim(...args);
      if (claim === null) return null;
      const entry = { kind: args[2], released: false };
      h.claims.push(entry);
      return {
        ...claim,
        release: async () => {
          entry.released = true;
          return claim.release();
        },
      };
    },
  };
});

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { repoRoutes } from '../src/routes/repos.js';
import { fileRoutes } from '../src/routes/tasks/files.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = randomUUID();
const TASK = randomUUID();

let fake: ReturnType<typeof createFakeDb>;
let fresh: ReturnType<typeof vi.spyOn>;
let root: string;
let repoWrites: number;

const app = new Hono<AppEnv>();
app.use('/tasks/*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/tasks', fileRoutes);
app.route('/repos', repoRoutes);
app.onError(errorHandler);

const claimedNow = () => fake.rows(schema.repositories)[0]!.rootClaimedAt != null;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'claim-admission-'));
  fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    onboardingArtifacts: schema.onboardingArtifacts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    status: 'ready',
    storagePath: root,
  });
  repoWrites = 0;
  fake.hooks.beforeUpdate = (table) => {
    if (table === schema.repositories) repoWrites += 1;
  };
  h.db = fake.db;
  h.claims = [];
  h.lock.mockReset().mockResolvedValue(undefined);
  fresh = vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Each refusal case: no claim, no fence, nothing of the route's work. */
const REFUSING = ['draining', 'maintenance'] as const;

describe('the editor save, PUT /tasks/:id/files/content', () => {
  const ORIGINAL = '# before\n';
  const EDITED = '# after\n';
  let file: string;

  const put = () =>
    app.request(`/tasks/${TASK}/files/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file, content: EDITED }),
    });

  async function seed(worktree: boolean): Promise<void> {
    const base = worktree ? path.join(root, '.haive', 'worktrees', 'wt') : root;
    file = path.join(base, KB_DIR, 'a.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, ORIGINAL, 'utf8');
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      repositoryId: REPO,
      type: 'workflow',
      status: 'running',
      ...(worktree ? { worktreePath: base } : {}),
    });
  }

  it.each(REFUSING)('answers 503 while %s, claims nothing and leaves the file', async (state) => {
    await seed(false);
    fresh.mockResolvedValue(state);
    expect((await put()).status).toBe(503);
    expect(h.claims).toEqual([]);
    expect(repoWrites).toBe(0);
    expect(h.lock).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(ORIGINAL);
  });

  it('answers 503 and holds no claim when the state turns draining after the precheck', async () => {
    await seed(false);
    fresh.mockResolvedValueOnce('normal').mockResolvedValue('draining');
    expect((await put()).status).toBe(503);
    expect(h.claims).toEqual([{ kind: 'edit', released: true }]);
    expect(claimedNow()).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(ORIGINAL);
  });

  it('saves the file under an edit claim it then releases while the state is normal', async () => {
    await seed(false);
    expect((await put()).status).toBe(200);
    expect(await readFile(file, 'utf8')).toBe(EDITED);
    expect(h.claims).toEqual([{ kind: 'edit', released: true }]);
    expect(claimedNow()).toBe(false);
  });

  it('takes no claim for a worktree task and does not refuse it while draining', async () => {
    await seed(true);
    fresh.mockResolvedValue('draining');
    expect((await put()).status).toBe(200);
    expect(await readFile(file, 'utf8')).toBe(EDITED);
    expect(h.claims).toEqual([]);
    expect(h.lock).not.toHaveBeenCalled();
  });
});

describe('POST /repos/:id/mark-onboarded', () => {
  const mark = () => app.request(`/repos/${REPO}/mark-onboarded`, { method: 'POST' });
  const before = () => structuredClone(fake.rows(schema.repositories));

  it.each(REFUSING)('answers 503 while %s and touches nothing', async (state) => {
    fresh.mockResolvedValue(state);
    const rows = before();
    expect((await mark()).status).toBe(503);
    expect(h.claims).toEqual([]);
    expect(h.lock).not.toHaveBeenCalled();
    expect(fake.rows(schema.repositories)).toEqual(rows);
  });

  it('answers 503 and holds no claim when the state turns draining after the precheck', async () => {
    fresh.mockResolvedValueOnce('normal').mockResolvedValue('draining');
    expect((await mark()).status).toBe(503);
    expect(h.claims).toEqual([{ kind: 'verify', released: true }]);
    expect(claimedNow()).toBe(false);
    expect(fake.rows(schema.repositories)[0]!.onboardedAt ?? null).toBeNull();
  });

  it('reaches the work under a verify claim it then releases while the state is normal', async () => {
    const res = await mark();
    // No markers on disk, so the work refuses; what matters is that it ran.
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('missing onboarding'),
    });
    expect(h.claims).toEqual([{ kind: 'verify', released: true }]);
    expect(claimedNow()).toBe(false);
  });
});

describe('DELETE /repos/:id/onboarding-artifacts', () => {
  const reset = () => app.request(`/repos/${REPO}/onboarding-artifacts`, { method: 'DELETE' });
  const before = () => structuredClone(fake.rows(schema.repositories));

  it.each(REFUSING)('answers 503 while %s and touches nothing', async (state) => {
    fresh.mockResolvedValue(state);
    const rows = before();
    expect((await reset()).status).toBe(503);
    expect(h.claims).toEqual([]);
    expect(h.lock).not.toHaveBeenCalled();
    expect(fake.rows(schema.repositories)).toEqual(rows);
  });

  it('answers 503 and holds no claim when the state turns draining after the precheck', async () => {
    fresh.mockResolvedValueOnce('normal').mockResolvedValue('draining');
    expect((await reset()).status).toBe(503);
    expect(h.claims).toEqual([{ kind: 'reset', released: true }]);
    expect(claimedNow()).toBe(false);
  });

  it('reaches the work under a reset claim it then releases while the state is normal', async () => {
    fake.insert(schema.tasks, {
      id: randomUUID(),
      userId: USER,
      repositoryId: REPO,
      type: 'onboarding',
      status: 'running',
    });
    const res = await reset();
    // A live onboarding run refuses the reset; what matters is that the work ran.
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('in progress') });
    expect(h.claims).toEqual([{ kind: 'reset', released: true }]);
    expect(claimedNow()).toBe(false);
  });
});
