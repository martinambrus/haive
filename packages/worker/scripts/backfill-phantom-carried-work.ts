/**
 * One-off, idempotent maintenance script.
 *
 * Repairs the third task-timing corruption (sibling of backfill-task-timing.ts's A/B): a
 * step's carried_work_ms inflated by a bad reset FOLD. When a reset/revise/retry folds a step
 * that was still OPEN at fold time (ended_at null, e.g. left `running` after a worker restart
 * orphaned it), the old fold billed the whole start->now gap as work and added it to
 * carried_work_ms. For an orphaned step that gap is hours or days of DEAD time, so the task
 * reports absurd "work" (observed: task 38f02dee showed 157h of work, 149h of it one
 * never-completed step's orphan gap on 08c-code-review). The forward fix
 * (computeFoldContribution) reclassifies an open run's span as idle so new folds can't do
 * this; this script repairs the rows already written.
 *
 * Correction: the real work a step did is bounded by the time its CLI invocations actually
 * ran (an LLM/DAG step's work IS its CLI time; a deterministic step's is seconds). So for each
 * step we sum its invocation runtimes, CAP each invocation at PER_INV_CAP_MS (no invocation
 * runs past the ~2h ollama SIGKILL, and an orphaned invocation superseded days later must not
 * re-inflate the ceiling), and where carried_work_ms exceeds that real runtime by more than
 * EXCESS_THRESHOLD_MS we move the excess from carried_work_ms to carried_idle_ms (the orphan
 * gap was idle, not work — this also keeps work+idle reconciled with wall, matching how a
 * correctly-timed sibling task shows ~9h work / ~175h idle).
 *
 * Idempotent: after a run carried_work_ms == the (stable, invocation-derived) real runtime, so
 * excess <= 0 and a re-run changes nothing. The threshold leaves untouched any step whose
 * carried_work only mildly exceeds its CLI time (deterministic overhead, DAG orchestration).
 *
 * Scope: every task with the phantom signature, ALL statuses. Override with TASK_IDS
 * (comma-separated) to scope to specific tasks. Tune with EXCESS_HOURS / PER_INV_CAP_HOURS.
 *
 * Safety:
 *  - Dry-run by default. Set APPLY=1 to write.
 *  - On apply it first writes every targeted row's original (id, carriedWorkMs, carriedIdleMs)
 *    to backfill-phantom-carried-work-backup.json, then updates inside a single transaction.
 *
 * Run (inside the worker container):
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && tsx scripts/backfill-phantom-carried-work.ts'         # dry run
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && APPLY=1 tsx scripts/backfill-phantom-carried-work.ts' # apply
 *
 * Rollback: replay backfill-phantom-carried-work-backup.json (UPDATE task_steps SET
 * carried_work_ms=<orig>, carried_idle_ms=<orig> WHERE id=<id>).
 */
import { writeFileSync } from 'node:fs';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { createDatabase, schema } from '@haive/database';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const APPLY = process.env.APPLY === '1';
const BACKUP_PATH = '/app/packages/worker/scripts/backfill-phantom-carried-work-backup.json';

const overrideIds = (process.env.TASK_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// A single invocation cannot legitimately run past the ~2h ollama SIGKILL; cap each at 3h so
// an orphaned invocation superseded long after it started can't re-inflate the work ceiling.
const PER_INV_CAP_MS = Number(process.env.PER_INV_CAP_HOURS ?? 3) * 3_600_000;
// Only correct a clear phantom: carried_work exceeding the real CLI runtime by more than this
// is the orphan-fold signature. Leaves mild deterministic/orchestration overhead untouched.
const EXCESS_THRESHOLD_MS = Number(process.env.EXCESS_HOURS ?? 1) * 3_600_000;

const db = createDatabase(DATABASE_URL);

function hrs(ms: number): string {
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

interface PlannedUpdate {
  stepRowId: string;
  taskId: string;
  taskStatus: string;
  stepId: string;
  stepStatus: string;
  origCarriedWorkMs: number;
  origCarriedIdleMs: number;
  realWorkMs: number;
  excessMs: number;
}

async function plan(): Promise<PlannedUpdate[]> {
  // Candidates: any step carrying work at all. The real filter is the excess check below.
  const steps = await db.query.taskSteps.findMany({
    where: gt(schema.taskSteps.carriedWorkMs, 0),
    with: { task: { columns: { status: true } } },
  });

  const plans: PlannedUpdate[] = [];
  for (const s of steps) {
    if (overrideIds.length && !overrideIds.includes(s.taskId)) continue;
    const invs = await db
      .select({
        startedAt: schema.cliInvocations.startedAt,
        endedAt: schema.cliInvocations.endedAt,
        supersededAt: schema.cliInvocations.supersededAt,
      })
      .from(schema.cliInvocations)
      .where(
        and(eq(schema.cliInvocations.taskStepId, s.id), isNotNull(schema.cliInvocations.startedAt)),
      );
    // Real work = sum of each invocation's runtime, capped. A live invocation (no end, not
    // superseded) contributes 0 — carried_work is about prior runs, not the current one.
    let realWorkMs = 0;
    for (const i of invs) {
      const start = new Date(i.startedAt as Date).getTime();
      const endRaw = i.endedAt ?? i.supersededAt;
      if (!endRaw) continue;
      const dur = new Date(endRaw).getTime() - start;
      if (Number.isFinite(dur) && dur > 0) realWorkMs += Math.min(dur, PER_INV_CAP_MS);
    }
    const carried = s.carriedWorkMs ?? 0;
    const excess = carried - realWorkMs;
    if (excess > EXCESS_THRESHOLD_MS) {
      plans.push({
        stepRowId: s.id,
        taskId: s.taskId,
        taskStatus: s.task?.status ?? '?',
        stepId: s.stepId,
        stepStatus: s.status,
        origCarriedWorkMs: carried,
        origCarriedIdleMs: s.carriedIdleMs ?? 0,
        realWorkMs,
        excessMs: excess,
      });
    }
  }
  return plans.sort((a, b) => b.excessMs - a.excessMs);
}

async function main(): Promise<void> {
  const plans = await plan();
  console.log(`\n=== ${plans.length} step(s) with phantom carried_work ===`);
  for (const p of plans) {
    console.log(
      `  task ${p.taskId.slice(0, 8)} (${p.taskStatus}) [${p.stepId} / ${p.stepStatus}]: ` +
        `carried_work ${hrs(p.origCarriedWorkMs)} -> ${hrs(p.realWorkMs)} ` +
        `(move ${hrs(p.excessMs)} to idle)`,
    );
  }

  if (!plans.length) {
    console.log('\nNothing to correct (already clean).');
    process.exit(0);
  }
  if (!APPLY) {
    console.log(`\nDRY RUN — ${plans.length} step(s) would change. Set APPLY=1 to write.`);
    process.exit(0);
  }

  writeFileSync(
    BACKUP_PATH,
    JSON.stringify(
      plans.map((p) => ({
        id: p.stepRowId,
        carriedWorkMs: p.origCarriedWorkMs,
        carriedIdleMs: p.origCarriedIdleMs,
      })),
      null,
      2,
    ),
  );
  console.log(`\nWrote backup of ${plans.length} row(s) to ${BACKUP_PATH}`);

  await db.transaction(async (tx) => {
    for (const p of plans) {
      await tx
        .update(schema.taskSteps)
        .set({
          carriedWorkMs: p.realWorkMs,
          carriedIdleMs: p.origCarriedIdleMs + p.excessMs,
          updatedAt: new Date(),
        })
        .where(eq(schema.taskSteps.id, p.stepRowId));
    }
  });
  console.log(`Applied ${plans.length} correction(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
