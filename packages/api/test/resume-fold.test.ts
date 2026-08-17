import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Re-opening a CLOSED step (resume / retry_ai) nulls `ended_at` but keeps `started_at`, which
// extends the step's span across the period it sat closed. computeStepContribution bills span
// minus idle as WORK, so without a credit that whole gap silently becomes agent work — a step
// Stopped 2026-08-14 12:06 and resumed 2026-08-16 18:25 reported 55.27h of work for 57min of
// real CLI runtime.
//
// The rule is structural, so the test is too: a future FOURTH re-open site added without the
// fold is exactly the regression that matters, and no behavioural test of one handler would
// catch it. Same approach as rootless-docker.test.ts, which asserts repo invariants by reading
// the files. The arithmetic itself lives in SQL and is verified against the original failing
// input in the commit message, not here.

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const SRC = 'packages/api/src/routes/tasks/steps.ts';

async function readSrc(): Promise<string> {
  return readFile(path.join(repoRoot, SRC), 'utf8');
}

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

/** A step-row update that clears ended_at. Split by whether it also clears started_at:
 *  that is the RESET shape (a fresh run, folded into carried_* by computeFoldContribution),
 *  versus the RE-OPEN shape (the same run continues, so its span grows). */
async function classifyEndedAtBlocks(): Promise<{ reopens: string[]; resets: string[] }> {
  const blocks = extractSetBlocks(await readSrc()).filter((b) => b.includes('endedAt: null'));
  return {
    reopens: blocks.filter((b) => !b.includes('startedAt: null')),
    resets: blocks.filter((b) => b.includes('startedAt: null')),
  };
}

describe('re-opening a closed step credits the closed gap to idle_ms', () => {
  it('every re-open site carries the fold', async () => {
    const { reopens } = await classifyEndedAtBlocks();
    // resume (fan-out arm), resume (loop arm), retry_ai.
    expect(reopens).toHaveLength(3);
    for (const block of reopens) {
      expect(block).toContain('idleMs: CLOSED_GAP_INTO_IDLE_MS');
    }
  });

  it('reset sites do NOT carry the fold (they zero idle and fold into carried_*)', async () => {
    const { resets } = await classifyEndedAtBlocks();
    // retry, and the per-step switch-cli invalidation.
    expect(resets).toHaveLength(2);
    for (const block of resets) {
      expect(block).not.toContain('CLOSED_GAP_INTO_IDLE_MS');
      expect(block).toContain('idleMs: 0');
    }
  });

  it('the fold is anchored on ended_at and clamped to int4', async () => {
    const src = await readSrc();
    const def = src.slice(src.indexOf('const CLOSED_GAP_INTO_IDLE_MS'));
    const body = def.slice(0, def.indexOf('`;') + 2);
    // Anchored on the column the CLOSING path wrote, so the credit is exactly the closed gap.
    expect(body).toContain('schema.taskSteps.endedAt');
    // greatest(0, NULL) is 0 in Postgres — re-opening a still-live step credits nothing.
    expect(body).toContain('greatest(0,');
    // Load-bearing: idle_ms is int4 (~24.8 days); without this a month-old stop aborts the
    // resume with "integer out of range".
    expect(body).toContain('2147483647');
  });
});
