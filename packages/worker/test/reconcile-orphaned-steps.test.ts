import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { reconcileOrphanedSteps } from '../src/queues/task-queue.js';

/** Every column referenced anywhere in a drizzle condition tree. Structural, so the test
 *  asserts what the query actually filters on rather than matching source text. */
function conditionColumns(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === 'string' && 'columnType' in obj) acc.push(obj.name);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionColumns(c, acc);
  return acc;
}

function tableNameOf(table: unknown): string {
  if (table && typeof table === 'object') {
    const obj = table as Record<string, unknown>;
    const sym = Object.getOwnPropertySymbols(obj).find((s) => s.description === 'drizzle:Name');
    if (sym) {
      const name = obj[sym as unknown as string];
      if (typeof name === 'string') return name;
    }
  }
  return '';
}

interface RecordedUpdate {
  table: string;
  set: Record<string, unknown>;
  where: unknown;
}

/** One `waiting_cli` step that the task has ALREADY moved past, so reconcile takes the
 *  abandoned-chain branch: it requeues the row and never touches BullMQ. That keeps the test
 *  on the only thing it is about — the predicate of the orphan update. */
function makeDb(recorded: RecordedUpdate[]): Database {
  const stuck = {
    taskStepId: 'ts-1',
    taskId: 'task-1',
    stepId: '09_5-skill-generation',
    round: 0,
    userId: 'user-1',
    epoch: 3,
    currentStepId: 'some-later-step',
    currentRound: 0,
  };
  let pass = 0;
  const db = {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => {
        const whereFn = (_cond: unknown) => ({
          // requeueAbandonedOrphan's read of the step row — empty, so it returns early.
          limit: async (_n: number) => [],
          // The two reconcile passes await .where() directly. Pass 1 finds the stuck step,
          // pass 2 (steps left `running`) finds nothing.
          then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
            Promise.resolve(pass++ === 0 ? [stuck] : []).then(onOk, onErr),
        });
        return { innerJoin: (_t: unknown, _c: unknown) => ({ where: whereFn }), where: whereFn };
      },
    }),
    update: (table: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: async (cond: unknown) => {
          recorded.push({ table: tableNameOf(table), set: v, where: cond });
        },
      }),
    }),
  } as unknown as Database;
  return db;
}

describe('reconcileOrphanedSteps', () => {
  it('only orphans invocations that actually STARTED', async () => {
    // Under GLOBAL_PAUSE the cli-exec pickup gate holds every invocation at started_at NULL,
    // so without this filter each worker restart during a pause window ends queued runs as
    // "orphaned by a worker restart" — work the BullMQ job still owes, and three of them spend
    // MAX_ORPHAN_REDISPATCH on runs that never happened (task 977e1c5a, step 09_5).
    const recorded: RecordedUpdate[] = [];
    await reconcileOrphanedSteps(makeDb(recorded));

    const orphanUpdate = recorded.find((u) => u.table === 'cli_invocations');
    expect(orphanUpdate).toBeDefined();
    expect(String(orphanUpdate!.set.errorMessage)).toMatch(/orphaned by a worker restart/);
    expect(conditionColumns(orphanUpdate!.where)).toContain('started_at');
  });
});
