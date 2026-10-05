import { describe, expect, it } from 'vitest';
import { formSchemaSchema } from '@haive/shared';
import { databaseSaveForm, saveDatabaseStep } from './11g-save-database.js';
import type { loadDatabaseSnapshotState } from '../../../repo/database-snapshots.js';
type View = NonNullable<Awaited<ReturnType<typeof loadDatabaseSnapshotState>>>;

const view = (patch: Partial<View> = {}): View => ({
  state: { outcome: 'pending', baseRevision: 1, exportError: null } as View['state'],
  revision: 2,
  candidate: { status: 'ready' } as View['candidate'],
  current: {
    sourceTaskId: 'task-A',
    sourceTaskTitle: 'Drupal installation',
    createdAt: new Date('2026-10-05T00:00:00Z'),
  } as View['current'],
  epoch: 0,
  title: 'task B',
  ...patch,
});

describe('database save decisions', () => {
  it('offers a manual conflict choice tied to the revision shown', () => {
    const form = databaseSaveForm(view())!;
    expect(formSchemaSchema.safeParse(form).success).toBe(true);
    expect(form.autoSubmit).not.toBe(true);
    const action = form.fields.find((f) => f.id === 'action');
    expect(action).toMatchObject({
      default: 'discard',
      options: expect.arrayContaining([{ value: 'replace:2', label: expect.any(String) }]),
    });
    expect(form.description).toContain('task-A');
    expect(form.description).toContain('deletes');
    expect(saveDatabaseStep.metadata.alwaysWaitForUser).toBe(true);
  });
  it('requires a decision for an export failure before teardown', () => {
    const form = databaseSaveForm(view({ state: { ...view().state, exportError: 'disk full' } }))!;
    expect(formSchemaSchema.safeParse(form).success).toBe(true);
    expect(form.description).toContain('disk full');
    expect(form.autoSubmit).toBe(false);
    expect(form.fields.find((f) => f.id === 'action')).toMatchObject({
      options: expect.arrayContaining([
        { value: 'replace:2', label: expect.any(String) },
        { value: 'discard', label: expect.any(String) },
      ]),
    });
  });
  it('renders the conflict after detect output has been persisted as JSON', () => {
    const persisted = JSON.parse(JSON.stringify(view())) as View;
    const form = databaseSaveForm(persisted)!;
    expect(formSchemaSchema.safeParse(form).success).toBe(true);
    expect(form.description).toContain('2026-10-05T00:00:00.000Z');
  });
  it('always prompts before export even when there is no conflict or candidate', () => {
    const form = databaseSaveForm(view({ revision: 1, candidate: null }))!;
    expect(form.autoSubmit).toBe(false);
    expect(form.fields.find((f) => f.id === 'action')).toMatchObject({
      options: expect.arrayContaining([{ value: 'save:1', label: expect.any(String) }]),
    });
  });
  it('preserves a decision already committed', () => {
    expect(databaseSaveForm(view({ state: { ...view().state, outcome: 'saved' } }))).toBeNull();
    expect(databaseSaveForm(view({ state: { ...view().state, outcome: 'discarded' } }))).toBeNull();
    expect(saveDatabaseStep.metadata.index).toBeLessThan(14);
  });
});
