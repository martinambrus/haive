import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formSchemaSchema } from '@haive/shared';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext } from '../../step-definition.js';
import { ddevEnvStep } from './01c-ddev-env.js';
import { databaseRestoreForm, restoreDatabaseStep } from './01c1-restore-database.js';

const cleanup = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  removeNoFollow: cleanup.remove,
}));
vi.mock('./_app-runtime.js', () => ({
  ensureDdevWithProgress: async () => ({ container: 'test', projectDir: '/repos/test' }),
  withDdevProgress: async (_ctx: unknown, _label: string, fn: (onLine: () => void) => unknown) =>
    fn(() => {}),
}));
vi.mock('../../../sandbox/ddev-runner.js', async (original) => ({
  ...(await original<typeof import('../../../sandbox/ddev-runner.js')>()),
  ddevImportDb: async () => ({ exitCode: 0, output: 'imported' }),
  ddevCountTables: async () => 1,
  ddevSnapshot: async () => ({ exitCode: 0, output: '' }),
  sniffDumpFormat: async () => ({ pgRestore: false, gzipped: false }),
}));

const detected = {
  repoSubpath: 'test',
  workspace: null,
  dbUploadId: null,
  dumpWorkerPath: null,
  dumpRunnerPath: null,
  databaseSnapshotId: 'snapshot-A',
  snapshotEngine: 'postgres',
  checkpoint: {
    id: 'snapshot-A',
    sourceTaskId: 'task-A',
    sourceTaskTitle: 'Installed Drupal',
    createdAt: new Date('2026-10-05T08:30:00Z'),
    engine: 'postgres',
    engineVersion: '17',
  },
};
describe('database restoration decisions', () => {
  it('offers restore or continue without restoring, and requires manual input', () => {
    const form = databaseRestoreForm(detected)!;
    expect(formSchemaSchema.safeParse(form).success).toBe(true);
    expect(form.autoSubmit).toBe(false);
    expect(restoreDatabaseStep.metadata.alwaysWaitForUser).toBe(true);
    expect(form.fields.find((f) => f.id === 'action')).toMatchObject({
      default: 'restore:snapshot-A',
      options: [
        { value: 'skip', label: expect.any(String) },
        {
          value: 'restore:snapshot-A',
          label: 'Restore this saved database checkpoint (2026-10-05T08:30:00.000Z · postgres 17)',
        },
      ],
    });
    expect(form.fields.find((f) => f.id === 'checkpoint')).toMatchObject({
      body: '**Database checkpoint:** `2026-10-05T08:30:00.000Z · postgres 17`',
    });
    expect(form.fields.find((f) => f.id === 'sourceTask')).toMatchObject({
      body: '**Saved by task:**\n\nInstalled Drupal\n\n[Open source task](/tasks/task-A)',
    });
  });
  it('renders persisted checkpoint timestamps and omits the choice when an upload overrides it', () => {
    expect(
      databaseRestoreForm(JSON.parse(JSON.stringify(detected)))!.fields.find(
        (f) => f.id === 'checkpoint',
      ),
    ).toMatchObject({ body: expect.stringContaining('2026-10-05T08:30:00.000Z') });
    expect(databaseRestoreForm({ ...detected, dbUploadId: 'upload-A' })).toBeNull();
    expect(databaseRestoreForm({ ...detected, databaseSnapshotId: null })).toBeNull();
  });
});

describe('shouldRun for a task that carries an uploaded dump', () => {
  afterEach(() => vi.restoreAllMocks());

  // A failed task that ended 25 h ago, the age at which the upload reaper takes its dump.
  function failedTask(dump: { status: string }, imported = false): StepContext {
    const fake = createFakeDb({
      tasks: schema.tasks,
      dbUploads: schema.dbUploads,
      taskDatabaseStates: schema.taskDatabaseStates,
    });
    const userId = randomUUID();
    const dumpId = randomUUID();
    const taskId = randomUUID();
    fake.insert(schema.dbUploads, {
      id: dumpId,
      userId,
      filename: 'project.sql',
      dumpFormat: 'sql',
      totalSize: 1,
      chunkSize: 1,
      dumpPath: '/unused/project.sql',
      status: dump.status,
    });
    fake.insert(schema.tasks, {
      id: taskId,
      userId,
      dbUploadId: dumpId,
      status: 'failed',
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    if (imported) {
      fake.insert(schema.taskDatabaseStates, {
        taskId,
        repositoryId: randomUUID(),
        baseRevision: 0,
        importedAt: new Date(),
      });
    }
    vi.spyOn(ddevEnvStep, 'shouldRun').mockResolvedValue(true);
    return { db: fake.db, taskId } as unknown as StepContext;
  }

  it('runs for a complete dump', async () => {
    expect(await restoreDatabaseStep.shouldRun!(failedTask({ status: 'complete' }))).toBe(true);
  });

  it('skips a dump the import already consumed', async () => {
    expect(await restoreDatabaseStep.shouldRun!(failedTask({ status: 'consumed' }))).toBe(false);
  });

  it('fails a Retry whose dump the reaper cancelled, saying the dump must be uploaded again', async () => {
    const ctx = failedTask({ status: 'cancelled' });

    const run = restoreDatabaseStep.shouldRun!(ctx);

    await expect(run).rejects.toThrow('removed after the task ended');
    await expect(run).rejects.toThrow('Upload it again');
  });

  it('skips a cancelled dump the task has already imported', async () => {
    const ctx = failedTask({ status: 'cancelled' }, true);

    expect(await restoreDatabaseStep.shouldRun!(ctx)).toBe(false);
  });

  it('fails a Retry whose dump the reaper has claimed and not yet removed, the same way', async () => {
    const ctx = failedTask({ status: 'reaping' });

    const run = restoreDatabaseStep.shouldRun!(ctx);

    await expect(run).rejects.toThrow('removed after the task ended');
    await expect(run).rejects.toThrow('Upload it again');
  });

  it('skips a reaping dump the task has already imported', async () => {
    const ctx = failedTask({ status: 'reaping' }, true);

    expect(await restoreDatabaseStep.shouldRun!(ctx)).toBe(false);
  });

  it('fails a Retry whose dump the reaper gave up removing, the same way', async () => {
    const ctx = failedTask({ status: 'reap_failed' });

    await expect(restoreDatabaseStep.shouldRun!(ctx)).rejects.toThrow(
      'removed after the task ended',
    );
  });
});

describe('uploaded dump cleanup after import', () => {
  it.each([false, true])('consumes the upload when cleanup fails: %s', async (fails) => {
    const fake = createFakeDb({ dbUploads: schema.dbUploads });
    const userId = randomUUID();
    const dumpId = randomUUID();
    const root = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
    const rel = `_uploads/${userId}/db-${dumpId}.sql`;
    const err = Object.assign(new Error('the removal failed'), { code: 'EACCES' });
    cleanup.remove.mockReset();
    if (fails) cleanup.remove.mockRejectedValue(err);
    else cleanup.remove.mockResolvedValue(true);
    fake.insert(schema.dbUploads, {
      id: dumpId,
      userId,
      filename: 'project.sql',
      dumpFormat: 'sql',
      totalSize: 1,
      chunkSize: 1,
      dumpPath: `${root}/${rel}`,
      status: 'complete',
    });
    const warn = vi.fn();
    const ctx = {
      db: fake.db,
      taskId: randomUUID(),
      logger: { warn },
      emitProgress: async () => {},
    } as unknown as StepContext;

    const result = await restoreDatabaseStep.apply(ctx, {
      detected: {
        ...detected,
        dbUploadId: dumpId,
        databaseSnapshotId: null,
        snapshotEngine: null,
        dumpWorkerPath: `${root}/${rel}`,
        dumpRunnerPath: `/repos/${rel}`,
      },
      formValues: {},
      iteration: 0,
      llmOutput: null,
      previousIterations: [],
    });

    expect(result).toEqual({ imported: true });
    expect(cleanup.remove).toHaveBeenCalledExactlyOnceWith(root, rel);
    expect(fake.rows(schema.dbUploads)).toHaveLength(1);
    expect(fake.rows(schema.dbUploads)[0]?.status).toBe('consumed');
    if (fails) {
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        { err, taskId: ctx.taskId, dbUploadId: dumpId, rel },
        'imported database dump was not removed',
      );
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  });
});
