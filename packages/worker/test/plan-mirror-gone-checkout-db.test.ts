import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { HAIVE_DATA_FILES, logger } from '@haive/shared';
import { applyPlanPatch, markPlanMirrorDirty } from '@haive/shared/plan';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

const { sweepDirtyPlanMirrors } = await import('../src/queues/plan-mirror-queue.js');

const url = process.env.GONE_CHECKOUT_PLAN_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/gone_checkout_plan_test')) {
  throw new Error('Use a dedicated gone_checkout_plan_test database for the gone-checkout test');
}

// A retry that fails logs a long line each time; the spy below still records the call.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
});

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@local',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' });

describe.skipIf(!url)('the plan sweep when a checkout directory is gone', () => {
  let db: Database;
  let root: string;
  const users: string[] = [];

  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    root = await mkdtemp(join(tmpdir(), 'gone-checkout-plan-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of users.splice(0)) await db.delete(schema.users).where(eq(schema.users.id, id));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
  });

  /** A repository whose mirror row is dirty (revision 1, nothing written) and whose directory does
   *  not exist: a plan of two nodes, or none at all. */
  async function dirtyRepository(opts: { plan: boolean; updatedAt: Date }) {
    const userId = randomUUID();
    users.push(userId);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    const storagePath = join(root, userId);
    const [repo] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'gone-checkout', source: 'blank', storagePath })
      .returning({ id: schema.repositories.id });
    const repositoryId = repo!.id;
    if (opts.plan) {
      await applyPlanPatch(
        db,
        {
          ops: [
            { op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Product' },
            { op: 'upsert', nodeRef: 'a', parentRef: 'root', title: 'A' },
          ],
        },
        { repositoryId, origin: 'llm' },
      );
    } else {
      await markPlanMirrorDirty(db, repositoryId);
    }
    await db
      .update(schema.planMirrorState)
      .set({ updatedAt: opts.updatedAt })
      .where(eq(schema.planMirrorState.repositoryId, repositoryId));
    return { id: repositoryId, path: storagePath };
  }

  async function createCheckout(dir: string) {
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '--allow-empty', '-qm', 'initial');
  }

  const mirror = async (repositoryId: string) =>
    (
      await db
        .select()
        .from(schema.planMirrorState)
        .where(eq(schema.planMirrorState.repositoryId, repositoryId))
    )[0];

  it('holds a dirty row whose directory was never created: no warning, still dirty, a reason stored', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const gone = await dirtyRepository({ plan: true, updatedAt: new Date() });

    expect(await sweepDirtyPlanMirrors()).toBe(0);

    expect(warn).not.toHaveBeenCalled();
    const row = await mirror(gone.id);
    expect(row!.revision).toBe(1);
    expect(row!.writtenRevision).toBe(0);
    expect(row!.lastError).not.toBeNull();
  });

  it('writes the plan on the next tick once the checkout is back at the same path', async () => {
    const gone = await dirtyRepository({ plan: true, updatedAt: new Date() });
    expect(await sweepDirtyPlanMirrors()).toBe(0);

    await createCheckout(gone.path);

    expect(await sweepDirtyPlanMirrors()).toBe(1);
    const row = await mirror(gone.id);
    expect(row!.writtenRevision).toBe(row!.revision);
    expect(row!.lastError).toBeNull();
    expect((await stat(join(gone.path, HAIVE_DATA_FILES.plan))).isFile()).toBe(true);
    expect((await stat(join(gone.path, HAIVE_DATA_FILES.planMarkdown))).isFile()).toBe(true);
  });

  it('still retires a dirty row with no plan whose directory is gone, without a warning', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const gone = await dirtyRepository({ plan: false, updatedAt: new Date() });

    expect(await sweepDirtyPlanMirrors()).toBe(1);

    expect(warn).not.toHaveBeenCalled();
    const row = await mirror(gone.id);
    expect(row!.writtenRevision).toBe(row!.revision);
  });

  it('writes the live row of the same tick and leaves the gone row dirty', async () => {
    const gone = await dirtyRepository({ plan: true, updatedAt: new Date(Date.now() - 60_000) });
    const live = await dirtyRepository({ plan: true, updatedAt: new Date() });
    await createCheckout(live.path);

    expect(await sweepDirtyPlanMirrors()).toBe(1);

    const liveRow = await mirror(live.id);
    expect(liveRow!.writtenRevision).toBe(liveRow!.revision);
    expect((await stat(join(live.path, HAIVE_DATA_FILES.plan))).isFile()).toBe(true);
    const goneRow = await mirror(gone.id);
    expect(goneRow!.writtenRevision).toBeLessThan(goneRow!.revision);
  });

  it('removes the mirror row with its repository', async () => {
    const gone = await dirtyRepository({ plan: true, updatedAt: new Date() });
    expect(await mirror(gone.id)).toBeDefined();

    await db.delete(schema.repositories).where(eq(schema.repositories.id, gone.id));

    expect(await mirror(gone.id)).toBeUndefined();
  });
});
