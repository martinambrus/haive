import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

// Message for the ONE commit a squashed feature merge leaves on the base branch.
// Collapsing the merge is what removes the per-issue commits from the base branch's
// history, so the surviving commit has to carry what they said.

/** merge_status values that mean an issue branch's work actually landed on the feature
 *  branch (set by dag-executor's merge pass). An issue that never merged is not part of
 *  what the squash commit contains, so it is not listed. */
const MERGED_STATUSES = ['clean', 'resolved'];

/** Subject = the task title, body = the DAG issues that landed, plus a `Task: <id>`
 *  trailer pointing back at the run. A non-DAG task simply gets no list. Falls back to
 *  `Merge <featureBranch>` when the task has no title — the same subject the un-squashed
 *  merge commit would have carried (merge-resolver's `-m` argument). */
export async function buildSquashCommitMessage(
  db: Database,
  taskId: string,
  featureBranch: string,
): Promise<string> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { title: true },
  });
  const subject = task?.title?.trim() || `Merge ${featureBranch}`;

  const issues = await db
    .select({
      issueKey: schema.taskDagIssues.issueKey,
      title: schema.taskDagIssues.title,
    })
    .from(schema.taskDagIssues)
    .where(
      and(
        eq(schema.taskDagIssues.taskId, taskId),
        inArray(schema.taskDagIssues.mergeStatus, MERGED_STATUSES),
      ),
    )
    .orderBy(asc(schema.taskDagIssues.level), asc(schema.taskDagIssues.issueKey));

  const lines = [subject];
  if (issues.length > 0) {
    lines.push(
      '',
      `Squashed ${issues.length} DAG issue${issues.length === 1 ? '' : 's'}:`,
      ...issues.map((i) => `- ${i.issueKey}: ${i.title}`),
    );
  }
  lines.push('', `Task: ${taskId}`);
  return lines.join('\n');
}
