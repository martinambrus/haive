import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Re-opening a CLOSED step (resume / retry_ai / the worker's allowance auto-resume) nulls
// `ended_at` but keeps `started_at`, which extends the step's span across the period it sat
// closed. computeStepContribution bills span minus idle as WORK, so without a credit that whole
// gap silently becomes agent work — a step Stopped 2026-08-14 12:06 and resumed 2026-08-16 18:25
// reported 55.27h of work for 57min of real CLI runtime.
//
// The rule is structural, so the test is too: a future re-open site added without the fold is
// exactly the regression that matters, and no behavioural test of one handler would catch it.
// Same approach as rootless-docker.test.ts, which asserts repo invariants by reading the files.
// The arithmetic itself lives in SQL and is verified against the original failing input in the
// commit message, not here.
//
// Both files are scanned because the rule spans packages: the api owns resume/retry_ai and the
// worker owns the allowance auto-resume, and the first version of this test read only the api
// file — so the worker sibling stayed uncredited for three weeks and billed a 27h20m rate-limit
// outage as work on task eb9e73be. The two OTHER worker files with a re-open shape are not
// scanned: task-queue.ts sets waiting_started_at inside the same transaction that closes the
// step (the credit would be a no-op there), and dag-executor.ts / step-runner.ts re-open rows of
// task_dag_issues / task_step_agent_minings, which carry no timing at all.

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const SOURCES = [
  'packages/api/src/routes/tasks/steps.ts',
  'packages/worker/src/queues/_step-reset.ts',
];
const SQL_SOURCE = 'packages/database/src/closed-gap.ts';

/** Every `.set({ ... })` payload in the file, via brace matching (nested objects included). */
function extractSetBlocks(src: string): string[] {
  const blocks: string[] = [];
  const marker = '.set({';
  let i = src.indexOf(marker);
  while (i !== -1) {
    let depth = 0;
    let j = i + marker.length - 1; // sits on the opening brace
    for (; j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(src.slice(i + marker.length, j));
    i = src.indexOf(marker, j);
  }
  return blocks;
}

/** Step-row updates that clear ended_at, across every scanned source. Split by whether they also
 *  clear started_at: that is the RESET shape (a fresh run, folded into carried_* by
 *  computeFoldContribution), versus the RE-OPEN shape (the same run continues, so its span
 *  grows). */
async function classifyEndedAtBlocks(): Promise<{ reopens: string[]; resets: string[] }> {
  const blocks: string[] = [];
  for (const src of SOURCES) {
    const text = await readFile(path.join(repoRoot, src), 'utf8');
    blocks.push(...extractSetBlocks(text).filter((b) => b.includes('endedAt: null')));
  }
  return {
    reopens: blocks.filter((b) => !b.includes('startedAt: null')),
    resets: blocks.filter((b) => b.includes('startedAt: null')),
  };
}

describe('re-opening a closed step credits the closed gap to idle_ms', () => {
  it('every re-open site carries the fold', async () => {
    const { reopens } = await classifyEndedAtBlocks();
    // api: resume (fan-out arm), resume (loop arm), retry_ai. worker: autoResumeFailedStep.
    expect(reopens).toHaveLength(4);
    for (const block of reopens) {
      expect(block).toContain('idleMs: CLOSED_GAP_INTO_IDLE_MS');
    }
  });

  it('reset sites do NOT carry the fold (they zero idle and fold into carried_*)', async () => {
    const { resets } = await classifyEndedAtBlocks();
    // api: retry, the per-step switch-cli invalidation. worker: resetStepAndDownstream.
    expect(resets).toHaveLength(3);
    for (const block of resets) {
      expect(block).not.toContain('CLOSED_GAP_INTO_IDLE_MS');
      expect(block).toContain('idleMs: 0');
    }
  });

  it('the fold is anchored on ended_at and clamped to int4', async () => {
    const src = await readFile(path.join(repoRoot, SQL_SOURCE), 'utf8');
    const def = src.slice(src.indexOf('export const CLOSED_GAP_INTO_IDLE_MS'));
    const body = def.slice(0, def.indexOf('`;') + 2);
    // Anchored on the column the CLOSING path wrote, so the credit is exactly the closed gap.
    expect(body).toContain('schema.taskSteps.endedAt');
    // greatest(0, NULL) is 0 in Postgres — re-opening a still-live step credits nothing.
    expect(body).toContain('greatest(0,');
    // Load-bearing: idle_ms is int4 (~24.8 days); without this a month-old stop aborts the
    // resume with "integer out of range".
    expect(body).toContain('2147483647');
  });

  it('the SQL has exactly one definition, shared by both packages', async () => {
    for (const src of SOURCES) {
      const text = await readFile(path.join(repoRoot, src), 'utf8');
      expect(text).not.toContain('const CLOSED_GAP_INTO_IDLE_MS');
      expect(text).toContain("from '@haive/database'");
    }
  });
});
