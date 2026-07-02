import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { Database } from '@haive/database';

/** Load the per-repo onboarding scope deny list (`repositories.scope_exclude_globs`)
 *  for the repository behind `taskId`.
 *
 *  Returns `[]` when the repo has no list — a repo onboarded before this feature,
 *  one whose scope-selection step (06_7) was skipped, or one where the user kept
 *  every directory in scope. Callers then behave exactly as before: mining sees the
 *  whole repo minus the step's own hardcoded IGNORE_DIRS.
 *
 *  Defensive by design: the query is wrapped so a step-runner test with a mock db
 *  (no tasks/repositories tables) degrades to `[]` instead of throwing. */
export async function loadScopeExcludeGlobs(db: Database, taskId: string): Promise<string[]> {
  try {
    const rows = await db
      .select({ globs: schema.repositories.scopeExcludeGlobs })
      .from(schema.tasks)
      .innerJoin(schema.repositories, eq(schema.tasks.repositoryId, schema.repositories.id))
      .where(eq(schema.tasks.id, taskId))
      .limit(1);
    return rows[0]?.globs ?? [];
  } catch {
    return [];
  }
}

/** True when a repo-relative path IS an excluded directory or lives under one.
 *  Deny globs are anchored directory prefixes (e.g. `web/modules/contrib`), so an
 *  anchored prefix test — not a loose path-segment test — is the correct match. */
export function isDeniedPath(rel: string, exclude: readonly string[]): boolean {
  for (const g of exclude) {
    if (rel === g || rel.startsWith(`${g}/`)) return true;
  }
  return false;
}

/** Soft-scope instruction lines for a mining prompt. Tells the agent to mine only
 *  this project's own code and treat the excluded directories as third-party /
 *  built-in — reachable with read tools for context, but never mined or indexed.
 *  Returns `[]` when there is no deny list (nothing to say), so callers can spread
 *  it unconditionally. */
export function scopeInstructionLines(exclude: readonly string[]): string[] {
  if (exclude.length === 0) return [];
  return [
    '## Mining scope (IMPORTANT)',
    "Mine, analyse and index ONLY this project's own code. The partial file tree above is already",
    'filtered to the in-scope directories. The directories listed below are third-party or',
    'framework built-ins and are OUT OF SCOPE — do NOT mine, summarise or index them (you MAY',
    "still open an individual file there for context when this project's own code references it):",
    ...exclude.map((g) => `- ${g}`),
    'Any directory not listed above is in scope by default, including new folders added later.',
    '',
  ];
}
