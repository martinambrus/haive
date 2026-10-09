import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
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
    expect(match(or(eq(t.taskId, TASK), eq(t.taskId, TASK2)))).toEqual(['a.md', 'b.md']);
    expect(
      match(and(or(eq(t.taskId, TASK2), isNull(t.expandedFromId)), isNotNull(t.expandedFromId))),
    ).toEqual(['b.md']);

    for (const cond of [like(t.filename, 'a%'), eq(schema.tasks.id, TASK), inArray(t.id, [])]) {
      expect(() => fake.compileWhere(t, cond)).toThrow(/unsupported condition/);
    }
    expect(() => fake.compileWhere(t, eq(t.id, 'nope'))).toThrow(
      /invalid input syntax for type uuid/,
    );
  });

  it('never matches a NULL with a comparison or an exclusion, as Postgres does not', () => {
    const { fake, row } = setup();
    const a = fake.insert(t, row('a.md', { sizeBytes: 1 }));
    fake.insert(t, row('b.md', { sizeBytes: 5, description: 'kept', expandedFromId: a.id }));
    const match = (cond: unknown): unknown[] =>
      fake
        .rows(t)
        .filter(fake.compileWhere(t, cond))
        .map((r) => r.filename);

    expect(match(gt(t.sizeBytes, 1))).toEqual(['b.md']);
    expect(match(gt(t.sizeBytes, 0))).toEqual(['a.md', 'b.md']);
    expect(match(ne(t.filename, 'a.md'))).toEqual(['b.md']);
    expect(match(ne(t.description, 'other'))).toEqual(['b.md']);
    expect(match(notInArray(t.filename, ['b.md', 'c.md']))).toEqual(['a.md']);
    expect(match(notInArray(t.expandedFromId, [TASK]))).toEqual(['b.md']);
    expect(() => fake.compileWhere(t, notInArray(t.filename, []))).toThrow(/unsupported condition/);

    // JavaScript reads `null > -1` as true.
    const capped = fake
      .rows(schema.tasks)
      .filter(fake.compileWhere(schema.tasks, gt(schema.tasks.memoryLimitMb, -1)));
    expect(capped).toEqual([]);
  });

  it('increments a column in an update and projects what it returns', async () => {
    const { fake, row } = setup();
    const a = fake.insert(t, row('a.md', { sizeBytes: 3 }));
    fake.insert(t, row('b.md', { sizeBytes: 7 }));

    const back = await fake.db
      .update(t)
      .set({ sizeBytes: sql`${t.sizeBytes} + 1`, description: 'bumped' })
      .where(eq(t.id, a.id as string))
      .returning({ size: t.sizeBytes });

    expect(back).toEqual([{ size: 4 }]);
    expect(fake.rows(t).map((r) => [r.sizeBytes, r.description])).toEqual([
      [4, 'bumped'],
      [7, null],
    ]);
    // Another table's column is not this row's to read.
    const other = sql`${schema.tasks.orchestrationEpoch} + 1`;
    await fake.db
      .update(t)
      .set({ sizeBytes: other })
      .where(eq(t.id, a.id as string));
    expect(fake.rows(t)[0]!.sizeBytes).toBe(other);
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

  it('reads a columns option as Drizzle does: any true selects only those, all false the rest', async () => {
    const { fake, row } = setup();
    fake.insert(t, row('a.md', { description: 'about a' }));
    const read = (columns: Record<string, boolean | undefined>) =>
      fake.db.query.taskAttachments.findMany({ columns });
    const every = Object.keys(getTableColumns(t));

    expect(await read({ filename: true })).toEqual([{ filename: 'a.md' }]);
    expect(await read({ filename: true, description: false })).toEqual([{ filename: 'a.md' }]);
    expect(await read({ filename: true, description: undefined })).toEqual([{ filename: 'a.md' }]);

    const [rest] = await read({ storedPath: false, description: false });
    expect(Object.keys(rest!)).toEqual(
      every.filter((k) => !['storedPath', 'description'].includes(k)),
    );
    expect(rest).toMatchObject({ filename: 'a.md', taskId: TASK });
  });

  it('orders by an array of orders, the first the primary', async () => {
    const { fake, row } = setup();
    fake.insert(t, row('small.md', { sizeBytes: 1 }));
    fake.insert(t, row('b.md', { sizeBytes: 5 }));
    fake.insert(t, row('a.md', { sizeBytes: 5 }));
    const names = async (orderBy: unknown[]) =>
      (await fake.db.query.taskAttachments.findMany({ orderBy })).map((r) => r.filename);

    expect(await names([desc(t.sizeBytes)])).toEqual(['b.md', 'a.md', 'small.md']);
    expect(await names([asc(t.sizeBytes), desc(t.createdAt)])).toEqual([
      'small.md',
      'a.md',
      'b.md',
    ]);
    expect(await names([desc(t.createdAt), asc(t.sizeBytes)])).toEqual([
      'a.md',
      'b.md',
      'small.md',
    ]);
  });

  it('orders a select by every argument of orderBy, the first the primary', async () => {
    const { fake, row } = setup();
    fake.insert(t, row('small.md', { sizeBytes: 1 }));
    fake.insert(t, row('b.md', { sizeBytes: 5 }));
    fake.insert(t, row('a.md', { sizeBytes: 5 }));
    const names = async (...orders: unknown[]) => {
      const rows = await fake.db
        .select()
        .from(t)
        .orderBy(...orders);
      return rows.map((r) => r.filename);
    };

    expect(await names(desc(t.sizeBytes), desc(t.createdAt))).toEqual(['a.md', 'b.md', 'small.md']);
    expect(await names(desc(t.sizeBytes), asc(t.createdAt))).toEqual(['b.md', 'a.md', 'small.md']);
  });

  it('orders text the way the deployed en_US.utf8 collation does', async () => {
    const { fake, row } = setup();
    // The order Postgres 18 returns for these names under en_US.utf8.
    const ascending = [
      '10.md',
      '9.md',
      'a b.md',
      'a-b.md',
      'ab.md',
      'a.md',
      'b.md',
      'B.md',
      'e.md',
      'é.md',
      'file.md',
      'File.md',
      '～.md',
      '😀.md',
      '_x.md',
      'x.md',
    ];
    for (const name of [...ascending].reverse()) fake.insert(t, row(name));
    const names = async (order: unknown) =>
      (await fake.db.select().from(t).orderBy(order)).map((r) => r.filename);

    expect(await names(asc(t.filename))).toEqual(ascending);
    expect(await names(desc(t.filename))).toEqual([...ascending].reverse());
  });

  it('breaks a tie on a text second key', async () => {
    const { fake, row } = setup();
    fake.insert(t, row('b.md', { sizeBytes: 5 }));
    fake.insert(t, row('c.md', { sizeBytes: 5 }));
    fake.insert(t, row('a.md', { sizeBytes: 5 }));
    fake.insert(t, row('z.md', { sizeBytes: 1 }));
    const names = async (...orders: unknown[]) => {
      const rows = await fake.db
        .select()
        .from(t)
        .orderBy(...orders);
      return rows.map((r) => r.filename);
    };

    expect(await names(asc(t.sizeBytes), asc(t.filename))).toEqual([
      'z.md',
      'a.md',
      'b.md',
      'c.md',
    ]);
    expect(await names(desc(t.sizeBytes), desc(t.filename))).toEqual([
      'c.md',
      'b.md',
      'a.md',
      'z.md',
    ]);
    expect(await names(desc(t.sizeBytes), asc(t.filename))).toEqual([
      'a.md',
      'b.md',
      'c.md',
      'z.md',
    ]);
  });

  it('puts a NULL after every value ascending and before every value descending, as Postgres does', async () => {
    const { fake, row } = setup();
    fake.insert(t, row('null.md'));
    fake.insert(t, row('x.md', { description: 'x' }));
    fake.insert(t, row('undefined.md', { description: undefined }));
    fake.insert(t, row('a.md', { description: 'a' }));
    const names = async (order: unknown) =>
      (await fake.db.select().from(t).orderBy(order)).map((r) => r.filename);

    expect(await names(asc(t.description))).toEqual(['a.md', 'x.md', 'null.md', 'undefined.md']);
    expect(await names(desc(t.description))).toEqual(['null.md', 'undefined.md', 'x.md', 'a.md']);

    for (const [n, limit] of [
      [3, 512],
      [4, null],
      [5, 256],
    ] as const) {
      fake.insert(schema.tasks, {
        id: `00000000-0000-4000-8000-00000000000${n}`,
        userId: USER,
        type: 'workflow',
        title: 'limited',
        memoryLimitMb: limit,
      });
    }
    const limits = async (order: unknown) =>
      (
        await fake.db
          .select({ limit: schema.tasks.memoryLimitMb })
          .from(schema.tasks)
          .orderBy(order)
      ).map((r) => r.limit);

    expect(await limits(asc(schema.tasks.memoryLimitMb))).toEqual([256, 512, null, null, null]);
    expect(await limits(desc(schema.tasks.memoryLimitMb))).toEqual([null, null, null, 512, 256]);
  });

  it('orders numbers and bigints together by value', async () => {
    const { fake, row } = setup();
    fake.insert(t, row('ten.md', { sizeBytes: 10 }));
    fake.insert(t, row('nine.md', { sizeBytes: 9n }));
    fake.insert(t, row('two.md', { sizeBytes: 2 }));
    const names = async (order: unknown) =>
      (await fake.db.select().from(t).orderBy(order)).map((r) => r.filename);

    expect(await names(asc(t.sizeBytes))).toEqual(['two.md', 'nine.md', 'ten.md']);
    expect(await names(desc(t.sizeBytes))).toEqual(['ten.md', 'nine.md', 'two.md']);
  });

  it('orders booleans false before true, as Postgres does', async () => {
    const providers = schema.cliProviders;
    const fake = createFakeDb({ cliProviders: providers });
    fake.insert(providers, {
      id: '00000000-0000-4000-8000-0000000000b1',
      userId: USER,
      name: 'on',
      enabled: true,
    });
    fake.insert(providers, {
      id: '00000000-0000-4000-8000-0000000000b2',
      userId: USER,
      name: 'off',
      enabled: false,
    });
    const names = async (order: unknown) =>
      (await fake.db.select().from(providers).orderBy(order)).map((r) => r.name);

    expect(await names(asc(providers.enabled))).toEqual(['off', 'on']);
    expect(await names(desc(providers.enabled))).toEqual(['on', 'off']);
  });

  it('refuses a value it cannot order, whatever sits beside it', async () => {
    const { fake, row } = setup();
    fake.insert(t, row('a.md', { description: 'x' }));
    fake.insert(t, row('b.md', { description: 5 }));
    const mixed = fake.db.select().from(t).orderBy(asc(t.description));
    await expect(mixed).rejects.toThrow('fake db: unsupported orderBy value');

    fake.insert(schema.tasks, {
      id: '00000000-0000-4000-8000-000000000003',
      userId: USER,
      type: 'workflow',
      title: 'with metadata',
      metadata: { a: 1 },
    });
    const json = fake.db.select().from(schema.tasks).orderBy(asc(schema.tasks.metadata));
    await expect(json).rejects.toThrow('fake db: unsupported orderBy value');
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

  it('updates the row a conflict target matches, inserts otherwise, and rolls both back', async () => {
    const { fake, row, names } = setup();
    const upsert = (handle: FakeDbHandle, filename: string, sizeBytes: number) =>
      handle
        .insert(t)
        .values(row(filename, { sizeBytes }))
        .onConflictDoUpdate({ target: [t.taskId, t.filename], set: { sizeBytes } });

    await upsert(fake.db, 'a.md', 1);
    await upsert(fake.db, 'a.md', 2);
    await upsert(fake.db, 'b.md', 3);
    expect(fake.rows(t).map((r) => [r.filename, r.sizeBytes])).toEqual([
      ['a.md', 2],
      ['b.md', 3],
    ]);

    await expect(
      fake.db.transaction(async (tx) => {
        await upsert(tx, 'a.md', 9);
        await upsert(tx, 'c.md', 9);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(names()).toEqual(['a.md', 'b.md']);
    expect(fake.rows(t)[0]!.sizeBytes).toBe(2);
  });
});

describe('the timeouts a section sets on the fake', () => {
  const setTimeouts = (db: Database) => [
    db.execute(sql.raw(`SET LOCAL lock_timeout = '30000ms'`)),
    db.execute(sql.raw(`SET LOCAL statement_timeout = '3000ms'`)),
  ];

  it('accepts a lock timeout and a statement timeout inside a transaction', async () => {
    const { db } = setup();
    await db.transaction(async (tx) => {
      await Promise.all(setTimeouts(tx as unknown as Database));
    });
  });

  it('refuses either outside one, since SET LOCAL means nothing there', async () => {
    const { db } = setup();
    for (const attempt of setTimeouts(db)) {
      await expect(attempt).rejects.toThrow('fake db: unsupported execute');
    }
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
