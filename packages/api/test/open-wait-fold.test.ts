import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Closing a parked form's wait (the form submit, the merge clarification answer, Skip, the PR poller's
// auto-finalize) credits it to idle_ms in the SAME update that clears waiting_started_at, from the row that
// update locks. The arithmetic lives in SQL and is exercised on Postgres by the gated step-fold-preread tests
// (api and worker); these pins are the always-run half, for the two things that file cannot notice when it is not
// run: the shared expression losing its clamp or its anchor, and a closing site writing its own copy.
//
// Same approach as resume-fold.test.ts, which pins CLOSED_GAP_INTO_IDLE_MS by reading the files.

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const SQL_SOURCE = 'packages/database/src/open-wait.ts';
// The closing sites by file, with how many each holds. api steps.ts: the form submit, the clarification answer and
// Skip. worker pr-poll-queue.ts: the auto-finalize.
const SITES: [file: string, count: number][] = [
  ['packages/api/src/routes/tasks/steps.ts', 3],
  ['packages/worker/src/queues/pr-poll-queue.ts', 1],
];

describe("closing a parked form's wait credits it to idle_ms", () => {
  it('the fold is anchored on waiting_started_at and clamped to int4', async () => {
    const src = await readFile(path.join(repoRoot, SQL_SOURCE), 'utf8');
    const def = src.slice(src.indexOf('export const OPEN_WAIT_INTO_IDLE_MS'));
    const body = def.slice(0, def.indexOf('`;') + 2);
    // Anchored on the marker the PARK wrote, so the credit is exactly the open wait.
    expect(body).toContain('schema.taskSteps.waitingStartedAt');
    // greatest(0, NULL) is 0 in Postgres: a row whose wait is already closed adds nothing.
    expect(body).toContain('greatest(0,');
    // Load-bearing: idle_ms is int4 (~24.8 days); without this a form parked longer than that cannot be
    // submitted, answered or skipped ("integer out of range").
    expect(body).toContain('2147483647');
  });

  it('the SQL has exactly one definition, shared by both packages', async () => {
    for (const [src, count] of SITES) {
      const text = await readFile(path.join(repoRoot, src), 'utf8');
      expect(text, src).not.toContain('const OPEN_WAIT_INTO_IDLE_MS');
      expect(text, src).toContain("from '@haive/database'");
      expect(text.split('idleMs: OPEN_WAIT_INTO_IDLE_MS').length - 1, src).toBe(count);
    }
  });
});
