import { sql } from 'drizzle-orm';
import * as schema from './schema/index.js';

/** Credit the time a CLOSED step spent closed to `idle_ms`, for the actions that RE-OPEN one.
 *
 *  The re-open shape — resume, retry_ai (api) and the allowance auto-resume (worker) — nulls
 *  `ended_at` but deliberately keeps `started_at`: the step continues its existing run rather
 *  than starting a fresh one. That extends its span backwards across the period between the
 *  close and the re-open, and `computeStepContribution` bills a step's span minus its idle as
 *  WORK, so without this the whole gap silently becomes agent work. Observed twice: a step
 *  Stopped 2026-08-14 12:06 and resumed 2026-08-16 18:25 reported 55.27h of work for 57min of
 *  real CLI runtime, and 03-phase-0a-discovery on task eb9e73be carried 28.33h after a
 *  rate-limit auto-resume spanning 27h20m in which nothing ran.
 *
 *  `ended_at` is the anchor because the closing path itself wrote it — stopActiveCliInvocations
 *  (api routes/tasks/index.ts) stamps it while folding any live park marker, so this is the
 *  exact mirror of that fold on the way back in. Applied in the SAME update that clears
 *  `ended_at`: split across two statements there is a window where the anchor is already gone,
 *  which is the same reason cancelTaskRow folds in one statement.
 *
 *  `greatest(0, NULL)` is 0 in Postgres, so re-opening a step that is still LIVE (`ended_at`
 *  null) credits nothing and needs no extra guard. The int4 clamp is load-bearing rather than
 *  hardening: `idle_ms` is `integer` (~24.8 days), and a task resumed a month after being
 *  stopped would otherwise raise "integer out of range" and abort the re-open outright.
 *
 *  NOT for the reset-style actions (retry, switch-cli, the worker's resetStepAndDownstream):
 *  those null `started_at` too and fold the finishing run into `carried_*` via
 *  computeFoldContribution, so they have no span to extend and adding this would double-count.
 *
 *  Lives here rather than beside either caller because api and worker each own re-open sites
 *  and neither may import the other — the same reason `resetDagCurrentLevelForRetry` does. */
export const CLOSED_GAP_INTO_IDLE_MS = sql`${schema.taskSteps.idleMs} + least(2147483647 - ${schema.taskSteps.idleMs},
  greatest(0, floor(extract(epoch from (now() - ${schema.taskSteps.endedAt})) * 1000)))::int`;
