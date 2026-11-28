import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.CHECKOUT_ACCESS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/checkout_access_test'))
  throw new Error('Use checkout_access_test scratch database');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  beforeGit: undefined as (() => Promise<void>) | undefined,
  beforeRemove: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../src/db.js', () => ({
  getDb: () => h.db,
  withFreshDatabase: async (run: (db: unknown) => Promise<unknown>) => {
    const { createDatabase } = await import('@haive/database');
    const fresh = createDatabase(process.env.CHECKOUT_ACCESS_TEST_URL!);
    try {
      return await run(fresh);
    } finally {
      await fresh.$client.end({ timeout: 5 });
    }
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(k: string, v: string): void }, next: () => Promise<void>) => {
    c.set('userId', '00000000-0000-4000-8000-000000007801');
    await next();
  },
}));
vi.mock('../src/lib/plan-mirror.js', () => ({ enqueuePlanMirrorRefresh: vi.fn() }));
vi.mock('../src/lib/relink-git.js', async (original) => {
  const real = await original<typeof import('../src/lib/relink-git.js')>();
  return {
    ...real,
    relinkGit: async (...args: Parameters<typeof real.relinkGit>) => {
      await h.beforeGit?.();
      return real.relinkGit(...args);
    },
  };
});
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    removeNoFollow: async (...args: Parameters<typeof real.removeNoFollow>) => {
      await h.beforeRemove?.();
      return real.removeNoFollow(...args);
    },
  };
});
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createDatabase, acquireRootClaim, schema, type Database } from '@haive/database';
import { configService } from '@haive/shared';
import { attachmentRoutes } from '../src/routes/tasks/attachments.js';
import { planRoutes } from '../src/routes/plan.js';
import { reconcileRemote } from '../src/lib/remote-reconcile.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const USER = '00000000-0000-4000-8000-000000007801';
const REPO = '00000000-0000-4000-8000-000000007802';
const TASK = '00000000-0000-4000-8000-000000007803';
const NODE = '00000000-0000-4000-8000-000000007804';
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/tasks', attachmentRoutes);
app.route('/repos', planRoutes);
app.onError(errorHandler);
const exec = promisify(execFile);
function barrier() {
  let reached!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((r) => {
    reached = r;
  });
  const done = new Promise<void>((r) => {
    resume = r;
  });
  return {
    entered,
    resume,
    wait: async () => {
      reached();
      await done;
    },
  };
}
describe.skipIf(!url)('checkout mutation lifetime on real filesystem, Git and Postgres', () => {
  let db: Database;
  let temp: string;
  let root: string;
  let template: string;
  const upload = (body: ReadableStream<Uint8Array> | string) =>
    app.request(`/tasks/${TASK}/attachments?filename=held.md`, {
      method: 'POST',
      body,
      duplex: 'half',
    });
  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    temp = await mkdtemp(join(tmpdir(), 'checkout-access-'));
    template = join(temp, 'template');
    await mkdir(template);
    await exec('git', ['init', '-q', template]);
    await exec('git', ['-C', template, 'remote', 'add', 'origin', 'https://old.test/repo']);
    vi.spyOn(configService, 'getNumber').mockResolvedValue(1024);
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
  });
  beforeEach(async () => {
    h.beforeGit = undefined;
    h.beforeRemove = undefined;
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    root = join(temp, 'repo');
    await rm(root, { force: true, recursive: true });
    await cp(template, root, { recursive: true });
    await db
      .insert(schema.users)
      .values({ id: USER, emailEncrypted: 'x', emailBlindIndex: 't780-pr2', passwordHash: 'x' });
    await db.insert(schema.repositories).values({
      id: REPO,
      userId: USER,
      name: 'scratch',
      source: 'blank',
      status: 'ready',
      storagePath: root,
      remoteUrl: 'https://saved.test/repo',
      remoteRelinkIntent: '00000000-0000-4000-8000-000000007805',
    });
    await db.insert(schema.tasks).values({
      id: TASK,
      userId: USER,
      repositoryId: REPO,
      title: 'scratch',
      type: 'workflow',
      status: 'failed',
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (db) {
      await db.delete(schema.users).where(eq(schema.users.id, USER));
      await db.$client.end({ timeout: 5 });
    }
    if (temp) await rm(temp, { force: true, recursive: true });
  });
  it('excludes a rebuild while an old upload handle streams and records its public row', async () => {
    const held = barrier();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          await held.wait();
          c.enqueue(new TextEncoder().encode('user bytes'));
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = upload(body);
    await held.entered;
    let rebuild;
    try {
      rebuild = await acquireRootClaim(db, REPO, 'rebuild', USER);
      expect(rebuild).toBeNull();
      // A complete old handle exists at this barrier; no transaction spans its body wait.
      expect(
        (
          await db.$client`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`
        )[0]!.n,
      ).toBe(0);
    } finally {
      await rebuild?.release();
      held.resume();
      await response;
    }
    expect((await response).status).toBe(201);
    expect(await readFile(join(root, '.haive/task-uploads', TASK, 'held.md'), 'utf8')).toBe(
      'user bytes',
    );
    const next = await acquireRootClaim(db, REPO, 'rebuild', USER);
    expect(next).not.toBeNull();
    try {
      await rename(root, join(temp, 'aside'));
    } finally {
      await next?.release();
    }
    expect(
      (await db.query.taskAttachments.findMany({ where: eq(schema.taskAttachments.taskId, TASK) }))
        .length,
    ).toBe(1);
  });
  it('holds remote reconciliation across real Git; foreign rebuild retains its repair intent', async () => {
    const held = barrier();
    h.beforeGit = held.wait;
    const reconcile = reconcileRemote(REPO, USER);
    await held.entered;
    let rebuild;
    try {
      // A row lock alone delays a claim while Git runs, but leaves no lease after a dropped connection.
      // Read without locking first so the baseline fails without blocking its own Git barrier.
      const row = await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, REPO),
      });
      expect(row!.rootClaimedAt).not.toBeNull();
      rebuild = await acquireRootClaim(db, REPO, 'rebuild', USER);
      expect(rebuild).toBeNull();
    } finally {
      await rebuild?.release();
      h.beforeGit = undefined;
      held.resume();
      await reconcile;
    }
    expect((await exec('git', ['-C', root, 'remote', 'get-url', 'origin'])).stdout.trim()).toBe(
      'https://saved.test/repo',
    );
    await db
      .update(schema.repositories)
      .set({ status: 'cloning', remoteRelinkIntent: '00000000-0000-4000-8000-000000007805' })
      .where(eq(schema.repositories.id, REPO));
    await expect(reconcileRemote(REPO, USER)).rejects.toMatchObject({
      code: 'checkout_unavailable',
    });
    expect(
      (await db.query.repositories.findFirst({ where: eq(schema.repositories.id, REPO) }))!
        .remoteRelinkIntent,
    ).toBeTruthy();
  });
  it('excludes rebuild across whole-plan DB deletion and both physical removals', async () => {
    await db.insert(schema.planNodes).values({
      id: NODE,
      repositoryId: REPO,
      parentId: null,
      path: `/${NODE}/`,
      title: 'root',
      kind: 'component',
      status: 'todo',
      ordinal: 0,
    });
    await mkdir(join(root, '.haive-data'));
    for (const name of ['plan.json', 'plan.md'])
      await writeFile(join(root, '.haive-data', name), 'old plan');
    const held = barrier();
    h.beforeRemove = held.wait;
    const response = app.request(`/repos/${REPO}/plan`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'scratch' }),
    });
    await held.entered;
    let rebuild;
    try {
      rebuild = await acquireRootClaim(db, REPO, 'rebuild', USER);
      expect(rebuild).toBeNull();
    } finally {
      await rebuild?.release();
      h.beforeRemove = undefined;
      held.resume();
      await response;
    }
    expect(await (await response).json()).toMatchObject({ deletedNodes: 1, mirrorRemoved: true });
    expect(
      await db.query.planNodes.findMany({ where: eq(schema.planNodes.repositoryId, REPO) }),
    ).toHaveLength(0);
  });
});
