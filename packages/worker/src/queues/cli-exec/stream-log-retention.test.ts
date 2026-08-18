import { describe, it, expect } from 'vitest';
import { createDatabase, schema } from '@haive/database';
import { expiredStreamLogFilter } from './stream-log-retention.js';

// postgres.js opens no socket until a query runs, so a bogus URL is enough to render SQL.
const db = createDatabase('postgres://u:p@127.0.0.1:1/none');

const CUTOFF = new Date('2026-08-01T00:00:00.000Z');

/** The statement the sweep actually issues, rendered rather than executed. */
function render(): { sql: string; params: unknown[] } {
  const q = db
    .update(schema.cliInvocations)
    .set({ streamLog: null })
    .where(expiredStreamLogFilter(db, CUTOFF))
    .toSQL();
  return { sql: q.sql, params: q.params };
}

describe('expiredStreamLogFilter', () => {
  it('never renders an unconstrained update', () => {
    // and() returning undefined would reach .where() as "no filter" and null EVERY
    // transcript in one pass — the one failure mode this module cannot come back from.
    expect(expiredStreamLogFilter(db, CUTOFF)).toBeDefined();
    expect(render().sql).toContain('where');
  });

  it('restricts the sweep to invocations belonging to an exited task', () => {
    // The regression this gate exists for: without it a task parked on a form, a PR wait
    // or a rate-limit hold loses its round-1 transcripts while it is still running.
    const { sql } = render();
    expect(sql).toContain('"cli_invocations"."task_id" in (select');
    expect(sql).toContain('from "tasks"');
    expect(sql).toContain('"tasks"."completed_at" is not null');
  });

  it('treats completed, failed and cancelled as exited', () => {
    // failed is included deliberately: a retry clears completed_at, so a revived task
    // drops back out of the sweep without needing to be excluded here.
    const { params } = render();
    expect(params).toContain('completed');
    expect(params).toContain('failed');
    expect(params).toContain('cancelled');
  });

  it('measures BOTH the invocation clock and the task clock against the cutoff', () => {
    // Neither is redundant: ended_at keeps a live invocation out of reach (and invocations
    // do finish after their task is stamped terminal — measured up to +57m past it), while
    // completed_at is what makes the window mean "since the work finished".
    const { sql, params } = render();
    expect(sql).toContain('"cli_invocations"."ended_at" < ');
    expect(sql).toContain('"tasks"."completed_at" < ');
    // drizzle serializes the Date to the driver's ISO form; the same value must bound both.
    expect(params.filter((p) => p === CUTOFF.toISOString())).toHaveLength(2);
  });

  it('leaves an already-swept row alone', () => {
    // Without this a repeat sweep rewrites every row it previously cleared.
    expect(render().sql).toContain('"stream_log" is not null');
  });
});
