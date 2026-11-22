import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/** What a stubbed `taskSteps` update leaves in `warningMessage`: a string or null patch replaces or
 *  clears it, an SQL patch is the one-statement append, applied as Postgres does. */
export function applyWarningPatch(current: string | null, patch: unknown): string | null {
  if (typeof patch === 'string' || patch === null) return patch;
  const note = new PgDialect().sqlToQuery(patch as SQL).params[0] as string;
  if (current?.includes(note)) return current;
  return [current, note].filter(Boolean).join(' ');
}
