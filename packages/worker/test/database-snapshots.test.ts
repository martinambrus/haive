import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  schema,
  initializeTaskDatabaseState,
  DatabaseSnapshotUnavailableError,
  type Database,
} from '@haive/database';
import { logger } from '@haive/shared';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import { databaseSnapshotRel } from '@haive/shared/database-snapshot-files';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { StepSupersededError } from '../src/step-engine/step-ownership.js';
import {
  databaseSaveForm,
  saveDatabaseStep,
} from '../src/step-engine/steps/workflow/11g-save-database.js';
import {
  DATABASE_SAVE_STEP_ID,
  loadDatabaseSnapshotState,
  reserveDatabaseSnapshot,
  promoteDatabaseSnapshot,
  discardDatabaseSnapshot,
  sweepDatabaseSnapshots,
  verifyDatabaseSnapshotFile,
} from '../src/repo/database-snapshots.js';
import { ddevEnvStep } from '../src/step-engine/steps/workflow/01c-ddev-env.js';
import { restoreDatabaseStep } from '../src/step-engine/steps/workflow/01c1-restore-database.js';

const runtime = vi.hoisted(() => ({ import: vi.fn(), config: vi.fn() }));
vi.mock('../src/step-engine/steps/workflow/_app-runtime.js', () => ({
  ensureDdevWithProgress: async () => ({ container: 'test', projectDir: '/repos/test' }),
  withDdevProgress: async (_ctx: unknown, _label: string, fn: (onLine: () => void) => unknown) =>
    fn(() => {}),
}));
vi.mock('../src/sandbox/ddev-runner.js', async (original) => ({
  ...(await original<typeof import('../src/sandbox/ddev-runner.js')>()),
  ddevExec: runtime.config,
  ddevImportDb: runtime.import,
  ddevCountTables: async () => 1,
  ddevSnapshot: async () => ({ exitCode: 0, output: '' }),
}));

const url = process.env.DATABASE_SNAPSHOT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/snapshot_test'))
  throw new Error('Use a dedicated snapshot_test database for snapshot integration tests');

describe.skipIf(!url)('database snapshot lifecycle on Postgres', () => {
  let db: Database;
  let root: string;
  let userId: string;
  let repoId: string;
  const oldRoot = process.env.REPO_STORAGE_ROOT;
  beforeAll(async () => {
    db = createDatabase(url!);
    root = await mkdtemp(path.join(os.tmpdir(), 'haive-database-snapshot-test-'));
    process.env.REPO_STORAGE_ROOT = root;
  });
  beforeEach(async () => {
    runtime.import.mockReset().mockResolvedValue({ exitCode: 0, output: 'imported' });
    runtime.config.mockReset().mockResolvedValue({
      exitCode: 0,
      output:
        '# Complete processed project configuration:\nomit_containers: []\ndatabase:\n  type: postgres\n  version: "17"\n',
    });
    userId = randomUUID();
    repoId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    await db.insert(schema.repositories).values({
      id: repoId,
      userId,
      name: 'snapshot-test',
      source: 'blank',
      storagePath: `${root}/${userId}/${repoId}`,
    });
  });
  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await sweepDatabaseSnapshots(db);
    expect(
      await db
        .select()
        .from(schema.databaseSnapshots)
        .where(eq(schema.databaseSnapshots.repositoryId, repoId)),
    ).toHaveLength(0);
  });
  afterAll(async () => {
    if (oldRoot === undefined) delete process.env.REPO_STORAGE_ROOT;
    else process.env.REPO_STORAGE_ROOT = oldRoot;
    await rm(root, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
  });

  async function task(title: string, sourceSnapshotId?: string): Promise<StepContext> {
    const [row] = await db
      .insert(schema.tasks)
      .values({ userId, repositoryId: repoId, title, type: 'workflow', status: 'running' })
      .returning();
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: row!.id,
        stepId: DATABASE_SAVE_STEP_ID,
        stepIndex: 13,
        title: 'Save database',
        status: 'running',
      })
      .returning();
    await initializeTaskDatabaseState(db, row!, { sourceSnapshotId });
    return {
      taskId: row!.id,
      taskStepId: step!.id,
      userId,
      db,
      repoPath: root,
      workspacePath: root,
      sandboxWorkdir: '/workspace',
      cliProviderId: null,
      round: 0,
      signal: new AbortController().signal,
      logger: logger.child({ module: 'database-snapshot-test' }),
      throwIfCancelled() {},
      async emitProgress() {},
    };
  }
  async function candidate(ctx: StepContext) {
    const epoch = (await loadDatabaseSnapshotState(ctx))!.epoch;
    const row = await reserveDatabaseSnapshot(ctx, epoch, {
      engine: 'postgres',
      engineVersion: '17',
      codeCommit: 'a'.repeat(40),
    });
    const bytes = gzipSync(Buffer.from(`CREATE TABLE example (id integer); -- ${ctx.taskId}`));
    await writeFileNoFollow(root, databaseSnapshotRel(row), bytes, { createParents: true });
    await db
      .update(schema.databaseSnapshots)
      .set({
        status: 'ready',
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
      .where(eq(schema.databaseSnapshots.id, row.id));
    return row;
  }
  const complete = (ctx: StepContext, status: 'completed' | 'cancelled' = 'completed') =>
    db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, ctx.taskId));
  const head = () =>
    db.query.repositoryDatabaseStates.findFirst({
      where: eq(schema.repositoryDatabaseStates.repositoryId, repoId),
    });
  const restoreArgs = (snapshot: { id: string }) => ({
    detected: {
      ddevConfigured: true,
      repoSubpath: 'test',
      workspace: null,
      dbUploadId: null as string | null,
      dumpWorkerPath: null,
      dumpRunnerPath: '/db-dump/project.sql.gz',
      needsConfig: false,
      proposedConfig: null,
      databaseSnapshotId: snapshot.id as string | null,
      snapshotEngine: 'postgres' as string | null,
    },
    formValues: {},
    iteration: 0,
    previousIterations: [],
  });

  it('captures an older task’s project revision at startup even without a database input', async () => {
    const a = await task('older task without a dump');
    await db
      .delete(schema.taskDatabaseStates)
      .where(eq(schema.taskDatabaseStates.taskId, a.taskId));
    await ddevEnvStep.detect!(a);
    expect(
      (await db.query.taskDatabaseStates.findFirst({
        where: eq(schema.taskDatabaseStates.taskId, a.taskId),
      }))!.baseRevision,
    ).toBe(0);
    const b = await task('parallel save');
    await candidate(b);
    await promoteDatabaseSnapshot(b, 0);
    const form = databaseSaveForm(await loadDatabaseSnapshotState(a))!;
    expect(form.fields.find((f) => f.id === 'action')).toMatchObject({
      options: expect.arrayContaining([{ value: 'replace:1', label: expect.any(String) }]),
    });
  });

  it('restores a pinned snapshot once, keeps its file and ignores stale detect data on retry', async () => {
    const a = await task('source');
    const saved = await candidate(a);
    await promoteDatabaseSnapshot(a, 0);
    const b = await task('restore', saved.id);
    const first = await restoreDatabaseStep.apply(b, restoreArgs(saved));
    expect(first.imported).toBe(true);
    expect(
      (await db.query.taskDatabaseStates.findFirst({
        where: eq(schema.taskDatabaseStates.taskId, b.taskId),
      }))!.importedAt,
    ).toBeInstanceOf(Date);
    expect((await restoreDatabaseStep.apply(b, restoreArgs(saved))).imported).toBe(false);
    expect(runtime.import).toHaveBeenCalledTimes(1);
    await expect(access(path.join(root, databaseSnapshotRel(saved)))).resolves.toBeUndefined();
  });

  it('restores an uploaded dump in the separate step and ignores consumed uploads on retry', async () => {
    const a = await task('uploaded database');
    const [upload] = await db
      .insert(schema.dbUploads)
      .values({
        userId,
        filename: 'project.sql',
        dumpFormat: 'sql',
        totalSize: 10,
        chunkSize: 10,
        dumpPath: '/unused/project.sql',
        status: 'complete',
      })
      .returning();
    await db
      .update(schema.tasks)
      .set({ dbUploadId: upload!.id })
      .where(eq(schema.tasks.id, a.taskId));
    const args = restoreArgs({ id: '' });
    args.detected.dbUploadId = upload!.id;
    args.detected.databaseSnapshotId = null;
    args.detected.snapshotEngine = null;
    expect(await restoreDatabaseStep.shouldRun!(a)).toBe(true);
    expect((await restoreDatabaseStep.apply(a, args)).imported).toBe(true);
    expect(await restoreDatabaseStep.shouldRun!(a)).toBe(false);
    expect((await restoreDatabaseStep.apply(a, args)).imported).toBe(false);
    expect(runtime.import).toHaveBeenCalledTimes(1);
  });

  it('rejects corrupt snapshots and incompatible engines before importing', async () => {
    const a = await task('source');
    const saved = await candidate(a);
    await promoteDatabaseSnapshot(a, 0);
    const b = await task('restore', saved.id);
    runtime.config.mockResolvedValue({
      exitCode: 0,
      output:
        '# Complete processed project configuration:\nomit_containers: []\ndatabase:\n  type: mariadb\n  version: "10.11"\n',
    });
    await expect(restoreDatabaseStep.apply(b, restoreArgs(saved))).rejects.toThrow(
      'saved database uses postgres',
    );
    expect(runtime.import).not.toHaveBeenCalled();
    const row = (await db.query.databaseSnapshots.findFirst({
      where: eq(schema.databaseSnapshots.id, saved.id),
    }))!;
    await verifyDatabaseSnapshotFile(row);
    const bytes = await readFile(path.join(root, databaseSnapshotRel(saved)));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFileNoFollow(root, databaseSnapshotRel(saved), bytes);
    await expect(restoreDatabaseStep.apply(b, restoreArgs(saved))).rejects.toThrow('checksum');
    expect(runtime.import).not.toHaveBeenCalled();
  });

  const saveArgs = (action?: string) => ({
    detected: null,
    formValues: action ? { action } : {},
    iteration: 0,
    previousIterations: [],
  });
  it('requires explicit approval before saving even with a ready candidate', async () => {
    const a = await task('manual decision');
    const saved = await candidate(a);
    await expect(saveDatabaseStep.apply(a, saveArgs())).rejects.toThrow('Choose whether');
    expect((await head())!.revision).toBe(0);
    expect((await saveDatabaseStep.apply(a, saveArgs('save:0'))).outcome).toBe('saved');
    expect((await head())!.snapshotId).toBe(saved.id);
  });
  it('rejects an unseen revision before export and discards an existing candidate on decline', async () => {
    const a = await task('first');
    const b = await task('second');
    await candidate(a);
    const unused = await candidate(b);
    await promoteDatabaseSnapshot(a, 0);
    await expect(saveDatabaseStep.apply(b, saveArgs('save:0'))).rejects.toThrow('Choose whether');
    expect(runtime.config).not.toHaveBeenCalled();
    expect((await head())!.revision).toBe(1);
    expect((await saveDatabaseStep.apply(b, saveArgs('discard'))).outcome).toBe('discarded');
    await expect(access(path.join(root, databaseSnapshotRel(unused)))).rejects.toThrow();
  });
  it('declining without a candidate never touches the database runtime', async () => {
    const a = await task('no snapshot needed');
    await db
      .update(schema.taskDatabaseStates)
      .set({ saveEnabled: false })
      .where(eq(schema.taskDatabaseStates.taskId, a.taskId));
    expect(databaseSaveForm(await loadDatabaseSnapshotState(a))).not.toBeNull();
    expect((await saveDatabaseStep.apply(a, saveArgs('discard'))).outcome).toBe('discarded');
    expect(runtime.config).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(schema.databaseSnapshots)
        .where(eq(schema.databaseSnapshots.repositoryId, repoId)),
    ).toHaveLength(0);
  });

  it('one concurrent save wins; declining the other deletes its file and inventory', async () => {
    const a = await task('A');
    const b = await task('B');
    const ca = await candidate(a);
    const cb = await candidate(b);
    const results = await Promise.all([
      promoteDatabaseSnapshot(a, 0),
      promoteDatabaseSnapshot(b, 0),
    ]);
    expect(results.sort()).toEqual(['conflict', 'saved']);
    const current = await head();
    const winner = current!.snapshotId === ca.id ? a : b;
    const loser = winner === a ? b : a;
    const lostSnapshot = winner === a ? cb : ca;
    const form = databaseSaveForm(await loadDatabaseSnapshotState(loser));
    expect(form?.fields.find((f) => f.id === 'sourceTask')).toMatchObject({
      body: winner === a ? 'A' : 'B',
    });
    expect(await promoteDatabaseSnapshot(winner, 0)).toBe('saved');
    expect((await head())!.revision).toBe(1);
    await discardDatabaseSnapshot(loser, 0);
    await expect(access(path.join(root, databaseSnapshotRel(lostSnapshot)))).rejects.toThrow();
    expect(
      await db.query.databaseSnapshots.findFirst({
        where: eq(schema.databaseSnapshots.id, lostSnapshot.id),
      }),
    ).toBeUndefined();
    expect((await head())!.snapshotId).toBe(current!.snapshotId);
    expect(
      await readFile(path.join(root, databaseSnapshotRel(winner === a ? ca : cb))),
    ).not.toHaveLength(0);
  });

  it('keeps the source selected by a queued task until that task ends', async () => {
    const a = await task('initial');
    const initial = await candidate(a);
    await promoteDatabaseSnapshot(a, 0);
    await complete(a);
    const queued = await task('queued reader', initial.id);
    await db
      .update(schema.tasks)
      .set({ status: 'queued' })
      .where(eq(schema.tasks.id, queued.taskId));
    const c = await task('new winner', initial.id);
    const newer = await candidate(c);
    await promoteDatabaseSnapshot(c, 0);
    await complete(c);
    await sweepDatabaseSnapshots(db);
    await expect(access(path.join(root, databaseSnapshotRel(initial)))).resolves.toBeUndefined();
    expect((await head())!.snapshotId).toBe(newer.id);
    await complete(queued, 'cancelled');
    await sweepDatabaseSnapshots(db);
    await expect(access(path.join(root, databaseSnapshotRel(initial)))).rejects.toThrow();
    await expect(access(path.join(root, databaseSnapshotRel(newer)))).resolves.toBeUndefined();
  });

  it('does not reverse a committed discard or save when a delayed duplicate arrives', async () => {
    const a = await task('discard first');
    const rejected = await candidate(a);
    expect(await discardDatabaseSnapshot(a, 0)).toBe('discarded');
    expect(await promoteDatabaseSnapshot(a, 0)).toBe('discarded');
    expect((await head())!.snapshotId).toBeNull();
    await expect(access(path.join(root, databaseSnapshotRel(rejected)))).rejects.toThrow();
    const b = await task('save first');
    const saved = await candidate(b);
    expect(await promoteDatabaseSnapshot(b, 0)).toBe('saved');
    expect(await discardDatabaseSnapshot(b, 0)).toBe('saved');
    expect((await head())!.snapshotId).toBe(saved.id);
    expect((await loadDatabaseSnapshotState(b))!.state.outcome).toBe('saved');
  });

  it('refreshes an overwrite decision if a third task saves while the warning is open', async () => {
    const a = await task('A');
    const b = await task('B');
    await candidate(a);
    const cb = await candidate(b);
    await promoteDatabaseSnapshot(a, 0);
    expect(await promoteDatabaseSnapshot(b, 0)).toBe('conflict');
    const shownRevision = (await loadDatabaseSnapshotState(b))!.revision;
    const c = await task('C');
    await candidate(c);
    await promoteDatabaseSnapshot(c, 0);
    expect(await promoteDatabaseSnapshot(b, 0, shownRevision)).toBe('conflict');
    expect((await head())!.revision).toBe(2);
    expect(await promoteDatabaseSnapshot(b, 0, 2)).toBe('saved');
    await sweepDatabaseSnapshots(db);
    expect((await head())!.snapshotId).toBe(cb.id);
    expect(
      await db
        .select()
        .from(schema.databaseSnapshots)
        .where(eq(schema.databaseSnapshots.repositoryId, repoId)),
    ).toHaveLength(1);
  });

  it('refuses publication after cancellation, step reset or an epoch change', async () => {
    const a = await task('cancelled');
    await candidate(a);
    await complete(a, 'cancelled');
    await expect(promoteDatabaseSnapshot(a, 0)).rejects.toBeInstanceOf(StepSupersededError);
    const b = await task('reset');
    await candidate(b);
    await db
      .update(schema.taskSteps)
      .set({ status: 'pending' })
      .where(eq(schema.taskSteps.id, b.taskStepId));
    await expect(promoteDatabaseSnapshot(b, 0)).rejects.toBeInstanceOf(StepSupersededError);
    const c = await task('new epoch');
    await candidate(c);
    await db
      .update(schema.tasks)
      .set({ orchestrationEpoch: 1 })
      .where(eq(schema.tasks.id, c.taskId));
    await expect(promoteDatabaseSnapshot(c, 0)).rejects.toBeInstanceOf(StepSupersededError);
    expect((await head())!.snapshotId).toBeNull();
    await sweepDatabaseSnapshots(db);
    expect(
      await db.query.databaseSnapshots.findFirst({
        where: and(
          eq(schema.databaseSnapshots.repositoryId, repoId),
          eq(schema.databaseSnapshots.sourceTaskId, a.taskId),
        ),
      }),
    ).toBeUndefined();
  });

  it('drops a pending candidate from an earlier epoch before saving retried work', async () => {
    const a = await task('retried');
    const old = await candidate(a);
    await db
      .update(schema.tasks)
      .set({ orchestrationEpoch: 1 })
      .where(eq(schema.tasks.id, a.taskId));
    const state = await loadDatabaseSnapshotState(a);
    expect(state!.state).toMatchObject({
      outcome: 'pending',
      candidateSnapshotId: null,
      decisionEpoch: null,
    });
    await sweepDatabaseSnapshots(db);
    await expect(access(path.join(root, databaseSnapshotRel(old)))).rejects.toThrow();
    const fresh = await candidate(a);
    expect(await promoteDatabaseSnapshot(a, 1)).toBe('saved');
    expect((await head())!.snapshotId).toBe(fresh.id);
  });

  it('reaps abandoned partial exports and skipped candidates, including after repository deletion', async () => {
    const a = await task('interrupted export');
    const partial = await reserveDatabaseSnapshot(a, 0, {
      engine: 'postgres',
      engineVersion: '17',
      codeCommit: null,
    });
    await writeFileNoFollow(root, `${databaseSnapshotRel(partial)}.partial`, 'partial', {
      createParents: true,
    });
    await sweepDatabaseSnapshots(db);
    await expect(
      access(path.join(root, `${databaseSnapshotRel(partial)}.partial`)),
    ).resolves.toBeUndefined();
    await db
      .update(schema.taskSteps)
      .set({ status: 'skipped' })
      .where(eq(schema.taskSteps.id, a.taskStepId));
    await sweepDatabaseSnapshots(db);
    await expect(
      access(path.join(root, `${databaseSnapshotRel(partial)}.partial`)),
    ).rejects.toThrow();
    const b = await task('retained current');
    const saved = await candidate(b);
    await promoteDatabaseSnapshot(b, 0);
    await db.delete(schema.repositories).where(eq(schema.repositories.id, repoId));
    await sweepDatabaseSnapshots(db);
    await expect(access(path.join(root, databaseSnapshotRel(saved)))).rejects.toThrow();
  });

  it('pins only the current snapshot of the same repository and owner', async () => {
    const a = await task('A');
    const saved = await candidate(a);
    await promoteDatabaseSnapshot(a, 0);
    const other = await task('requester');
    await db
      .delete(schema.taskDatabaseStates)
      .where(eq(schema.taskDatabaseStates.taskId, other.taskId));
    const row = (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, other.taskId) }))!;
    await expect(
      initializeTaskDatabaseState(
        db,
        { ...row, userId: randomUUID() },
        { sourceSnapshotId: saved.id },
      ),
    ).rejects.toBeInstanceOf(DatabaseSnapshotUnavailableError);
    const c = await task('C');
    await candidate(c);
    await promoteDatabaseSnapshot(c, 0);
    await expect(
      initializeTaskDatabaseState(db, row, { sourceSnapshotId: saved.id }),
    ).rejects.toBeInstanceOf(DatabaseSnapshotUnavailableError);
    expect(
      await db.query.taskDatabaseStates.findFirst({
        where: eq(schema.taskDatabaseStates.taskId, other.taskId),
      }),
    ).toBeUndefined();
  });
});
