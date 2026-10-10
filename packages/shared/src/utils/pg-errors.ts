const DUPLICATE_DATABASE_CODES: ReadonlySet<string> = new Set(['42P04', '23505']);

/** True when `CREATE DATABASE` lost to another creator: 42P04 once the name exists, 23505 on
 *  `pg_database_datname_index` when two creates overlap. drizzle puts the driver error on `cause`. */
export function isDuplicateDatabaseError(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return DUPLICATE_DATABASE_CODES.has(code);
  }
  return false;
}
