import { sql } from 'drizzle-orm';
import * as schema from './schema/index.js';

/** Credit the wait a step spent parked on its form (`waiting_started_at`) to `idle_ms`, for the writers
 *  that close it: the form submit, the merge clarification answer, Skip (api) and the PR poller's
 *  auto-finalize (worker). Applied in the SAME update that clears the marker, and read from the row that
 *  update locks: a value computed in the caller from a read made before its transaction is written over
 *  an `idle_ms` write that landed since.
 *
 *  `greatest(0, NULL)` is 0, so a row whose wait is already closed adds nothing. The int4 clamp is
 *  load-bearing: `idle_ms` is `integer` (~24.8 days), and an overflow would fail the answer outright.
 *
 *  Lives here because api and worker each own a closing site and neither may import the other. */
export const OPEN_WAIT_INTO_IDLE_MS = sql`${schema.taskSteps.idleMs} + least(2147483647 - ${schema.taskSteps.idleMs},
  greatest(0, floor(extract(epoch from (now() - ${schema.taskSteps.waitingStartedAt})) * 1000)))::int`;
