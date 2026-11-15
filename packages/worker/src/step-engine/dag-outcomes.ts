import { PROVIDER_FATAL_HEADLINES } from '../queues/cli-exec/failure-class.js';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

// Reserved host provenance in concerns. Agent-written concerns are stripped at ingest.
export const DAG_NO_CHANGE_MARKER = 'DAG_HOST_NO_CHANGE';
export const DAG_BLOCKED_BY_MARKER = 'DAG_HOST_BLOCKED_BY:';
export const DAG_FINAL_FAILURE_MARKER = 'DAG_HOST_FINAL_FAILURE';

type Issue = Pick<
  typeof schema.taskDagIssues.$inferSelect,
  'outcome' | 'resolution' | 'concerns' | 'mergeStatus' | 'mergedAt' | 'cliInvocationId'
>;

export function stripDagHostMarkers(text: string): string {
  return text.replace(/DAG_HOST_[A-Z_]+/g, '[reserved host marker]');
}

const unmerged = (i: Issue) => i.mergeStatus === null && i.mergedAt === null;
const completed = (i: Issue) => i.outcome === 'completed' || i.outcome === 'completed_with_debt';
export function issueNoChange(i: Issue): boolean {
  return (
    unmerged(i) &&
    completed(i) &&
    (i.resolution === null ||
      i.resolution === 'approved' ||
      i.resolution === 'completed_with_debt') &&
    (i.concerns === DAG_NO_CHANGE_MARKER ||
      i.concerns?.startsWith(`${DAG_NO_CHANGE_MARKER}\n`) === true)
  );
}
export function issueBlocked(i: Issue): boolean {
  return (
    unmerged(i) &&
    i.outcome === 'failed_unrecoverable' &&
    i.resolution === 'failed_unrecoverable' &&
    i.cliInvocationId === null &&
    i.concerns?.startsWith(DAG_BLOCKED_BY_MARKER) === true
  );
}
export function issueFinalFailure(i: Issue): boolean {
  return (
    unmerged(i) &&
    i.resolution === 'failed_unrecoverable' &&
    (i.concerns === DAG_FINAL_FAILURE_MARKER ||
      i.concerns?.startsWith(`${DAG_FINAL_FAILURE_MARKER}\n`) === true)
  );
}

export async function loadDagOutcomeCounts(db: Database, taskId: string) {
  const plan = await db.query.taskDagPlans.findFirst({
    where: eq(schema.taskDagPlans.taskId, taskId),
    columns: { id: true },
  });
  const issues = plan
    ? await db
        .select()
        .from(schema.taskDagIssues)
        .where(eq(schema.taskDagIssues.dagPlanId, plan.id))
    : [];
  const counts = {
    total: issues.length,
    split: 0,
    merged: 0,
    failed: 0,
    refused: 0,
    blocked: 0,
    noChange: 0,
    skipped: 0,
    unconfirmed: 0,
  };
  for (const i of issues) {
    if (i.resolution === 'split') counts.split++;
    else if ((i.mergeStatus === 'clean' || i.mergeStatus === 'resolved') && i.mergedAt !== null)
      counts.merged++;
    else if (issueBlocked(i)) counts.blocked++;
    else if (issueNoChange(i)) counts.noChange++;
    else if (i.resolution === 'skipped') counts.skipped++;
    else if (i.outcome === 'failed_unrecoverable' || i.resolution === 'failed_unrecoverable') {
      if (i.errorMessage?.startsWith(PROVIDER_FATAL_HEADLINES.content_filter)) counts.refused++;
      else counts.failed++;
    } else counts.unconfirmed++;
  }
  return counts;
}
