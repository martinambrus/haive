import { eq } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import {
  dimensionScopeOverride,
  resolveReviewDimensions,
  type ReviewDimensionSelection,
} from '@haive/shared/review';

const log = logger.child({ module: 'review-dimension-context' });

/** Which review dimensions this task's reviewers score against.
 *
 *  Two levels, resolved task ?? repository ?? every dimension. The repository
 *  column is the POLICY and the only one the upstream steps can see — discovery
 *  (03) and the spec writer (04) run at indexes 3 and 4, before the run-config
 *  form at 6.05 — so `scope: 'repo'` is not a convenience, it is the honest
 *  answer for a step that runs before the task-level choice exists. Asking for
 *  the task value there would silently apply a narrowing the user made after the
 *  spec was already written.
 *
 *  Best-effort like every other reader on the dispatch path: an unreadable row
 *  answers "every dimension", which is the pre-feature behaviour. Failing open
 *  is right here specifically because the failure mode of failing closed would
 *  be a review that silently scored nothing.
 */
export async function resolveTaskReviewDimensions(
  db: Database,
  taskId: string,
  scope: 'repo' | 'task' = 'task',
): Promise<ReviewDimensionSelection> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { repositoryId: true, reviewDimensions: true },
    });
    if (!task) return resolveReviewDimensions(null);
    if (scope === 'task' && task.reviewDimensions !== null) {
      return resolveReviewDimensions(task.reviewDimensions);
    }
    // A task with no repository has no policy to inherit — every dimension applies.
    if (!task.repositoryId) return resolveReviewDimensions(null);
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { reviewDimensions: true },
    });
    return resolveReviewDimensions(repo?.reviewDimensions ?? null);
  } catch (err) {
    log.warn({ err, taskId }, 'review-dimension policy unreadable; scoring every dimension');
    return resolveReviewDimensions(null);
  }
}

/** The scope override as prompt lines, empty when every dimension is in scope.
 *
 *  One helper for the three prompts that defer to a repository's own
 *  `.claude/agents/<id>.md` (04's spec writer, 05's spec-quality reviewer, 08c's
 *  peer reviewer), so they cannot drift apart about how a narrowing is stated.
 *  Returns an array rather than a string so callers can spread it: the '' entries
 *  around it in those prompt arrays are deliberate blank lines and must survive.
 *
 *  Accepts undefined because `detect_output` is PERSISTED: a task whose detect ran
 *  before this field existed replays without it, and must keep every dimension
 *  rather than crash or silently narrow to none.
 */
export function dimensionScopeLines(
  reviewDimensionIds: readonly string[] | null | undefined,
): string[] {
  const block = dimensionScopeOverride(resolveReviewDimensions(reviewDimensionIds));
  return block ? [block] : [];
}
