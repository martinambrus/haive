import { describe, it, expect } from 'vitest';
import type { Database } from '@haive/database';
import type { StepApplyArgs, StepContext } from '../../step-definition.js';
import { externalPlanSyncStep, type ExternalPlanSyncDetect } from './01f-external-plan-sync.js';

const NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POINT = 'cccccccccccccccccccccccccccccccccccccccc';

function fakeDb(): { db: Database; stamps: Record<string, unknown>[] } {
  const stamps: Record<string, unknown>[] = [];
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          stamps.push(values);
        },
      }),
    }),
  } as unknown as Database;
  return { db, stamps };
}

function ctx(db: Database): StepContext {
  return {
    taskId: 't',
    taskStepId: 's',
    userId: 'u',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    sandboxWorkdir: '/tmp',
    cliProviderId: null,
    round: 0,
    db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
    emitProgress: async () => {},
    throwIfCancelled: () => {},
  } as unknown as StepContext;
}

const detect = (over: Partial<ExternalPlanSyncDetect> = {}): ExternalPlanSyncDetect => ({
  repositoryId: 'r',
  branchPoint: POINT,
  since: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  firstRun: false,
  measured: true,
  commits: [{ sha: 'dddddddd11', subject: 'teammate: add billing export' }],
  changedPaths: ['src/billing/export.ts'],
  commitsOmitted: 0,
  pathsOmitted: 0,
  reason: null,
  planMarkdown: '# Plan',
  nodeTitles: { [NODE]: 'Billing' },
  nodeCount: 4,
  linksMarkedStale: 0,
  ...over,
});

const OPS = { ops: [{ op: 'upsert', nodeRef: NODE, status: 'done' }] };

async function apply(
  d: ExternalPlanSyncDetect,
  args: Partial<StepApplyArgs<ExternalPlanSyncDetect>>,
  db: Database,
) {
  return externalPlanSyncStep.apply(ctx(db), {
    detected: d,
    formValues: {},
    ...args,
  } as StepApplyArgs<ExternalPlanSyncDetect>);
}

describe('form', () => {
  const form = (d: ExternalPlanSyncDetect, out: unknown) =>
    externalPlanSyncStep.form?.(ctx(fakeDb().db), d, out) ?? null;

  it('does not park when nothing landed outside the workflow', () => {
    expect(form(detect({ commits: [] }), OPS)).toBeNull();
  });

  it('does not park on an empty proposal, the normal outcome for maintenance work', () => {
    expect(form(detect(), { ops: [] })).toBeNull();
  });

  it('names the node an op touches rather than showing a raw id', () => {
    const schema = form(detect(), OPS);
    const label =
      schema?.fields[0]?.type === 'multi-select' ? schema.fields[0].options[0]?.label : '';
    expect(label).toContain('Billing');
    expect(label).toContain('mark done');
  });

  it('discloses stale links as already-recorded, not as part of the approval', () => {
    const schema = form(detect({ linksMarkedStale: 3 }), OPS);
    expect(schema?.description).toContain('3 existing code link(s) were flagged stale');
    expect(schema?.description).toContain('not part of this approval');
    // Only the ops are tickable — staleness is a fact, not a proposal.
    expect(schema?.fields.map((f) => f.id)).toEqual(['applyOps']);
  });

  it('states a commit cap it applied', () => {
    expect(form(detect({ commitsOmitted: 9 }), OPS)?.description).toContain('+9 not listed');
  });
});

describe('apply', () => {
  it('does not stamp when the range could not be measured', async () => {
    const { db, stamps } = fakeDb();
    const out = await apply(detect({ measured: false, commits: [] }), {}, db);
    expect(out.decision).toBe('not_measured');
    expect(stamps).toHaveLength(0);
  });

  it('starts tracking without reviewing history on a first run', async () => {
    const { db, stamps } = fakeDb();
    const out = await apply(detect({ firstRun: true, since: null, commits: [] }), {}, db);
    expect(out.decision).toBe('tracking_started');
    expect(stamps[0]?.planSyncedCommit).toBe(POINT);
    // The KB watermark is a separate column and must not move with this one.
    expect(stamps[0]?.kbSyncedCommit).toBeUndefined();
  });

  it('stamps a repository that has no plan without proposing anything', async () => {
    const { db, stamps } = fakeDb();
    const out = await apply(
      detect({ nodeCount: 0, reason: 'this repository has no plan' }),
      {},
      db,
    );
    expect(out.decision).toBe('nothing_to_review');
    expect(stamps).toHaveLength(1);
  });

  it('separates "the plan already said this" from "the developer said no"', async () => {
    const { db } = fakeDb();
    const agreed = await apply(detect(), { llmOutput: { ops: [] }, formValues: {} }, db);
    // No form parks on an empty proposal, so an empty formValues there is not a decline.
    expect(agreed.decision).toBe('nothing_to_review');

    const declined = await apply(detect(), { llmOutput: OPS, formValues: { applyOps: [] } }, db);
    expect(declined.decision).toBe('declined');
    expect(declined.proposed).toBe(1);
    expect(declined.applied).toBe(0);
  });

  it('carries the stale-link count into its output whatever the developer decided', async () => {
    const { db } = fakeDb();
    const out = await apply(
      detect({ linksMarkedStale: 5 }),
      { llmOutput: OPS, formValues: { applyOps: [] } },
      db,
    );
    // Flagged in detect, unconditionally: staleness is a fact about the code, so a decline
    // does not undo it.
    expect(out.linksMarkedStale).toBe(5);
  });
});
