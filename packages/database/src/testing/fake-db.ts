import { randomUUID } from 'node:crypto';
import { Column, getTableColumns, getTableName, is, Param, SQL, StringChunk } from 'drizzle-orm';
import { getTableConfig, PgUUID, type PgTable } from 'drizzle-orm/pg-core';

/**
 * An in-memory stand-in for the drizzle handle, for TESTS of code that reads and writes a handful
 * of tables. Not used by production code; it lives here so the api and the worker test the same
 * contract instead of each growing a stub of its own.
 *
 * It evaluates `where` rather than ignoring it, because the code under test rides on it: a
 * children lookup that ignored its filter would hand back a sibling archive's row and delete the
 * wrong folder. It supports exactly the conditions callers build — `and` of `eq` / `inArray` /
 * `isNull` / `isNotNull` — and throws on anything else, so a drizzle upgrade or a new query shape
 * fails loudly instead of matching every row. The foreign-key cascade is read off the schema.
 *
 * A transaction keeps an undo log, so a throw takes back exactly what IT wrote and a nested one is
 * a savepoint. There is no isolation: a write is visible to every reader the moment it is made,
 * committed or not, so a test that needs to observe an interleaving has to arrange it with the
 * hooks rather than rely on visibility. The attachments lock (`pg_advisory_xact_lock`) is a real
 * per-key mutex, re-entrant within one transaction chain and released when the outermost
 * transaction settles, which is what lets a test race two writers.
 */

export type FakeRow = Record<string, unknown>;
type Pred = (row: FakeRow) => boolean;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_SQL = /^select pg_advisory_xact_lock\(hashtextextended\($/;

function text(chunk: unknown): string | null {
  return chunk instanceof StringChunk ? chunk.value.join('') : null;
}

function columnKeys(table: PgTable): Map<unknown, string> {
  return new Map(Object.entries(getTableColumns(table)).map(([key, col]) => [col, key]));
}

interface Lazy<T> extends PromiseLike<T> {
  catch<B>(bad: (e: unknown) => B | PromiseLike<B>): Promise<T | B>;
  returning(): Promise<T>;
}

/** A drizzle-style builder that runs once, when it is awaited, and can also be asked `returning()`. */
function lazy<T>(run: () => T | Promise<T>): Lazy<T> {
  let done: Promise<T> | null = null;
  const go = (): Promise<T> => (done ??= Promise.resolve().then(run));
  return {
    then: (ok, bad) => go().then(ok, bad),
    catch: (bad) => go().catch(bad),
    returning: () => go(),
  };
}

/** One transaction chain: the locks its outermost transaction holds, and one undo log per level. */
interface TxContext {
  held: Map<string, () => void>;
  frames: (() => void)[][];
}

export interface FakeTableApi {
  findFirst(opts?: Record<string, unknown>): Promise<FakeRow | undefined>;
  findMany(opts?: Record<string, unknown>): Promise<FakeRow[]>;
}

interface SelectQuery extends PromiseLike<FakeRow[]> {
  where(cond: unknown): SelectQuery;
  orderBy(order: unknown): SelectQuery;
  limit(n: number): SelectQuery;
}

/** The handle a test casts to `Database`, and the transaction a section receives. */
export interface FakeDbHandle<Q extends string = string> {
  query: Record<Q, FakeTableApi>;
  select(fields?: Record<string, unknown>): { from(table: PgTable): SelectQuery };
  insert(table: PgTable): { values(values: FakeRow | FakeRow[]): Lazy<FakeRow[]> };
  update(table: PgTable): { set(values: FakeRow): { where(cond: unknown): Lazy<FakeRow[]> } };
  delete(table: PgTable): { where(cond: unknown): Lazy<void> };
  execute(query: unknown): Promise<void>;
  transaction<R>(fn: (tx: FakeDbHandle<Q>) => Promise<R>): Promise<R>;
}

export function createFakeDb<const T extends Record<string, PgTable>>(tables: T) {
  const list = Object.values(tables);
  const store = new Map<PgTable, FakeRow[]>(list.map((t) => [t, []]));
  /** Insertion order, so a row a rollback puts back returns to where it was. */
  const seq = new WeakMap<FakeRow, number>();
  let inserted = 0;
  let tick = 0;
  const now = (): Date => new Date(Date.UTC(2026, 1, 1) + (tick += 1) * 1000);
  const lockTails = new Map<string, Promise<void>>();

  /** Test-side only: points a test can stop at to arrange an interleaving. */
  const hooks: {
    /** Awaited before a transaction asks for the attachments lock, with the lock's key. */
    beforeLock: ((key: string) => void | Promise<void>) | null;
    /** Awaited before a delete removes its rows. */
    beforeDelete: (() => void | Promise<void>) | null;
  } = { beforeLock: null, beforeDelete: null };

  const checkValue = (col: Column, value: unknown): unknown => {
    if (is(col, PgUUID) && typeof value === 'string' && !UUID.test(value)) {
      throw new Error(`invalid input syntax for type uuid: "${value}"`);
    }
    return value;
  };

  function compileWhere(table: PgTable, cond: unknown): Pred {
    const keyOf = columnKeys(table);
    const refuse = (): never => {
      throw new Error(`fake db: unsupported condition on ${getTableName(table)}`);
    };
    const compile = (node: unknown): Pred => {
      if (!is(node, SQL)) return refuse();
      const ch = node.queryChunks.filter((c) => text(c) !== '');
      if (ch.length === 1) return compile(ch[0]);
      if (ch.length === 3 && text(ch[0]) === '(' && text(ch[2]) === ')') return compile(ch[1]);
      if (
        ch.length >= 3 &&
        ch.length % 2 === 1 &&
        ch.every((c, i) => (i % 2 === 1 ? text(c) === ' and ' : is(c, SQL)))
      ) {
        const parts = ch.filter((_, i) => i % 2 === 0).map(compile);
        return (row) => parts.every((part) => part(row));
      }
      const [col, op, val] = ch;
      const key = is(col, Column) ? keyOf.get(col) : undefined;
      if (key !== undefined && is(col, Column)) {
        if (ch.length === 2 && text(op) === ' is null') return (row) => row[key] == null;
        if (ch.length === 2 && text(op) === ' is not null') return (row) => row[key] != null;
        if (ch.length === 3 && text(op) === ' = ' && is(val, Param)) {
          const v = checkValue(col, val.value);
          return (row) => row[key] === v;
        }
        if (
          ch.length === 3 &&
          text(op) === ' in ' &&
          Array.isArray(val) &&
          val.every((p) => is(p, Param))
        ) {
          const vs = new Set(val.map((p) => checkValue(col, (p as Param).value)));
          return (row) => vs.has(row[key]);
        }
      }
      return refuse();
    };
    return compile(cond);
  }

  function sortBy(table: PgTable, rows: FakeRow[], order: unknown): FakeRow[] {
    const ch = is(order, SQL) ? order.queryChunks.filter((c) => text(c) !== '') : [];
    const key = is(ch[0], Column) ? columnKeys(table).get(ch[0]) : undefined;
    const dir = text(ch[1]);
    if (ch.length !== 2 || key === undefined || (dir !== ' asc' && dir !== ' desc')) {
      throw new Error(`fake db: unsupported orderBy on ${getTableName(table)}`);
    }
    const sign = dir === ' asc' ? 1 : -1;
    const value = (row: FakeRow): number => {
      const v = row[key];
      return v instanceof Date ? v.getTime() : Number(v);
    };
    return [...rows].sort((a, b) => sign * (value(a) - value(b)));
  }

  function select(table: PgTable, opts: Record<string, unknown> = {}): FakeRow[] {
    for (const k of Object.keys(opts)) {
      if (!['where', 'orderBy', 'columns', 'limit'].includes(k)) {
        throw new Error(`fake db: unsupported option "${k}"`);
      }
    }
    const pred = opts.where === undefined ? () => true : compileWhere(table, opts.where);
    let rows = store.get(table)!.filter(pred);
    if (opts.orderBy !== undefined) rows = sortBy(table, rows, opts.orderBy);
    if (typeof opts.limit === 'number') rows = rows.slice(0, opts.limit);
    const columns = opts.columns as Record<string, boolean> | undefined;
    return rows.map((row) =>
      columns ? Object.fromEntries(Object.keys(columns).map((k) => [k, row[k]])) : { ...row },
    );
  }

  /** `select({ alias: column, … }).from(table)`, projected onto the aliases; all columns without. */
  function selectQuery(fields: Record<string, unknown> | undefined, table: PgTable): SelectQuery {
    const keyOf = columnKeys(table);
    const opts: Record<string, unknown> = {};
    const run = (): FakeRow[] =>
      select(table, opts).map((row) =>
        fields === undefined
          ? row
          : Object.fromEntries(
              Object.entries(fields).map(([alias, col]) => {
                const key = keyOf.get(col);
                if (key === undefined) {
                  throw new Error(`fake db: "${alias}" is not a column of ${getTableName(table)}`);
                }
                return [alias, row[key]];
              }),
            ),
      );
    const query: SelectQuery = {
      where: (cond) => ((opts.where = cond), query),
      orderBy: (order) => ((opts.orderBy = order), query),
      limit: (n) => ((opts.limit = n), query),
      then: (ok, bad) => Promise.resolve().then(run).then(ok, bad),
    };
    return query;
  }

  /** Where a write records how to take itself back: the innermost open level of its transaction,
   *  or nowhere for an autocommit write. Asked BEFORE the write, so a transaction handle used after
   *  its transaction ended fails without changing anything, as the driver would refuse it. */
  function undoLog(ctx: TxContext | null): (() => void)[] | null {
    if (ctx === null) return null;
    const frame = ctx.frames.at(-1);
    if (!frame) throw new Error('fake db: a transaction was used after it ended');
    return frame;
  }

  function insertRow(ctx: TxContext | null, table: PgTable, values: FakeRow): FakeRow {
    const cols = getTableColumns(table);
    for (const k of Object.keys(values)) {
      if (!(k in cols)) throw new Error(`fake db: ${getTableName(table)} has no column "${k}"`);
      const col = cols[k];
      if (col) checkValue(col, values[k]);
    }
    const log = undoLog(ctx);
    const row: FakeRow = Object.fromEntries(Object.keys(cols).map((k) => [k, null]));
    Object.assign(row, { id: randomUUID() }, 'createdAt' in cols ? { createdAt: now() } : {});
    Object.assign(row, values);
    if (store.get(table)!.some((r) => r.id === row.id)) {
      throw new Error(`fake db: duplicate key on ${getTableName(table)}`);
    }
    seq.set(row, (inserted += 1));
    store.get(table)!.push(row);
    log?.push(() =>
      store.set(
        table,
        store.get(table)!.filter((r) => r !== row),
      ),
    );
    return { ...row };
  }

  function update(ctx: TxContext | null, table: PgTable, match: Pred, values: FakeRow): FakeRow[] {
    const cols = getTableColumns(table);
    for (const k of Object.keys(values)) {
      if (!(k in cols)) throw new Error(`fake db: ${getTableName(table)} has no column "${k}"`);
    }
    const log = undoLog(ctx);
    const hit = store.get(table)!.filter(match);
    for (const row of hit) {
      const before = Object.fromEntries(Object.keys(values).map((k) => [k, row[k]]));
      Object.assign(row, values);
      log?.push(() => Object.assign(row, before));
    }
    return hit.map((row) => ({ ...row }));
  }

  function remove(ctx: TxContext | null, table: PgTable, match: Pred): void {
    const log = undoLog(ctx);
    const rows = store.get(table)!;
    const gone = rows.filter(match);
    store.set(
      table,
      rows.filter((r) => !match(r)),
    );
    log?.push(() =>
      store.set(
        table,
        [...store.get(table)!, ...gone].sort((a, b) => seq.get(a)! - seq.get(b)!),
      ),
    );
    for (const child of list) {
      for (const fk of getTableConfig(child).foreignKeys) {
        const { columns, foreignColumns } = fk.reference();
        const col = columns[0];
        const ref = foreignColumns[0];
        if (fk.onDelete !== 'cascade' || !col || !ref || ref.table !== table) continue;
        const refKey = columnKeys(table).get(ref)!;
        const childKey = columnKeys(child).get(col)!;
        const ids = new Set(gone.map((r) => r[refKey]));
        if (ids.size > 0) remove(ctx, child, (r) => ids.has(r[childKey]));
      }
    }
  }

  /** Test-side setup only: change a stored row in place. */
  function patch(table: PgTable, id: string, values: FakeRow): void {
    const row = store.get(table)!.find((r) => r.id === id);
    if (!row) throw new Error(`fake db: no ${getTableName(table)} row ${id}`);
    Object.assign(row, values);
  }

  async function acquire(ctx: TxContext, key: string): Promise<void> {
    if (ctx.held.has(key)) return;
    await hooks.beforeLock?.(key);
    const prev = lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    lockTails.set(
      key,
      prev.then(() => mine),
    );
    await prev;
    ctx.held.set(key, release);
  }

  const api = (table: PgTable): FakeTableApi => ({
    findFirst: async (opts) => select(table, opts)[0],
    findMany: async (opts) => select(table, opts),
  });

  function handle(ctx: TxContext | null): FakeDbHandle<Extract<keyof T, string>> {
    return {
      query: Object.fromEntries(
        Object.entries(tables).map(([name, t]) => [name, api(t)]),
      ) as Record<Extract<keyof T, string>, FakeTableApi>,
      select: (fields) => ({ from: (table) => selectQuery(fields, table) }),
      insert: (table: PgTable) => ({
        values: (values: FakeRow | FakeRow[]) =>
          lazy(() =>
            (Array.isArray(values) ? values : [values]).map((v) => insertRow(ctx, table, v)),
          ),
      }),
      update: (table: PgTable) => ({
        set: (values: FakeRow) => ({
          where: (cond: unknown) =>
            lazy(() => update(ctx, table, compileWhere(table, cond), values)),
        }),
      }),
      delete: (table: PgTable) => ({
        where: (cond: unknown) =>
          lazy(async () => {
            const match = compileWhere(table, cond);
            await hooks.beforeDelete?.();
            remove(ctx, table, match);
          }),
      }),
      /** Only the two statements the attachments lock issues, and only inside a transaction. */
      execute: async (query: unknown): Promise<void> => {
        undoLog(ctx);
        const chunks = is(query, SQL) ? query.queryChunks : [];
        const first = text(chunks[0]) ?? '';
        if (ctx !== null && chunks.length === 1 && first.startsWith('SET LOCAL lock_timeout'))
          return;
        if (
          ctx !== null &&
          chunks.length === 3 &&
          LOCK_SQL.test(first) &&
          typeof chunks[1] === 'string' &&
          text(chunks[2]) === ', 0))'
        ) {
          await acquire(ctx, chunks[1]);
          return;
        }
        throw new Error('fake db: unsupported execute');
      },
      transaction: async (fn) => {
        const chain: TxContext = ctx ?? { held: new Map(), frames: [] };
        const frame: (() => void)[] = [];
        chain.frames.push(frame);
        try {
          const result = await fn(handle(chain));
          chain.frames.pop();
          // A savepoint that is released hands its writes to the level above, which may still
          // roll them back.
          chain.frames.at(-1)?.push(...frame);
          return result;
        } catch (err) {
          chain.frames.pop();
          for (const undo of frame.reverse()) undo();
          throw err;
        } finally {
          if (ctx === null) {
            for (const release of chain.held.values()) release();
            chain.held.clear();
          }
        }
      },
    };
  }

  return {
    db: handle(null),
    hooks,
    /** Test-side setup: a committed row, as if written before the test began. */
    insert: (table: PgTable, values: FakeRow): FakeRow => insertRow(null, table, values),
    patch,
    rows: (table: PgTable): FakeRow[] => select(table, {}),
    compileWhere,
    now,
  };
}
