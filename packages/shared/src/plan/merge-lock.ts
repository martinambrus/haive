import { sql, type SQL } from 'drizzle-orm';

/** First in every transaction that opens a repository's merge conversation, uses its scratch worktree
 *  outside one (a Save/Pull integration), or discards it, so no two of those interleave. */
export async function lockPlanMerge(
  tx: { execute: (query: SQL) => Promise<unknown> },
  repositoryId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`plan-merge:${repositoryId}`}, 0))`,
  );
}
