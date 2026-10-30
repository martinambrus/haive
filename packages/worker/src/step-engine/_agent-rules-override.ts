import { eq } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';

/** The repository's AGENTS.md rules override exactly as stored: the text, the empty string (an explicit
 *  "no block") or null, which follows Haive's default rules. A repository that is gone reads as null.
 *  Every writer and reader of the cli-rules region reads it through here, so none judges NULL and
 *  the empty string differently. */
export async function readAgentRulesOverrideRaw(
  db: Database | DbTx,
  repositoryId: string,
): Promise<string | null> {
  const [repo] = await db
    .select({ agentRulesOverride: schema.repositories.agentRulesOverride })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  return repo?.agentRulesOverride ?? null;
}
