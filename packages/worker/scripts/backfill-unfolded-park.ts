/**
 * One-off, idempotent maintenance script.
 *
 * Repairs the fourth task-timing corruption (sibling of backfill-task-timing.ts's A/B and
 * backfill-phantom-carried-work.ts's C): a step closed while it still held a LIVE park marker.
 *
 * A parked step records its wait in `waiting_started_at`, and `computeStepContribution`
 * (@haive/shared) counts that open wait as idle ONLY while `ended_at` is null. So the moment a
 * cancel/stop stamped `ended_at` without folding the marker, the entire recorded park span
 * silently reclassified from idle back into WORK. Measured before this ran: 269.62h across 6
 * steps, e.g. task 2d3bf31c's 08c-code-review showing 153.29h of "work" for a 149.86h park.
 *
 * The forward fix folds the marker into `idle_ms` in the SAME UPDATE that stamps `ended_at`
 * (api/lib/cancel-task.ts, api/routes/tasks/index.ts stop path, worker task-queue.ts cancel
 * mirror), plus foldOrphanedCliParkOnBoot for the worker-restart case. This script repairs the
 * rows already written.
 *
 * Correction: credit = park window MINUS any invocation runtime overlapping that window.
 * The overlap term is 0 on every affected row today (nothing ran during those windows), but it
 * keeps the repair fail-safe if a fold were ever lost while real work actually ran. Overlap is
 * summed in JS deliberately: Postgres LEAST/GREATEST IGNORE NULLs, so the obvious SQL form
 * silently degrades a non-matching row to the FULL window instead of 0 — a plausible-but-wrong
 * result that reports overlap for steps with zero invocations.
 *
 * PARK_MIN_HOURS (default 6) is a correctness guard, not a performance knob. A step re-entered
 * from `waiting_cli` keeps that status through its whole apply phase (step-runner.ts only flips
 * pending -> running), so a marker legitimately stays set while real apply work runs, and that
 * span SHOULD bill as work. Those windows are sub-minute here (777 rows totalling 0.04h) and
 * every genuine phantom is >6h, so the threshold cleanly separates them. Lowering it risks
 * moving real apply work into idle.
 *
 * Deliberately NOT reusing backfill-phantom-carried-work.ts's "sum of invocation runtimes"
 * ceiling: that is wrong for parallel fan-out. Task bfad7af9's 06c-dag-execute sums 5.02h of
 * invocations inside a 1.22h wall window because DAG agents run concurrently. The park window
 * is wall-clock and stays correct there.
 *
 * Idempotent: the run clears `waiting_started_at`, which removes the row from the selection, so
 * a re-run finds nothing. Clearing is confined to rows that already have `ended_at` set, so it
 * cannot disturb the live-gate lookup in api/routes/tasks/index.ts (`steps.find(s =>
 * s.waitingStartedAt)`) — on a closed row that marker is a false positive anyway.
 *
 * Safety:
 *  - Dry-run by default. Set APPLY=1 to write.
 *  - On apply it first writes every targeted row's original (id, idleMs, waitingStartedAt) to
 *    backfill-unfolded-park-backup.json, then updates inside a single transaction.
 *  - idle_ms is int4; the credit is clamped to the column's headroom so a long park cannot
 *    raise "integer out of range" mid-transaction.
 *
 * Run (inside the worker container):
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && ./node_modules/.bin/tsx scripts/backfill-unfolded-park.ts'         # dry run
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && APPLY=1 ./node_modules/.bin/tsx scripts/backfill-unfolded-park.ts' # apply
 *
 * Rollback: replay backfill-unfolded-park-backup.json (UPDATE task_steps SET idle_ms=<orig>,
 * waiting_started_at=<orig> WHERE id=<id>).
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
const BACKUP_PATH = '/app/packages/worker/scripts/backfill-unfolded-park-backup.json';

const overrideIds = (process.env.TASK_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// See the header: separates a genuine dead park from an apply phase that legitimately runs with
// the marker still set. Every real phantom measured is >6h; every apply window is sub-minute.
const PARK_MIN_MS = Number(process.env.PARK_MIN_HOURS ?? 6) * 3_600_000;
// idle_ms is `integer` in the schema — 2^31-1 ms is ~24.8 days.
const INT4_MAX = 2_147_483_647;

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
  origIdleMs: number;
  origWaitingStartedAt: string;
  windowMs: number;
  overlapMs: number;
  creditMs: number;
  newIdleMs: number;
}

async function plan(): Promise<PlannedUpdate[]> {
  const steps = await db.query.taskSteps.findMany({
    where: and(isNotNull(schema.taskSteps.waitingStartedAt), isNotNull(schema.taskSteps.endedAt)),
    with: { task: { columns: { status: true } } },
  });

  const plans: PlannedUpdate[] = [];
  for (const s of steps) {
    if (overrideIds.length && !overrideIds.includes(s.taskId)) continue;
    const w0 = new Date(s.waitingStartedAt as Date).getTime();
    const w1 = new Date(s.endedAt as Date).getTime();
    const windowMs = w1 - w0;
    if (!Number.isFinite(windowMs) || windowMs <= PARK_MIN_MS) continue;

    // Any invocation runtime that actually overlaps [w0, w1] is real work, not park. Summed in
    // JS so a step with no invocations yields a true 0 (see the LEAST/GREATEST note above).
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
    let overlapMs = 0;
    for (const i of invs) {
      const endRaw = i.endedAt ?? i.supersededAt;
      if (!endRaw) continue;
      const start = new Date(i.startedAt as Date).getTime();
      const end = new Date(endRaw).getTime();
      const ov = Math.min(end, w1) - Math.max(start, w0);
      if (Number.isFinite(ov) && ov > 0) overlapMs += ov;
    }

    const creditMs = Math.max(0, windowMs - overlapMs);
    if (creditMs <= 0) continue;
    const origIdleMs = s.idleMs ?? 0;
    const newIdleMs = Math.min(INT4_MAX, origIdleMs + creditMs);
    plans.push({
      stepRowId: s.id,
      taskId: s.taskId,
      taskStatus: s.task?.status ?? '?',
      stepId: s.stepId,
      stepStatus: s.status,
      origIdleMs,
      origWaitingStartedAt: new Date(w0).toISOString(),
      windowMs,
      overlapMs,
      creditMs,
      newIdleMs,
    });
  }
  return plans.sort((a, b) => b.creditMs - a.creditMs);
}

async function main(): Promise<void> {
  const plans = await plan();
  console.log(`\n=== ${plans.length} step(s) with an unfolded park window ===`);
  let total = 0;
  for (const p of plans) {
    total += p.creditMs;
    console.log(
      `  task ${p.taskId.slice(0, 8)} (${p.taskStatus}) [${p.stepId} / ${p.stepStatus}]: ` +
        `park ${hrs(p.windowMs)} - overlap ${hrs(p.overlapMs)} => idle ${hrs(p.origIdleMs)} -> ${hrs(p.newIdleMs)}`,
    );
  }
  if (plans.length) console.log(`\n  total work reclassified as idle: ${hrs(total)}`);

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
        idleMs: p.origIdleMs,
        waitingStartedAt: p.origWaitingStartedAt,
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
        .set({ idleMs: p.newIdleMs, waitingStartedAt: null, updatedAt: new Date() })
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
