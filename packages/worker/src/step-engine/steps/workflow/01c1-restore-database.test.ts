import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formSchemaSchema } from '@haive/shared';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext } from '../../step-definition.js';
import { ddevEnvStep } from './01c-ddev-env.js';
import { databaseRestoreForm, restoreDatabaseStep } from './01c1-restore-database.js';

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
});
