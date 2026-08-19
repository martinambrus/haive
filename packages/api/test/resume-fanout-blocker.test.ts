import { describe, expect, it } from 'vitest';
import { supersedeBlockingInvocation } from '../src/routes/tasks/steps.js';

/** Every column referenced anywhere in a drizzle condition tree — asserts what the query
 *  actually filters on, rather than matching source text. */
function conditionColumns(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === 'string' && 'columnType' in obj) acc.push(obj.name);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionColumns(c, acc);
  return acc;
}

interface Recorded {
  selectWhere: unknown;
  updates: { set: Record<string, unknown>; where: unknown }[];
}

function makeTx(latest: Record<string, unknown> | null): {
  tx: never;
  recorded: Recorded;
} {
  const recorded: Recorded = { selectWhere: undefined, updates: [] };
  const tx = {
    select: (_fields: unknown) => ({
      from: (_table: unknown) => ({
        where: (cond: unknown) => {
          recorded.selectWhere = cond;
          return {
            orderBy: (_o: unknown) => ({
              limit: async (_n: number) => (latest ? [latest] : []),
            }),
          };
        },
      }),
    }),
    update: (_table: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: async (cond: unknown) => {
          recorded.updates.push({ set: v, where: cond });
        },
      }),
    }),
  } as unknown as never;
  return { tx, recorded };
}

const NOW = new Date('2026-08-19T12:48:50.907Z');

describe('supersedeBlockingInvocation', () => {
  it('supersedes the trailing invocation that failed', async () => {
    // The exact row that made "Re-run 5 failed terminals" a no-op on task 977e1c5a: ended with
    // an orphan message, never superseded, so resolveLlmPhase re-read it and failed the step
    // before resolveAgentMiningPhase could honour the retry marker.
    const { tx, recorded } = makeTx({
      id: 'inv-orphan',
      endedAt: NOW,
      exitCode: null,
      errorMessage: 'CLI invocation orphaned by a worker restart (worker exited mid-run)',
    });
    expect(await supersedeBlockingInvocation(tx, 'ts-1', NOW)).toBe('inv-orphan');
    expect(recorded.updates).toHaveLength(1);
    expect(recorded.updates[0]!.set.supersededAt).toBe(NOW);
  });

  it('reads only the live, unconsumed, non-mining invocation', async () => {
    // Same filters resolveLlmPhase applies. agent_mining rows must stay out: the fan-out's
    // results live on task_step_agent_minings and retryMiningAgents reads cli_invocation_id
    // off them, so superseding one would break the very retry this unblocks.
    const { tx, recorded } = makeTx(null);
    await supersedeBlockingInvocation(tx, 'ts-1', NOW);
    const cols = conditionColumns(recorded.selectWhere);
    expect(cols).toEqual(
      expect.arrayContaining(['task_step_id', 'superseded_at', 'consumed_at', 'mode']),
    );
  });

  it('leaves a succeeded invocation alone', async () => {
    // This arm can target a DEGRADED (`done`) step whose trailing invocation succeeded and is
    // not yet consumed. Superseding that would discard good output and buy a fresh CLI call.
    const { tx, recorded } = makeTx({
      id: 'inv-ok',
      endedAt: NOW,
      exitCode: 0,
      errorMessage: null,
    });
    expect(await supersedeBlockingInvocation(tx, 'ts-1', NOW)).toBeNull();
    expect(recorded.updates).toHaveLength(0);
  });

  it('leaves a still-running invocation alone', async () => {
    const { tx, recorded } = makeTx({
      id: 'inv-live',
      endedAt: null,
      exitCode: null,
      errorMessage: null,
    });
    expect(await supersedeBlockingInvocation(tx, 'ts-1', NOW)).toBeNull();
    expect(recorded.updates).toHaveLength(0);
  });

  it('treats error text on a clean exit as a failure', async () => {
    // A stream-json run that never emitted a result exits 0 with an error message; the
    // resolver fails the step on it, so it blocks the resume the same way.
    const { tx, recorded } = makeTx({
      id: 'inv-noresult',
      endedAt: NOW,
      exitCode: 0,
      errorMessage: '  no result event  ',
    });
    expect(await supersedeBlockingInvocation(tx, 'ts-1', NOW)).toBe('inv-noresult');
    expect(recorded.updates).toHaveLength(1);
  });
});
