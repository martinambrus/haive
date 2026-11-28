import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { DelayedError } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { requireCheckoutAccess, type CheckoutAccess } from '@haive/shared/checkout-access';
import { REPO_JOB_NAMES } from '@haive/shared';
import { planCheckoutAccess } from '../src/repo/checkout-access-scope.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import { handleScan, persistDetection, withRootClaim } from './support/repo-preparation.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  processor: undefined as ((job: unknown, token?: string) => Promise<unknown>) | undefined,
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Worker: class {
    constructor(_name: string, processor: (job: unknown, token?: string) => Promise<unknown>) {
      h.processor = processor;
    }
    on() {}
  },
}));
vi.mock('../src/project-state/sync.js', () => ({ syncProjectStateFromCheckout: vi.fn() }));
vi.mock('../src/project-state/rtk-conflict.js', () => ({ raiseRtkQuestion: vi.fn() }));
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../src/plan/mirror.js')>()),
  importPlanMirror: vi.fn(async () => ({
    imported: false,
    code: 'no_mirror',
    reason: 'no plan mirror',
  })),
  reconcilePlanFromCheckout: vi.fn(),
  recordPlanMirrorError: vi.fn(),
}));
import { startRepoWorker } from '../src/queues/repo-queue.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Seen {
  access: CheckoutAccess;
  rowKind: string | null;
  rowOwner: string | null;
  policy: 'ok' | Error;
}

async function setup(status: 'ready' | 'cloning') {
  const root = await mkdtemp(join(tmpdir(), 'repo-redelivery-claim-'));
  dirs.push(root);
  await mkdir(join(root, '.haive-data'));
  await writeFile(
    join(root, '.haive-data/exclusions.json'),
    '{"schemaVersion":1,"scopeExcludeGlobs":["vendor/**"]}',
  );
  const fake = createFakeDb({
    auditEvents: schema.auditEvents,
    repositories: schema.repositories,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
    planNodes: schema.planNodes,
  });
  const id = randomUUID();
  const jobId = randomUUID();
  fake.insert(schema.repositories, {
    id,
    userId: randomUUID(),
    name: 'acme',
    source: 'blank',
    status,
    storagePath: root,
    refreshPending: true,
    refreshJobId: jobId,
  });
  const db = fake.db as unknown as Database;
  h.db = db;
  const row = async () =>
    (await db.select().from(schema.repositories).where(eq(schema.repositories.id, id)))[0]!;
  const seen: Seen[] = [];
  vi.mocked(syncProjectStateFromCheckout).mockImplementation((async () => {
    const access = planCheckoutAccess();
    const r = await row();
    const policy = await requireCheckoutAccess(db as never, id, access).then(
      () => 'ok' as const,
      (e: unknown) => e as Error,
    );
    seen.push({ access, rowKind: r.rootClaimKind, rowOwner: r.rootClaimOwner, policy });
    return { outcome: 'unchanged' };
  }) as never);
  const foreign = (kind: string, ageMs = 0) =>
    fake.patch(schema.repositories, id, {
      rootClaimedAt: new Date(Date.now() - ageMs),
      rootClaimKind: kind,
      rootClaimOwner: randomUUID(),
    });
  const clearClaim = () =>
    fake.patch(schema.repositories, id, {
      rootClaimedAt: null,
      rootClaimKind: null,
      rootClaimOwner: null,
    });
  const moveToDelayed = vi.fn(async () => undefined);
  const job = (name: string) => ({
    id: jobId,
    name,
    data: { repositoryId: id, userId: randomUUID() },
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    moveToDelayed,
  });
  return { db, id, jobId, root, row, seen, foreign, clearClaim, moveToDelayed, job };
}

beforeEach(() => {
  startRepoWorker('/fixture');
});

function expectCarried(
  s: Seen[],
  row: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['row']>>,
) {
  expect(s).toHaveLength(1);
  expect(s[0]!.access.mode).toBe('preparation');
  expect(s[0]!.access).toHaveProperty('owner');
  expect(s[0]!.rowKind).toBe('rebuild');
  expect(s[0]!.rowOwner).toEqual(expect.any(String));
  expect(s[0]!.policy).toBe('ok');
  expect(row.rootClaimedAt).toBeNull();
  expect(row.refreshPending).toBe(false);
  expect(row.refreshJobId).toBeNull();
}

describe('a redelivered ready preparation job', () => {
  const foreignCases: [string, string][] = [
    ...['rebuild', 'edit', 'reset', 'verify', 'mutation'].map(
      (k) => [REPO_JOB_NAMES.CLONE, k] as [string, string],
    ),
    ...[REPO_JOB_NAMES.COPY, REPO_JOB_NAMES.INIT, REPO_JOB_NAMES.EXTRACT].map(
      (n) => [n, 'edit'] as [string, string],
    ),
  ];
  it.each(foreignCases)(
    '%s waits behind a foreign %s claim, then imports once',
    async (name, kind) => {
      const f = await setup('ready');
      f.foreign(kind);
      const before = await f.row();

      await expect(h.processor!(f.job(name), 'tok')).rejects.toBeInstanceOf(DelayedError);

      expect(f.moveToDelayed).toHaveBeenCalledTimes(1);
      expect(syncProjectStateFromCheckout).not.toHaveBeenCalled();
      const held = await f.row();
      expect(held.scopeExcludeGlobs).toBeNull();
      expect(held.status).toBe('ready');
      expect(held.refreshPending).toBe(true);
      expect(held.refreshJobId).toBe(f.jobId);
      expect(held.rootClaimKind).toBe(before.rootClaimKind);
      expect(held.rootClaimOwner).toBe(before.rootClaimOwner);
      expect(held.rootClaimedAt).toEqual(before.rootClaimedAt);

      f.clearClaim();
      await expect(h.processor!(f.job(name), 'tok')).resolves.not.toThrow();
      expect(syncProjectStateFromCheckout).toHaveBeenCalledTimes(1);
      const done = await f.row();
      expect(done.scopeExcludeGlobs).toEqual(['vendor/**']);
      expect(done.refreshPending).toBe(false);
      expect(done.refreshJobId).toBeNull();
    },
  );

  it('imports under its own preparation claim when no claim is held', async () => {
    const f = await setup('ready');
    await h.processor!(f.job(REPO_JOB_NAMES.CLONE), 'tok');
    const done = await f.row();
    expect(done.scopeExcludeGlobs).toEqual(['vendor/**']);
    expect(syncProjectStateFromCheckout).toHaveBeenCalledTimes(1);
    expectCarried(f.seen, done);
  });

  it('takes over a claim that is sixteen minutes old', async () => {
    const f = await setup('ready');
    f.foreign('rebuild', 16 * 60 * 1000);
    await h.processor!(f.job(REPO_JOB_NAMES.CLONE), 'tok');
    const done = await f.row();
    expect(done.scopeExcludeGlobs).toEqual(['vendor/**']);
    expect(syncProjectStateFromCheckout).toHaveBeenCalledTimes(1);
    expectCarried(f.seen, done);
  });
});

describe('paths that already hold their claim', () => {
  it('persistDetection inside withRootClaim imports once under the outer claim', async () => {
    const f = await setup('cloning');
    let outer: CheckoutAccess | undefined;
    await withRootClaim(f.db, f.id, async () => {
      outer = planCheckoutAccess();
      await persistDetection(f.db, f.id, f.root);
    });
    expect(syncProjectStateFromCheckout).toHaveBeenCalledTimes(1);
    expect(outer?.mode).toBe('preparation');
    expect(f.seen[0]!.access).toBe(outer);
    expect(f.seen[0]!.policy).toBe('ok');
    expect((await f.row()).scopeExcludeGlobs).toEqual(['vendor/**']);
  });

  it('SCAN with no claim still runs the imports', async () => {
    const f = await setup('cloning');
    await handleScan(
      { repositoryId: f.id, userId: randomUUID(), localPath: f.root } as never,
      f.db,
    );
    expect(syncProjectStateFromCheckout).toHaveBeenCalledTimes(1);
    expect((await f.row()).scopeExcludeGlobs).toEqual(['vendor/**']);
  });
});
