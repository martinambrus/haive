import { and, asc, eq, inArray, isNotNull, isNull, like, or } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema, type Database } from '../src/index.js';
import { withTaskAttachmentsLock } from '../src/task-attachments-lock.js';
import { createFakeDb, type FakeDbHandle } from '../src/testing/fake-db.js';

/**
 * The fake's own contract. The api's attachment routes and the worker's plan-inputs step are tested
 * against it, so a fake that matched every row, kept a rolled-back write or let two sections in at
 * once would pass those tests while proving nothing about the code under them.
 */

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const TASK2 = '00000000-0000-4000-8000-000000000002';
const t = schema.taskAttachments;

function setup() {
  const fake = createFakeDb({ tasks: schema.tasks, taskAttachments: t });
  for (const id of [TASK, TASK2]) {
    fake.insert(schema.tasks, { id, userId: USER, type: 'workflow', title: 'task' });
  }
  const row = (filename: string, over: Record<string, unknown> = {}) => ({
    taskId: TASK,
    userId: USER,
    filename,
    storedPath: `/repo/.haive/task-uploads/${TASK}/${filename}`,
    sizeBytes: 1,
    ...over,
  });
  const names = (): unknown[] => fake.rows(t).map((r) => r.filename);
  return { fake, db: fake.db as unknown as Database, row, names };
}

describe('the fake database', () => {
  it('evaluates only the conditions it was built for', () => {
    const { fake, row } = setup();
    const a = fake.insert(t, row('a.md'));
    const b = fake.insert(t, row('b.md', { taskId: TASK2, expandedFromId: a.id }));
    const match = (cond: unknown): unknown[] =>
      fake
        .rows(t)
        .filter(fake.compileWhere(t, cond))
        .map((r) => r.filename);

    expect(match(and(eq(t.taskId, TASK), eq(t.userId, USER)))).toEqual(['a.md']);
    expect(match(inArray(t.id, [a.id as string, b.id as string]))).toEqual(['a.md', 'b.md']);
    expect(match(and(eq(t.id, b.id as string)))).toEqual(['b.md']);
    expect(match(isNull(t.expandedFromId))).toEqual(['a.md']);
    expect(match(and(eq(t.taskId, TASK2), isNotNull(t.expandedFromId)))).toEqual(['b.md']);

    for (const cond of [
      or(eq(t.taskId, TASK), eq(t.taskId, TASK2)),
      like(t.filename, 'a%'),
      eq(schema.tasks.id, TASK),
      inArray(t.id, []),
    ]) {
      expect(() => fake.compileWhere(t, cond)).toThrow(/unsupported condition/);
    }
    expect(() => fake.compileWhere(t, eq(t.id, 'nope'))).toThrow(
      /invalid input syntax for type uuid/,
    );
  });

  it('compares a json column by value, as Postgres compares jsonb, and never to NULL', () => {
    // A compare-and-set on a stored document hands back an object read earlier, which is equal to
    // the stored one without being it.
    const { fake } = setup();
    const doc = { a: 1, list: [1, 2], nested: { b: 'x' } };
    fake.insert(schema.tasks, {
      id: '00000000-0000-4000-8000-000000000003',
      userId: USER,
      type: 'workflow',
      title: 'with metadata',
      metadata: doc,
    });
    const matches = (value: Record<string, unknown>): number =>
      fake
        .rows(schema.tasks)
        .filter(fake.compileWhere(schema.tasks, eq(schema.tasks.metadata, value))).length;

    expect(matches(structuredClone(doc))).toBe(1);
    expect(matches({ nested: { b: 'x' }, list: [1, 2], a: 1 })).toBe(1);
    expect(matches({ ...doc, list: [2, 1] })).toBe(0);
    expect(matches({ ...doc, nested: { b: 'y' } })).toBe(0);
    // The column's type rules a NULL argument out; a value read back from a NULL column is one.
    expect(matches(null as unknown as Record<string, unknown>)).toBe(0);
  });

  it('projects a select onto the columns it names', async () => {
    const { fake, row } = setup();
    fake.insert(t, row('b.md'));
    fake.insert(t, row('a.md'));
    fake.insert(t, row('c.md', { taskId: TASK2 }));
    const rows = await fake.db
      .select({ name: t.filename })
      .from(t)
      .where(eq(t.taskId, TASK))
      .orderBy(asc(t.createdAt))
      .limit(1);
    expect(rows).toEqual([{ name: 'b.md' }]);
  });

  it('takes back exactly what a failed transaction wrote', async () => {
    const { fake, row, names } = setup();
    const keep = fake.insert(t, row('keep.md'));
    await expect(
      fake.db.transaction(async (tx) => {
        await tx.insert(t).values(row('new.md'));
        await tx
          .update(t)
          .set({ description: 'changed' })
          .where(eq(t.id, keep.id as string));
        await tx.delete(t).where(eq(t.id, keep.id as string));
        // Another connection's write, which the rollback must not take with it.
        await fake.db.insert(t).values(row('other.md'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(names()).toEqual(['keep.md', 'other.md']);
    expect(fake.rows(t)[0]!.description).toBeNull();
  });

  it('undoes a failed savepoint alone, and one released into a failed transaction with it', async () => {
    const { fake, row, names } = setup();
    await fake.db.transaction(async (tx) => {
      await tx.insert(t).values(row('outer.md'));
      await expect(
        tx.transaction(async (sp) => {
          await sp.insert(t).values(row('inner.md'));
          throw new Error('savepoint');
        }),
      ).rejects.toThrow('savepoint');
      await tx.transaction(async (sp) => {
        await sp.insert(t).values(row('kept.md'));
      });
    });
    expect(names()).toEqual(['outer.md', 'kept.md']);

    await expect(
      fake.db.transaction(async (tx) => {
        await tx.transaction(async (sp) => {
          await sp.insert(t).values(row('released.md'));
        });
        throw new Error('outer');
      }),
    ).rejects.toThrow('outer');
    expect(names()).toEqual(['outer.md', 'kept.md']);
  });

  it('refuses a transaction used after it ended, and changes nothing', async () => {
    const { fake, row } = setup();
    let ended: FakeDbHandle | undefined;
    await fake.db.transaction(async (tx) => {
      ended = tx;
    });
    await expect(ended!.insert(t).values(row('late.md'))).rejects.toThrow(/after it ended/);
    expect(fake.rows(t)).toEqual([]);
  });
});

describe('the attachments lock on the fake', () => {
  it('lets one section in at a time per task, and never blocks another task', async () => {
    const { fake, db } = setup();
    const keys: string[] = [];
    fake.hooks.beforeLock = (key) => {
      keys.push(key);
    };
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const firstIn = new Promise<void>((resolve) => (entered = resolve));

    const first = withTaskAttachmentsLock(db, TASK, async () => {
      order.push('first in');
      entered();
      await gate;
      order.push('first out');
    });
    await firstIn;
    const second = withTaskAttachmentsLock(db, TASK, async () => {
      order.push('second in');
    });
    await withTaskAttachmentsLock(db, TASK2, async () => {
      order.push('other task in');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first in', 'other task in']);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'other task in', 'first out', 'second in']);
    expect(keys).toEqual([
      `task-attachments:${TASK}`,
      `task-attachments:${TASK}`,
      `task-attachments:${TASK2}`,
    ]);
  });

  it('is taken again by a section that holds it, as a savepoint, and released after', async () => {
    const { db } = setup();
    const out = await withTaskAttachmentsLock(db, TASK, (tx) =>
      withTaskAttachmentsLock(tx, TASK, async () => 'nested'),
    );
    expect(out).toBe('nested');
    await expect(withTaskAttachmentsLock(db, TASK, async () => 'next')).resolves.toBe('next');
  });

  it('is released by a section that throws', async () => {
    const { db } = setup();
    await expect(
      withTaskAttachmentsLock(db, TASK, async () => {
        throw new Error('section');
      }),
    ).rejects.toThrow('section');
    await expect(withTaskAttachmentsLock(db, TASK, async () => 'next')).resolves.toBe('next');
  });
});
