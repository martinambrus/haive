import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { StepApplyArgs, StepContext } from '../../step-definition.js';
import {
  externalKbSyncStep,
  parseKbChanges,
  type ExternalKbSyncDetect,
} from './01e-external-kb-sync.js';

vi.mock('./_external-drift.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_external-drift.js')>();
  return {
    ...actual,
    resolveExternalDrift: vi.fn(async () => ({
      repositoryId: 'r',
      worktreePath: '/sentinel/worktree',
      branchPoint: 'a'.repeat(40),
      since: 'b'.repeat(40),
      firstRun: false,
      measured: true,
      commits: [{ sha: 'cccccccc11', subject: 'teammate: add billing export' }],
      changedPaths: ['src/billing/export.ts'],
      commitsOmitted: 0,
      pathsOmitted: 0,
      reason: null,
    })),
  };
});

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ext-kb-'));
  made.push(d);
  return d;
}

/** Records what `stampExternalWatermark` would write, which is the only database effect
 *  this step has. `.update().set().where()` is the whole chain it uses. */
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

const detect = (over: Partial<ExternalKbSyncDetect> = {}): ExternalKbSyncDetect => ({
  repositoryId: 'r',
  worktreePath: '/tmp',
  branchPoint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  since: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  firstRun: false,
  measured: true,
  commits: [{ sha: 'cccccccc11', subject: 'teammate: add billing export' }],
  changedPaths: ['src/billing/export.ts'],
  commitsOmitted: 0,
  pathsOmitted: 0,
  reason: null,
  hasKbDir: true,
  knowledgeDiffArtifactPath: '/tmp/.haive/external-kb-diff.json',
  ...over,
});

const CHANGES = { changes: [{ file: 'billing.md', op: 'update', summary: 'export added' }] };

async function apply(
  d: ExternalKbSyncDetect,
  args: Partial<StepApplyArgs<ExternalKbSyncDetect>>,
  db: Database,
) {
  return externalKbSyncStep.apply(ctx(db), {
    detected: d,
    formValues: {},
    ...args,
  } as StepApplyArgs<ExternalKbSyncDetect>);
}

describe('parseKbChanges', () => {
  it('reads the agent contract, from a string or an object', () => {
    expect(parseKbChanges(CHANGES)).toEqual([
      { file: 'billing.md', op: 'update', summary: 'export added' },
    ]);
    expect(parseKbChanges('```json\n' + JSON.stringify(CHANGES) + '\n```')).toHaveLength(1);
  });

  it('drops an entry with no file rather than inventing a path', () => {
    // A guessed KB path is a write to the wrong document, so a nameless op is not
    // repaired into one — it is dropped.
    expect(parseKbChanges({ changes: [{ op: 'update', summary: 'x' }, { file: '' }] })).toEqual([]);
  });

  it('is empty for anything that is not the contract', () => {
    for (const bad of [null, undefined, 'not json', {}, { changes: 'nope' }]) {
      expect(parseKbChanges(bad)).toEqual([]);
    }
  });
});

describe('form', () => {
  const form = (d: ExternalKbSyncDetect, out: unknown) =>
    externalKbSyncStep.form?.(ctx(fakeDb().db), d, out) ?? null;

  it('does not park when nothing landed outside the workflow', () => {
    expect(form(detect({ commits: [] }), CHANGES)).toBeNull();
  });

  it('does not park when the agent proposed nothing', () => {
    // The normal outcome for commits that changed no behaviour the KB describes. Parking
    // here would ask the developer to confirm that nothing happened.
    expect(form(detect(), { changes: [] })).toBeNull();
  });

  it('shows the commits and states a cap it applied', () => {
    const schema = form(detect({ commitsOmitted: 12 }), CHANGES);
    expect(schema?.description).toContain('teammate: add billing export');
    expect(schema?.description).toContain('+12');
    expect(schema?.fields.map((f) => f.id)).toEqual(['applyKbSync', 'commitMessage']);
  });
});

describe('apply', () => {
  it('does not stamp a watermark when the range could not be measured', async () => {
    const { db, stamps } = fakeDb();
    const out = await apply(detect({ measured: false, commits: [] }), {}, db);
    expect(out.decision).toBe('not_measured');
    expect(out.reviewedThrough).toBeNull();
    // The load-bearing assertion: "could not tell" must never advance the watermark, or
    // commits nobody saw are marked reviewed.
    expect(stamps).toHaveLength(0);
  });

  it('starts tracking without reviewing history on a first run', async () => {
    const { db, stamps } = fakeDb();
    const out = await apply(detect({ firstRun: true, since: null, commits: [] }), {}, db);
    expect(out.decision).toBe('tracking_started');
    expect(stamps[0]?.kbSyncedCommit).toBe(detect().branchPoint);
  });

  it('stamps when there was genuinely nothing external to review', async () => {
    const { db, stamps } = fakeDb();
    const out = await apply(
      detect({ commits: [], reason: 'every commit in this range was made by Haive' }),
      {},
      db,
    );
    expect(out.decision).toBe('nothing_to_review');
    expect(stamps).toHaveLength(1);
  });

  it('reverts and still stamps when the developer declines', async () => {
    const { db, stamps } = fakeDb();
    const dir = await scratch();
    const out = await apply(
      detect({ worktreePath: dir }),
      { llmOutput: CHANGES, formValues: { applyKbSync: false } },
      db,
    );
    expect(out.decision).toBe('declined');
    // A person was shown these commits and decided against them; that is a review, and
    // re-asking every future task about the same range is the nagging failure mode.
    expect(stamps[0]?.kbSyncedCommit).toBe(detect().branchPoint);
  });

  it('treats an absent tick as a decline only when there was something to accept', async () => {
    const { db, stamps } = fakeDb();
    // No form parks when the agent proposed nothing, so an empty formValues here means
    // "nothing to accept", not "the user said no".
    const out = await apply(detect(), { llmOutput: { changes: [] }, formValues: {} }, db);
    expect(out.decision).toBe('applied');
    expect(out.committed).toBe(false);
    expect(stamps).toHaveLength(1);
  });
});

describe('detect', () => {
  it('reads and writes the tree the drift was MEASURED in, not ctx.workspacePath', async () => {
    // `ctx.workspacePath` is only the fallback for a task with no worktree (11b and 11c
    // both resolve it the long way). Using it here would measure drift in the worktree and
    // then commit the parent checkout — finding nothing to commit and leaving the agent's
    // edits for 11-phase-8-learning's revertKbSync to destroy at index 11, which is the
    // exact failure this step exists to prevent.
    const out = await externalKbSyncStep.detect(ctx(fakeDb().db));
    expect(out.worktreePath).toBe('/sentinel/worktree');
    expect(out.worktreePath).not.toBe('/tmp');
  });
});
