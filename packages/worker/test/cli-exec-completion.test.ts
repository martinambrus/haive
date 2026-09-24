import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';

const stubs = vi.hoisted(() => ({
  executeByKind: vi.fn(),
  resumeStepIfLinked: vi.fn(async () => {}),
  recordLedgerEntry: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../src/queues/cli-exec/exec-core.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeByKind: stubs.executeByKind,
}));
vi.mock('../src/queues/cli-exec/resolvers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resumeStepIfLinked: stubs.resumeStepIfLinked,
  resolveProviderNameForPayload: async () => 'claude-code',
}));
vi.mock('../src/queues/cli-stream-publisher.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publishCliExit: async () => {},
}));
vi.mock('../src/queues/cli-park-timing.js', () => ({
  foldCliParkOnResume: async () => {},
  markCliParkBegin: async () => {},
}));
vi.mock('../src/queues/cli-exec/invocation-cost.js', () => ({
  resolveInvocationCost: async () => null,
}));
vi.mock('../src/secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));
vi.mock('../src/step-engine/task-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordLedgerEntry: stubs.recordLedgerEntry,
}));

import { handleCliExecJob } from '../src/queues/cli-exec/handlers.js';

function tableNameOf(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find(
    (s) => s.description === 'drizzle:Name',
  );
  return sym ? String((table as Record<symbol, unknown>)[sym]) : '';
}

/** Every value a drizzle condition binds, flattened. */
function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) conditionValues(n, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) acc.push(obj.value);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionValues(c, acc);
  return acc;
}

interface Write {
  tx: number | null;
  table: string;
  set: Record<string, unknown>;
  where: unknown;
}

/** Records every write with the transaction it ran in (null outside one). */
function fakeDb(opts: {
  lockedRun?: { supersededAt: Date | null };
  summaryLands?: { stepId: string; round: number };
}) {
  const writes: Write[] = [];
  let txSeq = 0;
  const handle = (tx: number | null): unknown => ({
    query: {
      cliInvocations: {
        findFirst: async () => ({ id: RUN, endedAt: null, supersededAt: null }),
      },
      tasks: { findFirst: async () => ({ status: 'running' }) },
    },
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          writes.push({ tx, table: tableNameOf(table), set, where });
          const landed = 'summary' in set && opts.summaryLands ? [opts.summaryLands] : [];
          return {
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(undefined).then(res, rej),
            returning: async () => landed,
          };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({ for: async () => (opts.lockedRun ? [opts.lockedRun] : []) }),
      }),
    }),
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(handle(++txSeq)),
  });
  return { db: handle(null) as Database, writes };
}

const RUN = '11111111-1111-4111-8111-111111111111';
const MINING = '22222222-2222-4222-8222-222222222222';
const STEP = '33333333-3333-4333-8333-333333333333';
const ENDED_AT = new Date('2026-09-24T18:00:00.123Z');

const base: CliExecJobPayload = {
  invocationId: RUN,
  taskId: '44444444-4444-4444-8444-444444444444',
  taskStepId: STEP,
  userId: '55555555-5555-4555-8555-555555555555',
  cliProviderId: null,
  kind: 'agent_mining',
  spec: {},
  agentMiningId: MINING,
};
const recap: CliExecJobPayload = {
  ...base,
  kind: 'cli',
  taskStepId: null,
  agentMiningId: undefined,
  purpose: 'step_summary',
  summaryForStepId: STEP,
  summaryForStepEndedAt: ENDED_AT.toISOString(),
};
const ok = { exitCode: 0, rawOutput: 'Three sentences.', parsedOutput: {}, errorMessage: null };

const runWrites = (writes: Write[]) => writes.filter((w) => w.table === 'cli_invocations');
const miningWrites = (writes: Write[]) =>
  writes.filter((w) => w.table === 'task_step_agent_minings');

beforeEach(() => {
  stubs.executeByKind.mockReset();
  stubs.resumeStepIfLinked.mockReset();
  stubs.recordLedgerEntry.mockReset();
});

describe('a cli run completion', () => {
  it('lands with its mining result in one transaction, on the row still linked to it', async () => {
    stubs.executeByKind.mockResolvedValue(ok);
    const { db, writes } = fakeDb({});
    await handleCliExecJob(db, base);

    const ended = runWrites(writes).find((w) => w.set.exitCode === 0);
    const done = miningWrites(writes).find((w) => w.set.status === 'done');
    expect(ended?.tx).not.toBeNull();
    expect(done?.tx).toBe(ended?.tx);
    for (const w of miningWrites(writes)) expect(conditionValues(w.where)).toContain(RUN);
  });

  it('fails with its mining row in one transaction, on the row still linked to it', async () => {
    stubs.executeByKind.mockRejectedValue(new Error('sandbox died'));
    const { db, writes } = fakeDb({});
    await expect(handleCliExecJob(db, base)).rejects.toThrow('sandbox died');

    const ended = runWrites(writes).find((w) => w.set.exitCode === -1);
    const failed = miningWrites(writes).find((w) => w.set.status === 'failed');
    expect(ended?.tx).not.toBeNull();
    expect(failed?.tx).toBe(ended?.tx);
    expect(conditionValues(failed?.where)).toContain(RUN);
  });

  it('stays recorded as it ended when handing the step back fails', async () => {
    stubs.executeByKind.mockResolvedValue(ok);
    stubs.resumeStepIfLinked.mockRejectedValue(new Error('queue down'));
    const { db, writes } = fakeDb({});
    await expect(handleCliExecJob(db, base)).rejects.toThrow('queue down');

    expect(runWrites(writes).some((w) => w.set.exitCode === -1)).toBe(false);
    expect(stubs.resumeStepIfLinked).toHaveBeenCalledTimes(1);
  });
});

describe('a step recap', () => {
  it('writes nothing for a run a Retry superseded', async () => {
    stubs.executeByKind.mockResolvedValue(ok);
    const { db, writes } = fakeDb({ lockedRun: { supersededAt: new Date() } });
    await handleCliExecJob(db, recap);

    expect(writes.some((w) => w.table === 'task_steps')).toBe(false);
    expect(stubs.recordLedgerEntry).not.toHaveBeenCalled();
  });

  it('lands only on the row version it summarized', async () => {
    stubs.executeByKind.mockResolvedValue(ok);
    const { db, writes } = fakeDb({ lockedRun: { supersededAt: null } });
    await handleCliExecJob(db, recap);

    const summary = writes.find((w) => w.table === 'task_steps' && 'summary' in w.set);
    const binds = conditionValues(summary?.where);
    expect(binds).toContain('done');
    expect(binds.some((v) => v instanceof Date && v.getTime() === ENDED_AT.getTime())).toBe(true);
    expect(stubs.recordLedgerEntry).not.toHaveBeenCalled();
  });

  it('records its ledger entry once it landed, while the step still reads done', async () => {
    stubs.executeByKind.mockResolvedValue(ok);
    const { db } = fakeDb({
      lockedRun: { supersededAt: null },
      summaryLands: { stepId: '08c-code-review', round: 1 },
    });
    await handleCliExecJob(db, recap);

    expect(stubs.recordLedgerEntry).toHaveBeenCalledTimes(1);
    expect(stubs.recordLedgerEntry.mock.calls[0]?.[4]).toEqual({ whileStepDone: true });
  });
});
