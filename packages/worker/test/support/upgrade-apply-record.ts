import { expect } from 'vitest';
import { schema } from '@haive/database';

/** What 02's project state record write and the retire block after it use, beyond its apply loop. */
export const RECORD_WRITE_TABLES = {
  tasks: schema.tasks,
  projectStateConflicts: schema.projectStateConflicts,
  projectStateSync: schema.projectStateSync,
  projectStateOutbox: schema.projectStateOutbox,
  taskEvents: schema.taskEvents,
};

export const ROLLBACK_RECORD_WRITE_TABLES = {
  tasks: schema.tasks,
  taskSteps: schema.taskSteps,
  projectStateConflicts: schema.projectStateConflicts,
  projectStateSync: schema.projectStateSync,
  projectStateOutbox: schema.projectStateOutbox,
};

/** Awaits a 02, 04 or 12 apply, whose record write must have run, or with `recordWriteFails` failed. */
export async function recordWritten<
  T extends { warnings: string[]; recordWrite?: 'written' | 'failed' | 'skipped' },
>(
  applied: Promise<T>,
  { recordWriteFails = false }: { recordWriteFails?: boolean } = {},
): Promise<T> {
  const out = await applied;
  expect(out.recordWrite, out.warnings.join('\n')).toBe(recordWriteFails ? 'failed' : 'written');
  return out;
}
