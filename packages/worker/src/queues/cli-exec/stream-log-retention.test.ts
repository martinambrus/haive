import { afterEach, describe, it, expect, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService } from '@haive/shared';
import {
  CliStreamLogReaper,
  expiredDispatchPromptFilter,
  expiredPromptFilter,
  expiredStreamLogFilter,
} from './stream-log-retention.js';

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

/** The prompt sweep's statement, same treatment. */
function renderPrompt(): { sql: string; params: unknown[] } {
  const q = db
    .update(schema.cliInvocations)
    .set({ prompt: '' })
    .where(expiredPromptFilter(db, CUTOFF))
    .toSQL();
  return { sql: q.sql, params: q.params };
}

/** The mining dispatch-prompt sweep's statement, same treatment. */
function renderDispatchPrompt(): { sql: string; params: unknown[] } {
  const q = db
    .update(schema.taskStepAgentMinings)
    .set({ dispatchPrompt: null })
    .where(expiredDispatchPromptFilter(db, CUTOFF))
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
    // drizzle serializes the Date to the driver's ISO form; the same value must bound every
    // clock: the invocation's (ended, or else superseded) and the task's.
    expect(params.filter((p) => p === CUTOFF.toISOString())).toHaveLength(3);
  });

  it('ages an invocation from when it was finalized: ended, or else superseded', () => {
    // A step retry supersedes a queued or running invocation without ending it, so keyed on
    // ended_at alone such a row never aged. One carrying neither timestamp has no clock, and
    // admitting every never-ended row would sweep it anyway.
    expect(render().sql.replace(/\$\d+/g, '$')).toContain(
      '("cli_invocations"."ended_at" < $ or ("cli_invocations"."ended_at" is null and "cli_invocations"."superseded_at" < $))',
    );
  });

  it('leaves an already-swept row alone', () => {
    // Without this a repeat sweep rewrites every row it previously cleared.
    expect(render().sql).toContain('"stream_log" is not null');
  });
});

describe('expiredPromptFilter', () => {
  it('never renders an unconstrained update', () => {
    // Same failure this module cannot come back from, one column over: an undefined filter
    // reaches .where() as "no filter" and blanks EVERY prompt in one pass.
    expect(expiredPromptFilter(db, CUTOFF)).toBeDefined();
    expect(renderPrompt().sql).toContain('where');
  });

  it('guards on <> rather than IS NOT NULL, because prompt is NOT NULL', () => {
    // The self-narrowing guard the stream-log sweep gets from `is not null`. Without it
    // every already-blanked row is rewritten on every hourly tick.
    const { sql, params } = renderPrompt();
    expect(sql).toContain('"prompt" <> ');
    expect(params).toContain('');
    expect(sql).not.toContain('"prompt" is not null');
  });

  it('reuses the same task-exit gate as the transcript sweep', () => {
    // The two filters must not drift: a prompt evicted from a still-running task would
    // break the very retry path this column exists for.
    const { sql, params } = renderPrompt();
    expect(sql).toContain('"cli_invocations"."task_id" in (select');
    expect(sql).toContain('"tasks"."completed_at" is not null');
    expect(sql).toContain('"cli_invocations"."superseded_at" < ');
    expect(sql).toContain('"tasks"."completed_at" < ');
    expect(params.filter((p) => p === CUTOFF.toISOString())).toHaveLength(3);
    for (const status of ['completed', 'failed', 'cancelled']) expect(params).toContain(status);
  });

  it('never touches raw_output', () => {
    // clean-output.ts reasons that emptying raw_output loses nothing BECAUSE stream_log
    // survives; evicting it here too would empty the Raw tab outright.
    expect(renderPrompt().sql).not.toContain('raw_output');
    expect(render().sql).not.toContain('raw_output');
  });
});

describe('expiredDispatchPromptFilter', () => {
  it('never renders an unconstrained update', () => {
    // An undefined filter would reach .where() as "no filter" and null every mining row's
    // dispatch prompt in one pass.
    expect(expiredDispatchPromptFilter(db, CUTOFF)).toBeDefined();
    expect(renderDispatchPrompt().sql).toContain('where');
  });

  it('reaches a mining row only through a step of an exited task', () => {
    // The same task-exit gate as the invocation sweeps: a revived or still-running task keeps
    // the prompts its wave-agent retries recover from.
    const { sql, params } = renderDispatchPrompt();
    expect(sql).toContain('"task_step_agent_minings"."task_step_id" in (select');
    expect(sql).toContain('from "task_steps" where "task_steps"."task_id" in (select');
    expect(sql).toContain('"tasks"."completed_at" is not null');
    expect(sql).toContain('"tasks"."completed_at" < ');
    for (const status of ['completed', 'failed', 'cancelled']) expect(params).toContain(status);
  });

  it('never goes before the invocation prompt its recovery falls back to', () => {
    // An invocation can finish after its task exited (measured up to +57m). Gated on the task
    // alone, the dispatch prompt went first, and a task revived in between replayed the sent
    // prompt verbatim — the behaviour the column exists to end. A row that never reached a CLI
    // has only this prompt, so the task gate alone decides it.
    const { sql, params } = renderDispatchPrompt();
    expect(sql.replace(/\$\d+/g, '$')).toContain(
      '("task_step_agent_minings"."cli_invocation_id" is null or "task_step_agent_minings"."cli_invocation_id" in (select "id" from "cli_invocations" where ("cli_invocations"."ended_at" < $ or ("cli_invocations"."ended_at" is null and "cli_invocations"."superseded_at" < $))))',
    );
    // One cutoff bounds all three clocks: the task's, and the invocation's ended or superseded.
    expect(params.filter((p) => p === CUTOFF.toISOString())).toHaveLength(3);
  });

  it('leaves an already-swept row alone, and writes only the mining row', () => {
    const { sql } = renderDispatchPrompt();
    expect(sql).toContain('"dispatch_prompt" is not null');
    expect(sql).toMatch(/^update "task_step_agent_minings" set "dispatch_prompt" = /);
  });
});

describe('the prompt sweeps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every Date bound in a drizzle condition tree. */
  function datesIn(node: unknown, acc: Date[] = []): Date[] {
    if (!node || typeof node !== 'object') return acc;
    if (node instanceof Date) {
      acc.push(node);
      return acc;
    }
    if (Array.isArray(node)) return node.reduce((a: Date[], n) => datesIn(n, a), acc);
    const obj = node as Record<string, unknown>;
    // A bound value may itself be a subquery (the mock's stand-in below).
    if ('value' in obj) datesIn(obj.value, acc);
    const chunks = obj.queryChunks;
    if (Array.isArray(chunks)) for (const c of chunks) datesIn(c, acc);
    return acc;
  }

  it('age both prompt forms on one clock, the invocation prompts first', async () => {
    // A dispatch prompt swept on a later clock, or before its invocation's prompt, would leave a
    // revived task a window in which only the sent prompt remains. The clock ticks a second per
    // read, so two separate reads would show up as two cutoffs.
    vi.spyOn(configService, 'getNumber').mockResolvedValue(30);
    let clock = Date.parse('2026-09-01T00:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
    const writes: { table: string; dates: Date[] }[] = [];
    const db = {
      update: (table: Parameters<typeof getTableName>[0]) => ({
        set: () => ({
          where: (cond: unknown) => ({
            returning: async () => {
              writes.push({ table: getTableName(table), dates: datesIn(cond) });
              return [];
            },
          }),
        }),
      }),
      // Subqueries keep their condition, so the cutoffs nested in them are counted too.
      select: () => ({ from: () => ({ where: (cond: unknown) => ({ queryChunks: [cond] }) }) }),
    } as unknown as Database;
    await new CliStreamLogReaper({ db }).sweep();

    const [, invocationPrompts, dispatchPrompts] = writes;
    expect(invocationPrompts?.table).toBe('cli_invocations');
    expect(dispatchPrompts?.table).toBe('task_step_agent_minings');
    expect(dispatchPrompts!.dates.length).toBeGreaterThan(0);
    const cutoffs = new Set([...invocationPrompts!.dates, ...dispatchPrompts!.dates].map(Number));
    expect(cutoffs.size).toBe(1);
  });
});
