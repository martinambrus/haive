import { describe, expect, it } from 'vitest';
import { applyPlanPatch } from './apply-patch.js';
import { PlanPatchError } from './errors.js';

const NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** One plan node held in memory: a select returns it, an update merges into it. */
function fakeDb(version: number, afterUpdate?: (row: Record<string, unknown>) => void) {
  const row: Record<string, unknown> = {
    id: NODE,
    parentId: null,
    path: `/${NODE}/`,
    version,
    status: 'todo',
  };
  const tx = {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = [{ ...row }];
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          Object.assign(row, values);
          afterUpdate?.(row);
        },
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
  };
  return { db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never, row };
}

const OPTS = { repositoryId: 'repo-1', origin: 'user', requireExpectedVersion: true } as const;
const op = (fields: Record<string, unknown>) => ({ op: 'upsert', nodeRef: NODE, ...fields });

describe('applyPlanPatch node versions', () => {
  it('lets two upserts for one node expect the same version and applies both', async () => {
    const { db, row } = fakeDb(3);
    const out = await applyPlanPatch(
      db,
      { ops: [op({ status: 'done', expectedVersion: 3 }), op({ title: 'T', expectedVersion: 3 })] },
      OPTS,
    );
    expect(out.dropped).toEqual([]);
    expect(out.updated).toEqual([NODE]);
    expect(row).toMatchObject({ status: 'done', title: 'T', version: 5 });
  });

  it('conflicts on a version the node only reaches inside this patch', async () => {
    const { db } = fakeDb(3);
    const err = await applyPlanPatch(
      db,
      { ops: [op({ status: 'done', expectedVersion: 3 }), op({ title: 'T', expectedVersion: 4 })] },
      OPTS,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanPatchError);
    expect(err).toMatchObject({ kind: 'conflict' });
    expect((err as Error).message).toContain('expected version 4, found 3');
  });

  it('conflicts when someone else wrote the node between two of its ops', async () => {
    const { db } = fakeDb(3, (row) => {
      if (row.version === 4) row.version = 5;
    });
    const err = await applyPlanPatch(
      db,
      { ops: [op({ status: 'done', expectedVersion: 3 }), op({ title: 'T', expectedVersion: 3 })] },
      OPTS,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'conflict' });
    expect((err as Error).message).toContain('expected version 3, found 5');
  });

  it('lets a later op land when an earlier op on the node was dropped before its write', async () => {
    const { db, row } = fakeDb(3);
    const out = await applyPlanPatch(
      db,
      {
        ops: [
          op({ status: 'done', parentRef: 'tmp-parent', expectedVersion: 3 }),
          op({ title: 'T', expectedVersion: 3 }),
          { op: 'upsert', nodeRef: 'tmp-parent', parentRef: NODE, title: 'Parent' },
        ],
      },
      { ...OPTS, onUnresolvableRef: 'drop' },
    );
    expect(out.dropped).toHaveLength(1);
    expect(row).toMatchObject({ title: 'T', version: 4 });
  });

  it('still conflicts on a single stale op', async () => {
    const { db, row } = fakeDb(4);
    const err = await applyPlanPatch(
      db,
      { ops: [op({ status: 'done', expectedVersion: 3 })] },
      OPTS,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'conflict' });
    expect(row.version).toBe(4);
  });
});
