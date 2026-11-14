import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { applyPlanPatch } from './apply-patch.js';
import { PlanPatchError } from './errors.js';

const NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** One plan node held in memory: a select returns it, an update merges into it. */
function fakeDb(
  version: number,
  afterUpdate?: (row: Record<string, unknown>) => void,
  beforeUpdate?: (row: Record<string, unknown>) => void,
) {
  const row: Record<string, unknown> = {
    id: NODE,
    parentId: null,
    path: `/${NODE}/`,
    version,
    status: 'todo',
  };
  const tx = {
    execute: async () => undefined,
    select: () => ({
      from: () => ({
        where: () => {
          const rows = [{ ...row }];
          // `for` is the repository row a patch that creates a node locks first.
          return Object.assign(Promise.resolve(rows), {
            limit: async () => rows,
            for: async () => rows,
          });
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: SQL) => {
          // Evaluate the actual UPDATE's version bind, so a query with only an id
          // predicate cannot accidentally pass the concurrent-write control.
          const expected = new PgDialect().sqlToQuery(condition).params.at(-1);
          const write = async () => {
            beforeUpdate?.(row);
            if (typeof expected === 'number' && row.version !== expected) return [];
            Object.assign(row, values);
            afterUpdate?.(row);
            return [{ id: NODE }];
          };
          return {
            then: (resolve: (v: unknown) => unknown) => write().then(resolve),
            returning: write,
          };
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
  it('describes an unversioned CAS race using the read version, not a caller expectation', async () => {
    const { db } = fakeDb(3, undefined, (row) => {
      row.version = 4;
    });
    const err = await applyPlanPatch(
      db,
      { ops: [op({ ordinal: 2 })] },
      { repositoryId: 'repo-1', origin: 'user' },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'conflict' });
    expect((err as Error).message).toContain('read version 3');
    expect((err as Error).message).not.toContain('expected version');
  });
  it('compares the version atomically when an edit commits after the applier read', async () => {
    const { db, row } = fakeDb(3, undefined, (current) => {
      current.version = 4;
      current.body = 'Canvas edit';
    });
    await expect(
      applyPlanPatch(db, { ops: [op({ body: 'Agent change', expectedVersion: 3 })] }, OPTS),
    ).rejects.toMatchObject({ kind: 'conflict' });
    expect(row).toMatchObject({ version: 4, body: 'Canvas edit' });
  });

  it('refuses even an ordinal-only update when a chat requires every update version', async () => {
    const { db, row } = fakeDb(3);
    const out = await applyPlanPatch(
      db,
      { ops: [op({ ordinal: 2 })] },
      {
        ...OPTS,
        onUnresolvableRef: 'drop',
        requireAllUpdateVersions: true,
      },
    );
    expect(out.dropped).toHaveLength(1);
    expect(row.version).toBe(3);
  });

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
