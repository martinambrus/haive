import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

/**
 * Seeding CLI invocations with KNOWN money and time, so an aggregate can be asserted exactly.
 *
 * The arithmetic in `@haive/shared/stats` has unit tests. What has none, and what only a live
 * stack can exercise, is everything between a row and a rendered figure: the SQL that decides
 * which rows count, the join that scopes them to a user, the cost rule's reading of the `cost`
 * jsonb, and the component that picks a field out of the response. A wrong join there shows
 * somebody the wrong money and no unit test would notice.
 *
 * `cost` is written as the product writes it. `realCostRowSql` reads `billable` and `costUsd`
 * from that blob and ignores `token_usage.costUsd` whenever the blob is present — the reported
 * figure is only trusted for a provider that prices its own backend — so a fixture that set only
 * the token figure would sum to zero and look like a broken test rather than a correct rule.
 *
 * A row must also be ATTRIBUTED TO A STEP. Every invocation rollup in the codebase carries
 * `invocationAttributionFilter`: not superseded, and a non-null `task_step_id` or
 * `summary_for_step_id`. A row belonging to no step predates the summary-attribution column and
 * is deliberately kept out of both sides of every total, so an unattributed fixture is invisible
 * — measured, before this took a step id: two seeded runs, and the summary reported zero of
 * everything.
 *
 * And it needs a PROVIDER. Spend is read straight off the `cost` blob, but tokens are aggregated
 * through a per-provider breakdown — codex and gemini report input inclusive of the cached prefix,
 * so the totals are normalised per provider before being summed rather than added raw. A row with
 * no provider contributes no tokens at all: measured, 30,000 seeded and 0 reported, while the
 * money for those same rows came through correctly.
 */

export interface SeededInvocation {
  /** Wall time this invocation occupied, which is what agent-hours is summed from. */
  durationMs: number;
  /** Written to `cost.costUsd` with `billable: true`, so it lands in REAL spend. */
  costUsd: number;
  totalTokens: number;
}

export interface SpendFixture {
  invocationIds: string[];
  totalCostUsd: number;
  totalTokens: number;
  totalMs: number;
}

/**
 * Insert invocations against an existing task, finishing `endedMinutesAgo` before now.
 *
 * They are spaced so they never overlap: agent-hours SUMS per-invocation wall time while the
 * busy span UNIONS it, and two rows sharing a second would make those two numbers disagree for
 * a reason the test did not intend.
 */
export interface SpendTarget {
  taskId: string;
  /** The step these runs belong to — required, see the attribution note above. */
  taskStepId: string;
  /** The provider they ran on — required, see the token note above. */
  cliProviderId: string;
}

export async function seedSpend(
  sql: postgres.Sql,
  target: SpendTarget,
  rows: SeededInvocation[],
  opts: { endedMinutesAgo?: number } = {},
): Promise<SpendFixture> {
  const ids: string[] = [];
  // Laid out BACKWARDS from `endedMinutesAgo`, so the LAST row ends before now. Anchoring the
  // first row instead put later ones in the future and silently outside the window — measured:
  // two seeded runs, and the summary counted one.
  const gapMs = 60_000;
  const spanMs = rows.reduce((n, r) => n + r.durationMs, 0) + Math.max(0, rows.length - 1) * gapMs;
  let cursorMs = Date.now() - (opts.endedMinutesAgo ?? 10) * 60_000 - spanMs;

  for (const row of rows) {
    const id = randomUUID();
    const startedAt = new Date(cursorMs);
    const endedAt = new Date(cursorMs + row.durationMs);
    // One minute of daylight between runs, so the union and the sum agree.
    cursorMs = endedAt.getTime() + gapMs;

    await sql`
      insert into cli_invocations (
        id, task_id, task_step_id, cli_provider_id, mode, prompt, exit_code,
        started_at, ended_at, duration_ms, token_usage, cost
      ) values (
        ${id}, ${target.taskId}, ${target.taskStepId}, ${target.cliProviderId},
        'cli', 'e2e seeded invocation', 0,
        ${startedAt}, ${endedAt}, ${row.durationMs},
        ${sql.json({
          inputTokens: Math.round(row.totalTokens * 0.7),
          outputTokens: Math.round(row.totalTokens * 0.3),
          totalTokens: row.totalTokens,
        })},
        ${sql.json({ billable: true, costUsd: row.costUsd, source: 'computed' })}
      )
    `;
    ids.push(id);
  }

  return {
    invocationIds: ids,
    totalCostUsd: rows.reduce((n, r) => n + r.costUsd, 0),
    totalTokens: rows.reduce((n, r) => n + r.totalTokens, 0),
    totalMs: rows.reduce((n, r) => n + r.durationMs, 0),
  };
}

/** Invocations cascade with their task, so this is only for a fixture that outlives one. */
export async function cleanupSpend(sql: postgres.Sql, invocationIds: string[]): Promise<void> {
  if (invocationIds.length === 0) return;
  await sql`delete from cli_invocations where id = any(${sql.array(invocationIds)}::uuid[])`;
}
