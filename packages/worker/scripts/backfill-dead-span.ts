/**
 * One-off, idempotent maintenance script.
 *
 * Repairs the fifth task-timing corruption, the one neither sibling script covers:
 * a step whose span contains a long stretch where NOTHING ran and no park marker recorded it.
 *
 *  - backfill-task-timing.ts (B) recovers parks BETWEEN invocation waves. Its `parkedMs` only
 *    sums gaps between merged intervals, so a dead stretch AFTER the last invocation — which is
 *    where a stalled step actually sits — contributes 0.
 *  - backfill-unfolded-park.ts repairs a step closed while still holding a LIVE marker. It keys
 *    on `waiting_started_at IS NOT NULL`, so a step that never got a marker is invisible to it.
 *
 * The uncovered shape is `foldOrphanedCliParkOnBoot`'s case (a): the CLI invocations all died
 * (timeout / SIGKILL / supersede) while the step was in waiting_cli, so the "marker is set iff
 * nothing is running" invariant was never re-established. computeStepContribution then bills
 * start -> ended as work with nothing subtracted. Measured: task dd682d32's 08c-code-review
 * round 0 reported 55.27h of "work" for 57min of real CLI runtime — its invocations ended
 * 2026-08-14 12:06 and the step sat in waiting_cli until a manual Resume on 2026-08-16 18:25
 * (task_events: step.waiting_cli, then nothing, then step.resume).
 *
 * Correction: idle = span - UNION of the step's invocation active intervals.
 *
 * UNION (wall), never the SUM of runtimes: mining/DAG fan-out runs N invocations concurrently,
 * so summing them over-credits work and can exceed the span outright. This is the same objection
 * backfill-unfolded-park.ts raised against backfill-phantom-carried-work.ts's ceiling.
 *
 * Applied with GREATEST so idle_ms never decreases — the run is monotone and converges after one
 * pass, which is what makes it idempotent. Note this is deliberately NOT "add the gap to the
 * existing idle": a step can hold BOTH an already-folded park and a dead stretch, and adding
 * would double-count the first. Computing the dead total from the invocation timeline and
 * lifting to it subsumes both (verified on 11-final-review, which holds a folded 20.6min queue
 * wait AND a 23min stall, and whose correct idle is the 43.6min the formula yields).
 *
 * LIFT_MIN_MS (default 60s) is a correctness guard, not a performance knob. The formula treats
 * every non-CLI second as idle, including a step's DETERMINISTIC apply work (RAG embedding,
 * writing KB files). That work is real and must stay billed as work. Every genuine stall here is
 * minutes-to-days while every apply tail measured on the target tasks is seconds, so requiring a
 * minute of lift cleanly separates them. Lowering it moves real apply work into idle.
 *
 * Steps with NO invocation at/after `started_at` are skipped outright: a purely deterministic
 * step has no CLI timeline, so `span - union` would be its entire span and the formula would
 * zero out work that genuinely happened.
 *
 * Scope: the two known-corrupted tasks by default; override with TASK_IDS (comma-separated).
 *
 * Safety:
 *  - Dry-run by default. Set APPLY=1 to write.
 *  - On apply it first writes every targeted row's original (id, idleMs) to
 *    backfill-dead-span-backup.json, then updates inside a single transaction.
 *  - idle_ms is int4; the new value is clamped to the column's headroom so a multi-week stall
 *    cannot raise "integer out of range" mid-transaction.
 *
 * Run (inside the worker container):
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && ./node_modules/.bin/tsx scripts/backfill-dead-span.ts'         # dry run
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && APPLY=1 ./node_modules/.bin/tsx scripts/backfill-dead-span.ts' # apply
 *
 * Rollback: replay backfill-dead-span-backup.json (UPDATE task_steps SET idle_ms=<orig>
 * WHERE id=<id>).
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
const BACKUP_PATH = '/app/packages/worker/scripts/backfill-dead-span-backup.json';

const DEFAULT_TASK_IDS = [
  'dd682d32-fe60-4855-9cc6-5b3c088c5c14',
  '7f65dbe6-b88d-432e-aedd-5cefb2214a41',
];
const overrideIds = (process.env.TASK_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TASK_IDS = overrideIds.length ? overrideIds : DEFAULT_TASK_IDS;

// See the header: separates a genuine stall from the seconds of deterministic apply that follow
// a step's last invocation.
const LIFT_MIN_MS = Number(process.env.LIFT_MIN_SECONDS ?? 60) * 1000;
// idle_ms is `integer` in the schema — 2^31-1 ms is ~24.8 days.
const INT4_MAX = 2_147_483_647;

const db = createDatabase(DATABASE_URL);

function hrs(ms: number): string {
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

/** Wall time covered by at least one interval. Merges overlaps, so concurrent fan-out agents
 *  count once rather than N times. */
function unionMs(intervals: { start: number; end: number }[]): number {
  const sorted = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end >= i.start)
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) return 0;
  const merged: { start: number; end: number }[] = [{ ...sorted[0]! }];
  for (const cur of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else merged.push({ ...cur });
  }
  return merged.reduce((acc, i) => acc + (i.end - i.start), 0);
}

interface PlannedUpdate {
  stepRowId: string;
  taskId: string;
  stepId: string;
  round: number;
  stepStatus: string;
  spanMs: number;
  activeMs: number;
  deadMs: number;
  origIdleMs: number;
  newIdleMs: number;
}

async function planForTask(taskId: string): Promise<PlannedUpdate[]> {
  const steps = await db.query.taskSteps.findMany({
    where: eq(schema.taskSteps.taskId, taskId),
  });
  const plans: PlannedUpdate[] = [];

  for (const s of steps) {
    if (!s.startedAt || !s.endedAt) continue;
    const startMs = new Date(s.startedAt).getTime();
    const endMs = new Date(s.endedAt).getTime();
    const spanMs = endMs - startMs;
    if (!Number.isFinite(spanMs) || spanMs <= 0) continue;

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

    // Only this run's invocations: a reset step keeps rows from prior runs, and counting those
    // would credit work that happened before `started_at`. Clamped to the span so an invocation
    // that outlived the step cannot make active exceed it.
    const intervals = invs
      .map((i) => {
        const iStart = new Date(i.startedAt as Date).getTime();
        const rawEnd = i.endedAt ?? i.supersededAt;
        const iEnd = rawEnd ? new Date(rawEnd).getTime() : endMs;
        return { start: Math.max(iStart, startMs), end: Math.min(iEnd, endMs) };
      })
      .filter((i) => i.end > i.start);
    // No CLI timeline => the whole span is deterministic work. Never touch it.
    if (!intervals.length) continue;

    const activeMs = unionMs(intervals);
    const deadMs = Math.max(0, spanMs - activeMs);
    const origIdleMs = s.idleMs ?? 0;
    if (deadMs - origIdleMs <= LIFT_MIN_MS) continue;

    plans.push({
      stepRowId: s.id,
      taskId,
      stepId: s.stepId,
      round: s.round,
      stepStatus: s.status,
      spanMs,
      activeMs,
      deadMs,
      origIdleMs,
      newIdleMs: Math.min(INT4_MAX, deadMs),
    });
  }
  return plans;
}

async function main(): Promise<void> {
  const allPlans: PlannedUpdate[] = [];
  for (const taskId of TASK_IDS) {
    const plans = await planForTask(taskId);
    console.log(`\n=== task ${taskId}: ${plans.length} step(s) to correct ===`);
    for (const p of plans) {
      console.log(
        `  [${p.stepId} r${p.round} / ${p.stepStatus}] span ${hrs(p.spanMs)}, ` +
          `cli active ${hrs(p.activeMs)} => idle ${hrs(p.origIdleMs)} -> ${hrs(p.newIdleMs)} ` +
          `(work ${hrs(p.spanMs - p.origIdleMs)} -> ${hrs(p.spanMs - p.newIdleMs)})`,
      );
    }
    allPlans.push(...plans);
  }

  if (!allPlans.length) {
    console.log('\nNothing to correct (already clean).');
    process.exit(0);
  }
  const reclaimed = allPlans.reduce((acc, p) => acc + (p.newIdleMs - p.origIdleMs), 0);
  console.log(`\n  total work reclassified as idle: ${hrs(reclaimed)}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — ${allPlans.length} step(s) would change. Set APPLY=1 to write.`);
    process.exit(0);
  }

  writeFileSync(
    BACKUP_PATH,
    JSON.stringify(
      allPlans.map((p) => ({ id: p.stepRowId, idleMs: p.origIdleMs })),
      null,
      2,
    ),
  );
  console.log(`\nWrote backup of ${allPlans.length} row(s) to ${BACKUP_PATH}`);

  await db.transaction(async (tx) => {
    for (const p of allPlans) {
      await tx
        .update(schema.taskSteps)
        .set({ idleMs: p.newIdleMs, updatedAt: new Date() })
        .where(eq(schema.taskSteps.id, p.stepRowId));
    }
  });
  console.log(`Applied ${allPlans.length} correction(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
