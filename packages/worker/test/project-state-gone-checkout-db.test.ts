import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { acquireRootClaim, createDatabase, schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import {
  refreshProjectStateOutcome,
  sweepDirtyProjectStates,
} from '../src/project-state/refresh.js';
import { withPlanCheckoutAccess } from '../src/repo/checkout-access-scope.js';

const url = process.env.GONE_CHECKOUT_STATE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/gone_checkout_state_test')) {
  throw new Error('Use a dedicated gone_checkout_state_test database for the gone-checkout test');
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

const renderContext = {
  projectInfo: { name: 'gone-checkout' },
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
  rtkChoiceRecorded: false,
};

describe.skipIf(!url)('the project-state sweep when a checkout directory is gone', () => {
  let db: Database;
  let root: string;
  const users: string[] = [];

  beforeAll(async () => {
    db = createDatabase(url!);
    root = await mkdtemp(join(tmpdir(), 'gone-checkout-state-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of users.splice(0)) await db.delete(schema.users).where(eq(schema.users.id, id));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
  });

  /** A repository with a render context and the outbox row a boot leaves (revision 1, nothing
   *  written), whose directory does not exist. */
  async function dirtyRepository(updatedAt: Date) {
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
      .values({ userId, name: 'gone-checkout', source: 'blank', storagePath, renderContext })
      .returning({ id: schema.repositories.id });
    await db
      .insert(schema.projectStateOutbox)
      .values({ repositoryId: repo!.id, revision: 1, writtenRevision: 0, updatedAt });
    return { id: repo!.id, path: storagePath };
  }

  async function createCheckout(dir: string) {
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '--allow-empty', '-qm', 'initial');
  }

  const outbox = async (repositoryId: string) =>
    (
      await db
        .select()
        .from(schema.projectStateOutbox)
        .where(eq(schema.projectStateOutbox.repositoryId, repositoryId))
    )[0];

  it('holds a dirty row whose directory was never created: no warning, still dirty, a reason stored', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const gone = await dirtyRepository(new Date());

    expect(await sweepDirtyProjectStates(db)).toBe(0);

    expect(warn).not.toHaveBeenCalled();
    const row = await outbox(gone.id);
    expect(row!.revision).toBe(1);
    expect(row!.writtenRevision).toBe(0);
    expect(row!.lastError).not.toBeNull();
    expect(row!.writeIntent).toBeNull();
  });

  it('writes the record on the next tick once the checkout is back at the same path', async () => {
    const gone = await dirtyRepository(new Date());
    expect(await sweepDirtyProjectStates(db)).toBe(0);

    await createCheckout(gone.path);

    expect(await sweepDirtyProjectStates(db)).toBe(1);
    const row = await outbox(gone.id);
    expect(row!.writtenRevision).toBe(row!.revision);
    expect(row!.lastError).toBeNull();
    expect((await stat(join(gone.path, '.haive-data/state'))).isDirectory()).toBe(true);
  });

  it('writes the live row of the same tick and leaves the gone row dirty', async () => {
    const gone = await dirtyRepository(new Date(Date.now() - 60_000));
    const live = await dirtyRepository(new Date());
    await createCheckout(live.path);

    expect(await sweepDirtyProjectStates(db)).toBe(1);

    const liveRow = await outbox(live.id);
    expect(liveRow!.writtenRevision).toBe(liveRow!.revision);
    const goneRow = await outbox(gone.id);
    expect(goneRow!.writtenRevision).toBeLessThan(goneRow!.revision);
  });

  it('removes the outbox row with its repository', async () => {
    const gone = await dirtyRepository(new Date());
    expect(await outbox(gone.id)).toBeDefined();

    await db.delete(schema.repositories).where(eq(schema.repositories.id, gone.id));

    expect(await outbox(gone.id)).toBeUndefined();
  });
});

describe.skipIf(!url)('the project-state sweep while a rebuild holds the checkout', () => {
  let db: Database;
  let root: string;
  const users: string[] = [];

  beforeAll(async () => {
    db = createDatabase(url!);
    root = await mkdtemp(join(tmpdir(), 'held-checkout-state-'));
  });
  afterEach(async () => {
    for (const id of users.splice(0)) await db.delete(schema.users).where(eq(schema.users.id, id));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
  });

  /** A dirty repository with a real checkout, at the status a rebuild publishes. */
  async function rebuilding() {
    const userId = randomUUID();
    users.push(userId);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    const storagePath = join(root, userId);
    await mkdir(storagePath, { recursive: true });
    git(storagePath, 'init', '-q', '-b', 'main');
    git(storagePath, 'commit', '--allow-empty', '-qm', 'initial');
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'held-checkout',
        source: 'blank',
        storagePath,
        renderContext,
        status: 'cloning',
      })
      .returning({ id: schema.repositories.id });
    await db
      .insert(schema.projectStateOutbox)
      .values({ repositoryId: repo!.id, revision: 1, writtenRevision: 0 });
    return { id: repo!.id, path: storagePath };
  }
  const ready = (id: string) =>
    db.update(schema.repositories).set({ status: 'ready' }).where(eq(schema.repositories.id, id));
  const files = async (path: string) => (await readdir(path, { recursive: true })).sort();
  const outbox = async (repositoryId: string) =>
    (
      await db
        .select()
        .from(schema.projectStateOutbox)
        .where(eq(schema.projectStateOutbox.repositoryId, repositoryId))
    )[0]!;

  it('writes nothing under a live rebuild claim at status cloning, then writes after the release', async () => {
    const held = await rebuilding();
    const claim = await acquireRootClaim(db, held.id, 'rebuild');
    expect(claim).not.toBeNull();
    const before = await files(held.path);
    try {
      expect(await sweepDirtyProjectStates(db)).toBe(0);
      const first = await outbox(held.id);
      expect(await sweepDirtyProjectStates(db)).toBe(0);
      const second = await outbox(held.id);

      expect(await files(held.path)).toEqual(before);
      expect(first.writtenRevision).toBeLessThan(first.revision);
      expect(first.writeIntent).toBeNull();
      expect(first.lastError).not.toBeNull();
      expect(second.lastError).toBe(first.lastError);
      expect(second.revision).toBe(first.revision);
    } finally {
      await claim!.release();
    }
    await ready(held.id);

    expect(await sweepDirtyProjectStates(db)).toBe(1);
    const done = await outbox(held.id);
    expect(done.writtenRevision).toBe(done.revision);
    expect(done.lastError).toBeNull();
    expect(await files(held.path)).not.toEqual(before);
  });

  it("writes under the rebuild's own preparation scope at status cloning", async () => {
    const held = await rebuilding();
    const claim = await acquireRootClaim(db, held.id, 'rebuild');
    expect(claim).not.toBeNull();
    try {
      const result = await withPlanCheckoutAccess({ mode: 'preparation', owner: claim! }, () =>
        refreshProjectStateOutcome(db, held.id),
      );
      expect(result).toMatchObject({ outcome: 'written' });
    } finally {
      await claim!.release();
    }
    const done = await outbox(held.id);
    expect(done.writtenRevision).toBe(done.revision);
  });
});
