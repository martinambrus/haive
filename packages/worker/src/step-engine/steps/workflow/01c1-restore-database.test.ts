import { describe, expect, it } from 'vitest';
import { formSchemaSchema } from '@haive/shared';
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
      default: 'skip',
      options: [
        { value: 'skip', label: expect.any(String) },
        { value: 'restore:snapshot-A', label: expect.any(String) },
      ],
    });
    expect(form.fields[0]).toMatchObject({ body: 'Installed Drupal' });
  });
  it('renders persisted checkpoint timestamps and omits the choice when an upload overrides it', () => {
    expect(databaseRestoreForm(JSON.parse(JSON.stringify(detected)))!.description).toContain(
      '2026-10-05T08:30:00.000Z',
    );
    expect(databaseRestoreForm({ ...detected, dbUploadId: 'upload-A' })).toBeNull();
    expect(databaseRestoreForm({ ...detected, databaseSnapshotId: null })).toBeNull();
  });
});
