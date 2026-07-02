/**
 * One-off, idempotent maintenance script.
 *
 * Repairs the two task-timing corruptions that made the task UI report absurd "effort"
 * (agent work) before the forward fix landed:
 *
 *  A) ended_at re-stamp (e.g. the 373h env-replicate task). A deterministic step that already
 *     finished got re-walked on resume and its ended_at was overwritten with the resume time
 *     while started_at kept its original value, inflating the step's wall span to days. The
 *     real completion is recoverable as the EARLIEST `step.done` event for that step. We reset
 *     ended_at to that timestamp. (The forward fix — advanceStep terminal short-circuit —
 *     prevents new occurrences.)
 *
 *  B) waiting_cli park billed as work (e.g. the 88h skill-generation task). A step parked in
 *     waiting_cli while the CLI allowance was exhausted accrued its whole span as work because
 *     no idle was recorded for the park. The park is recoverable from the step's cli_invocations
 *     timeline: merge the active intervals, sum the gaps between them that exceed a threshold =
 *     total parked time, and lift idle_ms to at least that. (The forward fix records this live
 *     for new parks via waiting_started_at.)
 *
 * Idempotent: A resets ended_at to a value derived from the durable event log (stable); B lifts
 * idle_ms toward a value derived from the durable invocation log with GREATEST (never decreases,
 * converges after one run). Re-running selects/writes nothing new.
 *
 * Note: B's GREATEST lifts idle_ms to the parked total, which for a heavily-parked step is
 * essentially the whole idle; any small pre-existing non-park idle it subsumes is negligible
 * against a multi-hour park. B is safe to re-run once a still-live task reaches a terminal state
 * to capture any later park.
 *
 * Scope: the two known-corrupted tasks by default; override with TASK_IDS (comma-separated).
 *
 * Safety:
 *  - Dry-run by default. Set APPLY=1 to write.
 *  - On apply it first writes every targeted row's original (id, ended_at, idle_ms) to
 *    backfill-task-timing-backup.json, then updates inside a single transaction.
 *
 * Run (inside the worker container):
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && tsx scripts/backfill-task-timing.ts'         # dry run
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && APPLY=1 tsx scripts/backfill-task-timing.ts' # apply
 *
 * Rollback: replay backfill-task-timing-backup.json (UPDATE task_steps SET ended_at=<orig>,
 * idle_ms=<orig> WHERE id=<id>).
 */
import { writeFileSync } from 'node:fs';
import { and, eq, isNotNull } from 'drizzle-orm';
import { createDatabase, schema } from '@haive/database';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const APPLY = process.env.APPLY === '1';
const BACKUP_PATH = '/app/packages/worker/scripts/backfill-task-timing-backup.json';

const DEFAULT_TASK_IDS = [
  '4f814398-bf4c-458d-a050-177653649fb4',
  '7af66712-2181-413a-9164-152c957a2c37',
];
const overrideIds = (process.env.TASK_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TASK_IDS = overrideIds.length ? overrideIds : DEFAULT_TASK_IDS;

// Gaps in the invocation timeline shorter than this are normal dispatch/queue latency between
// waves, not a park. The reported parks were tens of hours; 5 min excludes wave churn.
const PARK_GAP_THRESHOLD_MS = 5 * 60_000;

const db = createDatabase(DATABASE_URL);
const NOW = Date.now();

/** Total parked time = sum of gaps > threshold between a step's merged invocation active
 *  intervals. Open invocations (ended_at null) run up to NOW. */
function parkedMs(intervals: { start: number; end: number }[]): number {
  const sorted = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end >= i.start)
    .sort((a, b) => a.start - b.start);
  if (sorted.length < 2) return 0;
  const merged: { start: number; end: number }[] = [sorted[0]];
  for (const cur of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else merged.push({ ...cur });
  }
  let park = 0;
  for (let i = 1; i < merged.length; i += 1) {
    const gap = merged[i].start - merged[i - 1].end;
    if (gap > PARK_GAP_THRESHOLD_MS) park += gap;
  }
  return park;
}

interface PlannedUpdate {
  stepRowId: string;
  taskId: string;
  stepId: string;
  origEndedAt: string | null;
  origIdleMs: number;
  newEndedAt: string | null; // null => leave unchanged
  newIdleMs: number | null; // null => leave unchanged
  reasons: string[];
}

async function planForTask(taskId: string): Promise<PlannedUpdate[]> {
  const steps = await db.query.taskSteps.findMany({
    where: eq(schema.taskSteps.taskId, taskId),
  });
  const plans: PlannedUpdate[] = [];

  for (const s of steps) {
    const reasons: string[] = [];
    let newEndedAt: string | null = null;
    let newIdleMs: number | null = null;
    const curIdle = s.idleMs ?? 0;

    // A) ended_at recovery from the earliest step.done event.
    if (s.status === 'done' && s.endedAt) {
      const doneEvents = await db
        .select({ createdAt: schema.taskEvents.createdAt })
        .from(schema.taskEvents)
        .where(
          and(eq(schema.taskEvents.taskStepId, s.id), eq(schema.taskEvents.eventType, 'step.done')),
        );
      // Current-run lens: resetStepAndDownstream keeps task_events, so a reset+re-run step
      // carries stale step.done events from prior runs. Ignore any event before the step's
      // current started_at; the real completion is the earliest step.done AT/AFTER it.
      const startedMs = s.startedAt ? s.startedAt.getTime() : 0;
      const earliest = doneEvents
        .map((e) => new Date(e.createdAt).getTime())
        .filter((t) => Number.isFinite(t) && t >= startedMs)
        .sort((a, b) => a - b)[0];
      // Only correct a genuine re-stamp: ended_at more than a second past the real completion.
      if (earliest != null && s.endedAt.getTime() - earliest > 1000) {
        newEndedAt = new Date(earliest).toISOString();
        reasons.push(
          `ended_at ${s.endedAt.toISOString()} -> ${newEndedAt} (earliest step.done; span ${hrs(
            s.endedAt.getTime() - (s.startedAt?.getTime() ?? earliest),
          )} -> ${hrs(earliest - (s.startedAt?.getTime() ?? earliest))})`,
        );
      }
    }

    // B) park recovery from the invocation timeline. Skip steps with no current run (pending/
    // reset -> null started_at). Only count invocations at/after the step's current started_at,
    // so superseded invocations from a prior (reset) run don't fabricate a park.
    if (s.startedAt) {
      const stepStartedMs = s.startedAt.getTime();
      const invs = await db
        .select({
          startedAt: schema.cliInvocations.startedAt,
          endedAt: schema.cliInvocations.endedAt,
        })
        .from(schema.cliInvocations)
        .where(
          and(
            eq(schema.cliInvocations.taskStepId, s.id),
            isNotNull(schema.cliInvocations.startedAt),
          ),
        );
      const intervals = invs
        .map((i) => ({
          start: new Date(i.startedAt as Date).getTime(),
          end: i.endedAt ? new Date(i.endedAt).getTime() : NOW,
        }))
        .filter((i) => i.start >= stepStartedMs);
      const park = parkedMs(intervals);
      if (park > curIdle) {
        newIdleMs = park;
        reasons.push(`idle_ms ${hrs(curIdle)} -> ${hrs(park)} (parked between invocation waves)`);
      }
    }

    if (reasons.length) {
      plans.push({
        stepRowId: s.id,
        taskId,
        stepId: s.stepId,
        origEndedAt: s.endedAt ? s.endedAt.toISOString() : null,
        origIdleMs: curIdle,
        newEndedAt,
        newIdleMs,
        reasons,
      });
    }
  }
  return plans;
}

function hrs(ms: number): string {
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

async function main(): Promise<void> {
  const allPlans: PlannedUpdate[] = [];
  for (const taskId of TASK_IDS) {
    const plans = await planForTask(taskId);
    console.log(`\n=== task ${taskId}: ${plans.length} step(s) to correct ===`);
    for (const p of plans) {
      console.log(`  [${p.stepId}] ${p.reasons.join('; ')}`);
    }
    allPlans.push(...plans);
  }

  if (!allPlans.length) {
    console.log('\nNothing to correct (already clean).');
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — ${allPlans.length} step(s) would change. Set APPLY=1 to write.`);
    process.exit(0);
  }

  writeFileSync(
    BACKUP_PATH,
    JSON.stringify(
      allPlans.map((p) => ({
        id: p.stepRowId,
        endedAt: p.origEndedAt,
        idleMs: p.origIdleMs,
      })),
      null,
      2,
    ),
  );
  console.log(`\nWrote backup of ${allPlans.length} row(s) to ${BACKUP_PATH}`);

  await db.transaction(async (tx) => {
    for (const p of allPlans) {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (p.newEndedAt) patch.endedAt = new Date(p.newEndedAt);
      if (p.newIdleMs != null) patch.idleMs = p.newIdleMs;
      await tx.update(schema.taskSteps).set(patch).where(eq(schema.taskSteps.id, p.stepRowId));
    }
  });
  console.log(`Applied ${allPlans.length} correction(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
