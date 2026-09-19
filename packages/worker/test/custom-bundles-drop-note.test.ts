import { describe, expect, it } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  customBundlesStep,
  type CustomBundlesApply,
} from '../src/step-engine/steps/onboarding/06_3-custom-bundles.js';

type Row = Record<string, unknown>;

/** `apply` reads in a fixed order: the task's repository_id, then per bundle the bundle row through
 *  `query.customBundles.findFirst` and that bundle's items. The select stub answers from a queue in
 *  that order. `where` is awaited directly at one call site and followed by `.limit(1)` at another,
 *  so it returns a thenable that also carries `limit` — stubbing only one of the two shapes makes
 *  the other read as undefined rather than fail, which is the trap worth avoiding here. */
function makeCtx(bundleRow: Row | null, selectQueue: unknown[][]): StepContext {
  const queue = [...selectQueue];
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = queue.shift() ?? [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>;
          };
          p.limit = async () => rows;
          return p;
        },
      }),
    }),
    query: { customBundles: { findFirst: async () => bundleRow } },
  };
  const noop = (): void => undefined;
  return {
    taskId: 'task-1',
    taskStepId: 'ts-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    sandboxWorkdir: '/workspace',
    cliProviderId: null,
    db,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    signal: new AbortController().signal,
    emitProgress: async () => undefined,
    throwIfCancelled: noop,
  } as unknown as StepContext;
}

function applyArgs(bundleIds: string[]) {
  return {
    detected: { initialBundles: [], credentialOptions: [], repositoryId: 'repo-1' },
    formValues: { bundles: bundleIds.map((id) => ({ id })) },
    iteration: 0,
    previousIterations: [],
  } as never;
}

const READS = [[{ repositoryId: 'repo-1' }], [{ kind: 'agent' }]];

const baseRow: Row = {
  id: 'bundle-1',
  name: 'curated',
  sourceType: 'zip',
  enabledKinds: ['agent', 'skill'],
  status: 'active',
  lastSyncError: null,
  lastSyncNote: null,
};

describe('06_3-custom-bundles: extraction drop report', () => {
  it('surfaces a dropped-member note on an ACTIVE bundle as the step degradedNote', async () => {
    const note = '2 archive member(s) were not extracted (2 symlink(s)): a.md, b.md';
    const ctx = makeCtx({ ...baseRow, lastSyncNote: note }, READS);
    const out = (await customBundlesStep.apply!(
      ctx,
      applyArgs(['bundle-1']),
    )) as CustomBundlesApply;

    // The bundle is usable — a drop is not a failure — and the note still reaches the person.
    // `warnings` alone would not: it has no reader in api or web.
    expect(out.bundles[0]?.status).toBe('active');
    expect(out.degradedNote).toContain(note);
    expect(out.warnings.some((w) => w.includes(note))).toBe(true);
  });

  it('states no degradedNote when nothing was dropped', async () => {
    const ctx = makeCtx(baseRow, READS);
    const out = (await customBundlesStep.apply!(
      ctx,
      applyArgs(['bundle-1']),
    )) as CustomBundlesApply;

    // Absent rather than an empty string: computeDegradedNote lifts the first non-empty stated
    // value, so an empty one would be indistinguishable from "this step never degraded".
    expect(out.degradedNote).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  it('keeps a drop note separate from a sync FAILURE', async () => {
    // The two channels are independent: a failed bundle reports its error, and only the drop note
    // becomes the degradedNote. Borrowing last_sync_error for drops is what would have rendered a
    // working bundle as a broken one.
    const ctx = makeCtx(
      { ...baseRow, status: 'failed', lastSyncError: 'boom', lastSyncNote: 'dropped 1 symlink(s)' },
      READS,
    );
    const out = (await customBundlesStep.apply!(
      ctx,
      applyArgs(['bundle-1']),
    )) as CustomBundlesApply;

    expect(out.warnings.some((w) => w.includes('failed: boom'))).toBe(true);
    expect(out.degradedNote).toContain('dropped 1 symlink(s)');
    expect(out.degradedNote).not.toContain('boom');
  });
});
