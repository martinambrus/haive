import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** A run whose usage is recorded but whose output was never reported: `token_usage` is an object
 *  and its `outputTokens` is not a number. A row with no usage at all is not one. */
export function outputUnknownRowSql(tu: SQLWrapper): SQL<boolean> {
  return sql<boolean>`(jsonb_typeof(${tu}) = 'object' and jsonb_typeof(${tu} -> 'outputTokens') is distinct from 'number')`;
}

/** Sum of the reported outputs. NULL when no run in the group reported one: unknown is not 0. */
export function outputTokensSumSql(tu: SQLWrapper): SQL<number | null> {
  return sql<number | null>`sum((${tu} ->> 'outputTokens')::numeric)::int`;
}

/** How many runs in the group never reported an output. */
export function outputUnknownRunsSql(tu: SQLWrapper): SQL<number> {
  return sql<number>`count(*) filter (where ${outputUnknownRowSql(tu)})::int`;
}
