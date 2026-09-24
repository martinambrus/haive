import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';
import { applyAgentPatch, applyAgentPatchOnce } from './_plan-prompt.js';
import { partialApplyNote } from './01-plan-build.js';
import { foldCoverageResults } from './02-plan-coverage.js';

vi.mock('./_plan-prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_plan-prompt.js')>();
  return { ...actual, applyAgentPatch: vi.fn() };
});
vi.mock('./_plan-semantic-stop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_plan-semantic-stop.js')>();
  return {
    ...actual,
    ensureSemanticExpansionResolution: vi.fn(
      async (_db: unknown, _repo: unknown, _self: unknown, ops: unknown[]) => ops,
    ),
  };
});
vi.mock('./_plan-breadth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_plan-breadth.js')>();
  return { ...actual, assertPlanPatchWithinBreadth: vi.fn(async () => {}) };
});

function conditionColumns(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === 'string' && 'columnType' in obj) acc.push(obj.name);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionColumns(c, acc);
  return acc;
}

function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) acc.push(obj.value);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionValues(c, acc);
  return acc;
}

/** The claim is the one write carrying `consumed_at`; every other write is a stamp, recorded with
 *  whether it went through the transaction. */
function fakeDb(opts: { claimedElsewhere?: boolean } = {}) {
  const claims: unknown[] = [];
  const stamps: { values: Record<string, unknown>; cond: unknown; inTransaction: boolean }[] = [];
  const update = (inTransaction: boolean) => () => ({
    set: (values: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        if ('consumedAt' in values) {
          claims.push(cond);
          return { returning: async () => (opts.claimedElsewhere ? [] : [{ id: 'row' }]) };
        }
        stamps.push({ values, cond, inTransaction });
        return Promise.resolve();
      },
    }),
  });
  const db: Record<string, unknown> = { update: update(false) };
  db.transaction = async (fn: (tx: unknown) => unknown) =>
    fn({ ...db, update: update(true), inTransaction: true });
  return { db: db as unknown as Database, claims, stamps };
}

const ctx = (db: Database) =>
  ({
    db,
    taskId: 'task-1',
    taskStepId: 'step-row',
    logger: { warn: () => {}, info: () => {} },
  }) as unknown as StepContext;

const applied = { created: [], updated: [], dropped: [], strippedCodeLinks: [] } as never;
const thinner = { created: [], updated: [], dropped: ['one op'], strippedCodeLinks: [] } as never;
const noNote = () => null;

describe('applyAgentPatchOnce', () => {
  it('writes the reply inside the transaction that claims its row', async () => {
    const { db, claims } = fakeDb();
    const write = vi.fn(async (_tx: unknown) => applied);
    await applyAgentPatchOnce(ctx(db), 'agent-a', write, noNote);

    expect(write).toHaveBeenCalledTimes(1);
    expect((write.mock.calls[0]![0] as { inTransaction?: boolean }).inTransaction).toBe(true);
    expect(conditionColumns(claims[0])).toEqual(
      expect.arrayContaining(['task_step_id', 'agent_id', 'consumed_at']),
    );
    expect(conditionValues(claims[0])).toEqual(expect.arrayContaining(['step-row', 'agent-a']));
  });

  it('leaves a reply another pass already claimed to that pass', async () => {
    const { db } = fakeDb({ claimedElsewhere: true });
    const write = vi.fn(async (_tx: unknown) => applied);

    expect(await applyAgentPatchOnce(ctx(db), 'agent-a', write, noNote)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('records the note on the claimed row in the same transaction', async () => {
    // Every later pass skips a claimed reply, so a note written after the commit is lost for good.
    const { db, stamps } = fakeDb();
    await applyAgentPatchOnce(
      ctx(db),
      'agent-a',
      async () => thinner,
      (a) => partialApplyNote(a.dropped),
    );

    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({
      values: { errorMessage: 'plan patch partially applied: one op' },
      inTransaction: true,
    });
    expect(conditionColumns(stamps[0]!.cond)).toEqual(['id']);
    expect(conditionValues(stamps[0]!.cond)).toEqual(['row']);
  });

  it('writes no note when the outcome has none', async () => {
    const { db, stamps } = fakeDb();
    await applyAgentPatchOnce(
      ctx(db),
      'agent-a',
      async () => applied,
      (a) => partialApplyNote(a.dropped),
    );
    expect(stamps).toEqual([]);
  });
});

describe('foldCoverageResults', () => {
  const reply = {
    agentId: 'plan-coverage-x',
    agentTitle: 'Coverage',
    status: 'done',
    output: { ops: [{ op: 'upsert', nodeRef: 'n1', title: 'Consent' }] },
    rawOutput: null,
    errorMessage: null,
  } as unknown as AgentMiningResult;
  const detected = { repositoryId: 'repo-1', buildFormValues: {} } as never;

  beforeEach(() => {
    vi.mocked(applyAgentPatch).mockReset();
    vi.mocked(applyAgentPatch).mockResolvedValue(applied);
  });

  it('folds a reply once it has claimed it', async () => {
    const { db } = fakeDb();
    const out = await foldCoverageResults(ctx(db), detected, [reply]);

    expect(vi.mocked(applyAgentPatch)).toHaveBeenCalledTimes(1);
    expect(
      (vi.mocked(applyAgentPatch).mock.calls[0]![0] as { inTransaction?: boolean }).inTransaction,
    ).toBe(true);
    expect(out.hadFailure).toBe(false);
  });

  it('notes a thinner reply with the claim that folds it, and counts it a failure', async () => {
    vi.mocked(applyAgentPatch).mockResolvedValue(thinner);
    const { db, stamps } = fakeDb();
    const out = await foldCoverageResults(ctx(db), detected, [reply]);

    expect(out.hadFailure).toBe(true);
    expect(stamps).toEqual([
      expect.objectContaining({
        values: { errorMessage: 'plan patch partially applied: one op' },
        inTransaction: true,
      }),
    ]);
  });

  it('leaves a reply another pass folded, without counting it a failure', async () => {
    const { db, stamps } = fakeDb({ claimedElsewhere: true });
    const out = await foldCoverageResults(ctx(db), detected, [reply]);

    expect(vi.mocked(applyAgentPatch)).not.toHaveBeenCalled();
    expect(out.hadFailure).toBe(false);
    expect(stamps).toEqual([]);
  });
});
