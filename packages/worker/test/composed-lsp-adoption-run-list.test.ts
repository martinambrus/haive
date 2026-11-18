import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { composedLspAdoptable } from '../src/lsp/composed-adoption.js';

// A run_app task and an unknown task never adopt contract 2: the run list decides, and it is
// checked before any provider table is read, so the fixture registers only the two run-list tables.

const adoptable = (db: Database, taskId: string) =>
  composedLspAdoptable(db, { taskId, userId: 'user', defaultProviderId: null });

describe('composedLspAdoptable run list', () => {
  it('refuses a run_app task, whose modes list has no composed LSP steps', async () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskTypeDefinitions: schema.taskTypeDefinitions,
    });
    const task = fake.insert(schema.tasks, {
      type: 'run_app',
      runListSnapshot: null,
      executionPath: null,
    });
    expect(await adoptable(fake.db as unknown as Database, String(task.id))).toEqual({
      ok: false,
      reason: 'run_list',
    });
  });

  it('refuses a task that does not exist', async () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskTypeDefinitions: schema.taskTypeDefinitions,
    });
    expect(await adoptable(fake.db as unknown as Database, crypto.randomUUID())).toEqual({
      ok: false,
      reason: 'run_list',
    });
  });
});
