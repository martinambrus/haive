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

// VOLATILE: 02's wording; a run marked `recordWriteFails` fails loudly when it stops matching.
const SWALLOWED_PREFIXES = [
  'project state record write failed',
  'the record was written, but retiring the files it replaces failed',
];

/** Awaits a 02 apply, whose record write and retire block must have run, or with `recordWriteFails` failed. */
export async function recordWritten<T extends { warnings: string[] }>(
  applied: Promise<T>,
  { recordWriteFails = false }: { recordWriteFails?: boolean } = {},
): Promise<T> {
  const out = await applied;
  const swallowed = out.warnings.filter((w) => SWALLOWED_PREFIXES.some((p) => w.startsWith(p)));
  if (recordWriteFails) expect(swallowed).not.toEqual([]);
  else expect(swallowed).toEqual([]);
  return out;
}
