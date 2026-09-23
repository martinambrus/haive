import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  and,
  Column,
  eq,
  getTableColumns,
  getTableName,
  inArray,
  is,
  isNull,
  like,
  or,
  Param,
  SQL,
  StringChunk,
} from 'drizzle-orm';
import { getTableConfig, PgUUID, type PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { attachmentRoutes } from '../src/routes/tasks/attachments.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// Uuid-shaped on purpose: every id lands in a uuid column, and the fake answers a malformed one the
// way Postgres does rather than with a quiet "not found".
const USER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const TASK = '00000000-0000-4000-8000-000000000001';
const TASK2 = '00000000-0000-4000-8000-000000000002';
const REPO = '00000000-0000-4000-8000-0000000000f1';

type Row = Record<string, unknown>;
type Pred = (row: Row) => boolean;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(chunk: unknown): string | null {
  return chunk instanceof StringChunk ? chunk.value.join('') : null;
}

function columnKeys(table: PgTable): Map<unknown, string> {
  return new Map(Object.entries(getTableColumns(table)).map(([key, col]) => [col, key]));
}

/**
 * An in-memory stand-in for the three tables the routes touch.
 *
 * It evaluates `where` rather than ignoring it, because the routes' correctness rides on it: the
 * delete-one children lookup that ignored its filter would hand back a sibling archive's row and
 * delete the wrong folder. It supports exactly the conditions the routes build — `and` of `eq` /
 * `inArray` — and throws on anything else, so a drizzle upgrade or a new query shape fails loudly
 * instead of matching every row. The foreign-key cascade is read off the schema, not restated.
 */
function createFakeDb() {
  const tables: PgTable[] = [schema.tasks, schema.repositories, schema.taskAttachments];
  const store = new Map<PgTable, Row[]>(tables.map((t) => [t, []]));
  let tick = 0;
  const now = (): Date => new Date(Date.UTC(2026, 1, 1) + (tick += 1) * 1000);

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
      const key = ch.length === 3 && is(col, Column) ? keyOf.get(col) : undefined;
      if (key !== undefined && is(col, Column)) {
        if (text(op) === ' = ' && is(val, Param)) {
          const v = checkValue(col, val.value);
          return (row) => row[key] === v;
        }
        if (text(op) === ' in ' && Array.isArray(val) && val.every((p) => is(p, Param))) {
          const vs = new Set(val.map((p) => checkValue(col, (p as Param).value)));
          return (row) => vs.has(row[key]);
        }
      }
      return refuse();
    };
    return compile(cond);
  }

  function sortBy(table: PgTable, rows: Row[], order: unknown): Row[] {
    const ch = is(order, SQL) ? order.queryChunks.filter((c) => text(c) !== '') : [];
    const key = is(ch[0], Column) ? columnKeys(table).get(ch[0]) : undefined;
    const dir = text(ch[1]);
    if (ch.length !== 2 || key === undefined || (dir !== ' asc' && dir !== ' desc')) {
      throw new Error(`fake db: unsupported orderBy on ${getTableName(table)}`);
    }
    const sign = dir === ' asc' ? 1 : -1;
    const value = (row: Row): number => {
      const v = row[key];
      return v instanceof Date ? v.getTime() : Number(v);
    };
    return [...rows].sort((a, b) => sign * (value(a) - value(b)));
  }

  function select(table: PgTable, opts: Record<string, unknown> = {}): Row[] {
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

  function insert(table: PgTable, values: Row): Row {
    const cols = getTableColumns(table);
    for (const k of Object.keys(values)) {
      if (!(k in cols)) throw new Error(`fake db: ${getTableName(table)} has no column "${k}"`);
    }
    const row: Row = Object.fromEntries(Object.keys(cols).map((k) => [k, null]));
    Object.assign(row, { id: randomUUID() }, 'createdAt' in cols ? { createdAt: now() } : {});
    Object.assign(row, values);
    store.get(table)!.push(row);
    return { ...row };
  }

  /** Test-side setup only: change a stored row in place. */
  function patch(table: PgTable, id: string, values: Row): void {
    const row = store.get(table)!.find((r) => r.id === id);
    if (!row) throw new Error(`fake db: no ${getTableName(table)} row ${id}`);
    Object.assign(row, values);
  }

  function remove(table: PgTable, match: Pred): void {
    const rows = store.get(table)!;
    const gone = rows.filter(match);
    store.set(
      table,
      rows.filter((r) => !match(r)),
    );
    for (const child of tables) {
      for (const fk of getTableConfig(child).foreignKeys) {
        const { columns, foreignColumns } = fk.reference();
        const col = columns[0];
        const ref = foreignColumns[0];
        if (fk.onDelete !== 'cascade' || !col || !ref || ref.table !== table) continue;
        const refKey = columnKeys(table).get(ref)!;
        const childKey = columnKeys(child).get(col)!;
        const ids = new Set(gone.map((r) => r[refKey]));
        if (ids.size > 0) remove(child, (r) => ids.has(r[childKey]));
      }
    }
  }

  const api = (table: PgTable) => ({
    findFirst: async (opts?: Record<string, unknown>) => select(table, opts)[0],
    findMany: async (opts?: Record<string, unknown>) => select(table, opts),
  });

  return {
    db: {
      query: {
        tasks: api(schema.tasks),
        repositories: api(schema.repositories),
        taskAttachments: api(schema.taskAttachments),
      },
      insert: (table: PgTable) => ({
        values: (values: Row) => ({ returning: async () => [insert(table, values)] }),
      }),
      delete: (table: PgTable) => ({
        where: async (cond: unknown) => remove(table, compileWhere(table, cond)),
      }),
    },
    insert,
    patch,
    rows: (table: PgTable): Row[] => select(table, {}),
    compileWhere,
    now,
  };
}

// `requireAuth` sets `userId` in the real app; here a header picks the caller, so a test can ask
// the same question as another user without module state leaking between tests.
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', c.req.header('x-test-user') ?? USER);
  await next();
});
app.route('/', attachmentRoutes);
app.onError(errorHandler);

describe('task attachment routes', () => {
  let storage: string;
  let outside: string;
  let repo: string;
  let fake: ReturnType<typeof createFakeDb>;
  let cap: number;

  const up = (rel = ''): string => path.join(repo, '.haive', 'task-uploads', TASK, rel);

  interface Sent {
    status: number;
    body: Record<string, unknown> | null;
  }

  async function send(
    method: string,
    route: string,
    opts: {
      as?: string;
      body?: string | Uint8Array | ReadableStream<Uint8Array>;
      type?: string;
    } = {},
  ): Promise<Sent> {
    const headers: Record<string, string> = {};
    if (opts.as) headers['x-test-user'] = opts.as;
    if (opts.body !== undefined) headers['content-type'] = opts.type ?? 'application/octet-stream';
    const res = await app.request(route, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: opts.body, duplex: 'half' as const } : {}),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null };
  }

  function upload(
    filename: string,
    body: string | Uint8Array | ReadableStream<Uint8Array> = 'x',
    opts: { description?: string; type?: string; as?: string; task?: string } = {},
  ): Promise<Sent> {
    const qs = new URLSearchParams({ filename });
    if (opts.description !== undefined) qs.set('description', opts.description);
    return send('POST', `/${opts.task ?? TASK}/attachments?${qs.toString()}`, {
      body,
      type: opts.type,
      as: opts.as,
    });
  }

  /** The only way a test reads `/raw`: the body is drained before anything is asserted, because on
   *  Node 26 a FileHandle the collector reclaims unclosed kills the run after every test passed. */
  async function download(
    id: string,
    opts: { as?: string; task?: string } = {},
  ): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
    const res = await app.request(`/${opts.task ?? TASK}/attachments/${id}/raw`, {
      headers: opts.as ? { 'x-test-user': opts.as } : {},
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, bytes };
  }

  function seedAttachment(filename: string, content: string, over: Row = {}): Row {
    return fake.insert(schema.taskAttachments, {
      taskId: TASK,
      userId: USER,
      filename,
      storedPath: up(filename),
      sizeBytes: Buffer.byteLength(content),
      ...over,
    });
  }

  async function seedFile(filename: string, content: string, over: Row = {}): Promise<Row> {
    await mkdir(path.dirname(up(filename)), { recursive: true });
    await writeFile(up(filename), content);
    return seedAttachment(filename, content, over);
  }

  /** What the worker's expansion leaves behind: the archive stamped, and each member a row pointing
   *  at it, placed at the uploads ROOT under the archive's stem (`docs/spec.zip` → `spec/…`). */
  async function seedArchive(filename: string, members: Record<string, string>): Promise<Row> {
    const archive = await seedFile(filename, 'PK', { expandedAt: fake.now() });
    for (const [member, content] of Object.entries(members)) {
      await seedFile(member, content, { expandedFromId: archive.id });
    }
    return archive;
  }

  /** A worker-written sidecar next to an original: a file with no row of its own. */
  async function plantSidecar(filename: string): Promise<void> {
    await writeFile(up(`${filename}.extracted.md`), `# ${filename}\n`);
  }

  /** The entries `_ATTACHMENTS.md` names, in order, or null when there is no index. */
  async function indexed(): Promise<string[] | null> {
    const body = await readFile(up('_ATTACHMENTS.md'), 'utf8').catch(() => null);
    return body === null ? null : [...body.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);
  }

  const filenames = (): unknown[] => fake.rows(schema.taskAttachments).map((r) => r.filename);
  const exists = (p: string): Promise<boolean> =>
    lstat(p).then(
      () => true,
      () => false,
    );
  const listing = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();
  const modeOf = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

  async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
    const previous = process.umask(mask);
    try {
      return await fn();
    } finally {
      process.umask(previous);
    }
  }

  const rootIt = process.getuid?.() === 0 ? it : it.skip;

  beforeEach(async () => {
    storage = await mkdtemp(path.join(tmpdir(), 'attach-routes-'));
    outside = await mkdtemp(path.join(tmpdir(), 'attach-out-'));
    repo = path.join(storage, USER, 'repo-1');
    await mkdir(repo, { recursive: true });

    fake = createFakeDb();
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      name: 'repo-1',
      source: 'clone',
      writable: true,
      storagePath: repo,
    });
    for (const id of [TASK, TASK2]) {
      fake.insert(schema.tasks, {
        id,
        userId: USER,
        repositoryId: REPO,
        type: 'workflow',
        title: 'task',
      });
    }
    h.db = fake.db;

    cap = 1024 * 1024;
    vi.spyOn(configService, 'getNumber').mockImplementation(async (key, fallback = 0) =>
      key === CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES ? cap : fallback,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(storage, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe('POST /:id/attachments', () => {
    it('stores a folder upload at its own path, records it, and indexes it', async () => {
      const res = await withUmask(0o077, () =>
        upload('docs/api/spec.md', 'hello', {
          description: 'the spec',
          type: 'text/markdown; charset=utf-8',
        }),
      );
      expect(res.status).toBe(201);
      const [row] = fake.rows(schema.taskAttachments);
      expect(res.body?.attachment).toEqual({
        id: row!.id,
        taskId: TASK,
        filename: 'docs/api/spec.md',
        sizeBytes: 5,
        contentType: 'text/markdown',
        description: 'the spec',
        createdAt: (row!.createdAt as Date).toISOString(),
        expandedAt: null,
        expansionNote: null,
        expandedFromId: null,
      });
      // The stored path has exactly this shape: the worker's expansion and every delete recover
      // the repository root by stripping it.
      expect(row).toMatchObject({
        userId: USER,
        expandedFromId: null,
        storedPath: path.join(repo, '.haive', 'task-uploads', TASK, 'docs/api/spec.md'),
      });
      expect(await readFile(up('docs/api/spec.md'), 'utf8')).toBe('hello');
      // Under a 0077 umask, so these modes can only come from the route's own explicit modes.
      expect(await modeOf(up('docs/api/spec.md'))).toBe(0o644);
      for (const dir of [
        path.join(repo, '.haive', 'task-uploads'),
        up(),
        up('docs'),
        up('docs/api'),
      ]) {
        expect(await modeOf(dir)).toBe(0o755);
      }
      expect(await indexed()).toEqual(['docs/api/spec.md']);
      expect(await readFile(up('_ATTACHMENTS.md'), 'utf8')).toContain(
        '- `docs/api/spec.md` — the spec',
      );
      expect(await modeOf(up('_ATTACHMENTS.md'))).toBe(0o644);
    });

    it('de-dupes within the file’s own folder, starting at (2)', async () => {
      const names: unknown[] = [];
      for (const [name, body] of [
        ['a.md', 'one'],
        ['a.md', 'two'],
        ['a.md', 'three'],
        ['docs/a.md', 'four'],
        ['README', 'five'],
        ['README', 'six'],
      ] as const) {
        const res = await upload(name, body);
        expect(res.status).toBe(201);
        names.push((res.body?.attachment as Row).filename);
      }
      expect(names).toEqual(['a.md', 'a (2).md', 'a (3).md', 'docs/a.md', 'README', 'README (2)']);
      expect(await readFile(up('a (2).md'), 'utf8')).toBe('two');
      expect(await readFile(up('a (3).md'), 'utf8')).toBe('three');
      expect(await readFile(up('docs/a.md'), 'utf8')).toBe('four');
      expect(await readFile(up('README (2)'), 'utf8')).toBe('six');
    });

    it('never takes a name the uploads dir generates, and only at its root', async () => {
      const names: unknown[] = [];
      for (const name of ['_ATTACHMENTS.md', '_PLAN_INPUTS.md', 'docs/_ATTACHMENTS.md']) {
        const res = await upload(name, 'mine');
        expect(res.status).toBe(201);
        names.push((res.body?.attachment as Row).filename);
      }
      expect(names).toEqual(['_ATTACHMENTS (2).md', '_PLAN_INPUTS (2).md', 'docs/_ATTACHMENTS.md']);
      expect(await readFile(up('_ATTACHMENTS (2).md'), 'utf8')).toBe('mine');
      // `_ATTACHMENTS.md` is still the index, not the user's file.
      expect(await indexed()).toEqual([
        '_ATTACHMENTS (2).md',
        '_PLAN_INPUTS (2).md',
        'docs/_ATTACHMENTS.md',
      ]);
      expect(await exists(up('_PLAN_INPUTS.md'))).toBe(false);
    });

    it('treats a link at the name as taken and writes nothing through it', async () => {
      await mkdir(up(), { recursive: true });
      await writeFile(path.join(outside, 'secret.md'), 'secret');
      await symlink(path.join(outside, 'planted.md'), up('a.md'));
      await symlink(path.join(outside, 'secret.md'), up('b.md'));

      const a = await upload('a.md', 'new a');
      const b = await upload('b.md', 'new b');
      expect((a.body?.attachment as Row).filename).toBe('a (2).md');
      expect((b.body?.attachment as Row).filename).toBe('b (2).md');
      expect(await exists(path.join(outside, 'planted.md'))).toBe(false);
      expect(await readFile(path.join(outside, 'secret.md'), 'utf8')).toBe('secret');
      expect((await lstat(up('a.md'))).isSymbolicLink()).toBe(true);
      expect((await lstat(up('b.md'))).isSymbolicLink()).toBe(true);
    });

    it('answers 413 past the cap, keeps nothing, and accepts exactly the cap', async () => {
      cap = 8;
      const over = await upload('a.bin', '123456789');
      expect(over).toEqual({
        status: 413,
        body: { error: 'attachment exceeds 8 bytes limit', code: null },
      });
      expect(await listing(up())).toEqual([]);
      expect(filenames()).toEqual([]);

      // The name the refused upload claimed was released.
      const fits = await upload('a.bin', '12345678');
      expect(fits.status).toBe(201);
      expect(fits.body?.attachment).toMatchObject({ filename: 'a.bin', sizeBytes: 8 });
    });

    it('releases the name when the body fails mid-stream', async () => {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(new TextEncoder().encode('partial'));
          else controller.error(new Error('client went away'));
        },
      });
      const res = await upload('a.md', body);
      expect(res).toEqual({
        status: 500,
        body: { error: 'attachment write failed: client went away', code: null },
      });
      // Only the end state: how many bytes reached the file before the error is timing.
      expect(await listing(up())).toEqual([]);
      expect(filenames()).toEqual([]);
      expect((await upload('a.md', 'whole')).body?.attachment).toMatchObject({ filename: 'a.md' });
    });

    it('never lets two concurrent uploads share a file', async () => {
      const [first, second] = await Promise.all([
        upload('a.md', 'first'),
        upload('a.md', 'second'),
      ]);
      expect(first?.status).toBe(201);
      expect(second?.status).toBe(201);
      const one = (first?.body?.attachment as Row).filename as string;
      const two = (second?.body?.attachment as Row).filename as string;
      expect(new Set([one, two])).toEqual(new Set(['a.md', 'a (2).md']));
      expect(await readFile(up(one), 'utf8')).toBe('first');
      expect(await readFile(up(two), 'utf8')).toBe('second');
    });

    it('refuses a name that climbs out of the uploads directory', async () => {
      const res = await upload('../x', 'escape');
      expect(res.status).toBe(400);
      expect(String(res.body?.error)).toContain('parent-directory');
      expect(filenames()).toEqual([]);
      // Refused before anything is created, not after the uploads directory was made for it.
      expect(await listing(repo)).toEqual([]);
    });

    it.each([
      [
        'a task with no repository',
        { repositoryId: null },
        null,
        'Task has no repository; cannot attach files',
      ],
      [
        'a repository row that is gone',
        { repositoryId: '00000000-0000-4000-8000-0000000000f9' },
        null,
        'Task repository not found',
      ],
      [
        'a read-only local repository',
        null,
        { source: 'local_path', writable: false },
        'Attachments are not supported for read-only local repositories',
      ],
      [
        'a repository with no storage yet',
        null,
        { storagePath: null },
        'Task repository is not ready yet',
      ],
    ] as const)('refuses %s before touching disk', async (_label, taskOver, repoOver, message) => {
      if (taskOver) fake.patch(schema.tasks, TASK, taskOver);
      if (repoOver) fake.patch(schema.repositories, REPO, repoOver);
      const res = await upload('a.md', 'x');
      expect(res).toEqual({ status: 409, body: { error: message, code: null } });
      expect(await listing(repo)).toEqual([]);
    });

    it('hands an existing restrictive level back as 0755', async () => {
      await mkdir(up('docs'), { recursive: true });
      for (const dir of [path.join(repo, '.haive', 'task-uploads'), up(), up('docs')]) {
        await chmod(dir, 0o700);
      }
      expect((await upload('docs/a.md', 'x')).status).toBe(201);
      for (const dir of [path.join(repo, '.haive', 'task-uploads'), up(), up('docs')]) {
        expect(await modeOf(dir)).toBe(0o755);
      }
    });

    it('refuses a folder that is a link, with a status and nothing written outside', async () => {
      await mkdir(up(), { recursive: true });
      await symlink(outside, up('docs'));
      expect(await upload('docs/a.md', 'x')).toEqual({
        status: 403,
        body: { error: 'Path is a symlink', code: null },
      });
      expect(await listing(outside)).toEqual([]);
      expect(filenames()).toEqual([]);
      expect(await indexed()).toBeNull();

      // The uploads directory itself swapped for a link is refused the same way.
      await rm(up(), { recursive: true });
      await symlink(outside, up());
      expect((await upload('b.md', 'x')).status).toBe(403);
      expect(await listing(outside)).toEqual([]);
    });

    it('answers 409 when a file already has the name a folder needs', async () => {
      expect((await upload('spec', 'the file')).status).toBe(201);
      expect(await upload('spec/a.md', 'x')).toEqual({
        status: 409,
        body: { error: 'A file already has the name of a folder in that path', code: null },
      });
      expect(await readFile(up('spec'), 'utf8')).toBe('the file');
      expect(filenames()).toEqual(['spec']);
    });

    it('validates the query before touching disk', async () => {
      const res = await send('POST', `/${TASK}/attachments`, { body: 'x' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'Validation failed' });
      expect((res.body?.issues as { path: string }[])[0]?.path).toBe('filename');
      expect(await listing(repo)).toEqual([]);
    });

    rootIt('hands what it creates to the sandbox uid', async () => {
      expect((await upload('docs/a.md', 'x')).status).toBe(201);
      for (const p of [
        path.join(repo, '.haive', 'task-uploads'),
        up(),
        up('docs'),
        up('docs/a.md'),
        up('_ATTACHMENTS.md'),
      ]) {
        const st = await stat(p);
        expect([st.uid, st.gid]).toEqual([1000, 1000]);
      }
    });
  });

  describe('GET /:id/attachments', () => {
    it('lists oldest first, in the upload’s shape, and indexes in the same order', async () => {
      await seedFile('b.md', 'b', { createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)) });
      await seedFile('a.md', 'a', { createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)) });
      const uploaded = await upload('c.md', 'c');

      const res = await send('GET', `/${TASK}/attachments`);
      expect(res.status).toBe(200);
      const listed = res.body?.attachments as Row[];
      expect(listed.map((a) => a.filename)).toEqual(['a.md', 'b.md', 'c.md']);
      expect(listed[2]).toEqual(uploaded.body?.attachment);
      expect(await indexed()).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('carries an archive’s expansion state, and its note exactly as stored', async () => {
      const note =
        '2 archive members were not extracted (path too long or too deep to store): a, b';
      await seedFile('later.zip', 'PK');
      const spec = await seedFile('spec.zip', 'PK', {
        expandedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 5)),
        expansionNote: note,
      });
      await seedFile('spec/a.md', 'a', { expandedFromId: spec.id });

      const res = await send('GET', `/${TASK}/attachments`);
      const listed = res.body?.attachments as Row[];
      expect(
        listed.map((a) => [a.filename, a.expandedAt, a.expansionNote, a.expandedFromId]),
      ).toEqual([
        ['later.zip', null, null, null],
        ['spec.zip', '2026-01-01T00:00:05.000Z', note, null],
        ['spec/a.md', null, null, spec.id],
      ]);
    });
  });

  describe('GET /:id/attachments/:attachmentId/raw', () => {
    it('serves the stored bytes with download headers', async () => {
      const text = await upload('docs/api/spec.md', 'hello', { type: 'text/markdown' });
      const res = await download((text.body?.attachment as Row).id as string);
      expect(res.status).toBe(200);
      expect(res.bytes.toString('utf8')).toBe('hello');
      expect(res.headers.get('content-type')).toBe('text/markdown');
      // The basename: a header naming `docs/api/` points at a directory the downloader lacks.
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="spec.md"');
      expect(res.headers.get('content-length')).toBe('5');
      expect(res.headers.get('cache-control')).toBe('no-store');

      const bytes = new Uint8Array([0x00, 0xff, 0x0d, 0x0a, 0x1b]);
      const bin = await upload('blob.bin', bytes);
      expect((bin.body?.attachment as Row).contentType).toBeNull();
      const got = await download((bin.body?.attachment as Row).id as string);
      expect(got.headers.get('content-type')).toBe('application/octet-stream');
      expect(got.bytes.equals(Buffer.from(bytes))).toBe(true);
    });

    it('refuses a file or folder swapped for a link, and serves nothing from outside', async () => {
      await writeFile(path.join(outside, 'secret.md'), 'secret');
      const res = await upload('a.md', 'mine');
      const id = (res.body?.attachment as Row).id as string;

      await rm(up('a.md'));
      await symlink(path.join(outside, 'secret.md'), up('a.md'));
      const viaFile = await download(id);
      expect(viaFile.status).toBe(403);
      expect(JSON.parse(viaFile.bytes.toString('utf8'))).toMatchObject({
        error: 'Path is a symlink',
      });
      expect(viaFile.bytes.toString('utf8')).not.toContain('secret');

      await rm(up(), { recursive: true });
      await symlink(outside, up());
      expect((await download(id)).status).toBe(403);
    });

    it('answers 404 for what it cannot serve', async () => {
      const unknown = await download('00000000-0000-4000-8000-00000000dead');
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknown.bytes.toString('utf8'))).toMatchObject({
        error: 'Attachment not found',
      });

      const res = await upload('a.md', 'x');
      await rm(up('a.md'));
      const gone = await download((res.body?.attachment as Row).id as string);
      expect(gone.status).toBe(404);
      expect(JSON.parse(gone.bytes.toString('utf8'))).toMatchObject({
        error: 'Attachment file is missing on disk',
      });
    });
  });

  describe('DELETE /:id/attachments/:attachmentId', () => {
    it('removes the file and its row, prunes emptied folders, and drops the index last', async () => {
      const spec = await upload('docs/api/spec.md', 'spec');
      const readme = await upload('docs/readme.md', 'readme');

      const first = await send(
        'DELETE',
        `/${TASK}/attachments/${(spec.body?.attachment as Row).id as string}`,
      );
      expect(first).toEqual({ status: 200, body: { ok: true } });
      expect(await exists(up('docs/api'))).toBe(false);
      expect(await readFile(up('docs/readme.md'), 'utf8')).toBe('readme');
      expect(filenames()).toEqual(['docs/readme.md']);
      expect(await indexed()).toEqual(['docs/readme.md']);

      await send('DELETE', `/${TASK}/attachments/${(readme.body?.attachment as Row).id as string}`);
      expect(await exists(up('docs'))).toBe(false);
      expect(await exists(up())).toBe(true);
      expect(await listing(up())).toEqual([]);
    });

    it('takes an archive’s expanded tree with it, and only that tree', async () => {
      // Seeded FIRST, so a lookup that ignored its filter would find this archive's child — and
      // delete the wrong folder — before it found the right one.
      await seedArchive('other.zip', { 'other/c.md': 'c' });
      await seedFile('keep.md', 'keep');
      const spec = await seedArchive('spec.zip', {
        'spec/brief.docx': 'docx',
        'spec/sub/b.md': 'b',
      });
      await plantSidecar('spec/brief.docx');

      const res = await send('DELETE', `/${TASK}/attachments/${spec.id as string}`);
      expect(res).toEqual({ status: 200, body: { ok: true } });
      expect(await exists(up('spec.zip'))).toBe(false);
      expect(await exists(up('spec'))).toBe(false);
      expect(await exists(up('other.zip'))).toBe(true);
      expect(await readFile(up('other/c.md'), 'utf8')).toBe('c');
      expect(await readFile(up('keep.md'), 'utf8')).toBe('keep');
      // The members' rows went with the archive's, by the cascade.
      expect(filenames()).toEqual(['other.zip', 'other/c.md', 'keep.md']);
      expect(await indexed()).toEqual(['other.zip', 'keep.md', 'other/c.md']);
    });

    it('deletes the row of a file that is already gone', async () => {
      const res = await upload('a.md', 'x');
      await rm(up('a.md'));
      const del = await send(
        'DELETE',
        `/${TASK}/attachments/${(res.body?.attachment as Row).id as string}`,
      );
      expect(del).toEqual({ status: 200, body: { ok: true } });
      expect(filenames()).toEqual([]);
      expect(await indexed()).toBeNull();
    });

    it('never follows a folder swapped for a link', async () => {
      const a = await upload('docs/a.md', 'mine');
      await upload('b.md', 'b');
      await writeFile(path.join(outside, 'a.md'), 'outside');
      await rm(up('docs'), { recursive: true });
      await symlink(outside, up('docs'));

      const res = await send(
        'DELETE',
        `/${TASK}/attachments/${(a.body?.attachment as Row).id as string}`,
      );
      expect(res).toEqual({ status: 200, body: { ok: true } });
      expect(await readFile(path.join(outside, 'a.md'), 'utf8')).toBe('outside');
      expect(filenames()).toEqual(['b.md']);
      expect(await indexed()).toEqual(['b.md']);
    });
  });

  describe('DELETE /:id/attachments?prefix=', () => {
    it('removes the folder, its rows and its sidecars, and nothing that only shares a prefix', async () => {
      await seedFile('docs/a.md', 'a');
      await seedFile('docs/v2/b.md', 'b');
      await seedFile('docs_v2/c.md', 'c');
      await seedFile('d.md', 'd');
      await plantSidecar('docs/a.md');

      // `_` is a LIKE wildcard, so a SQL `LIKE 'docs_v2/%'` would have matched `docs/v2/b.md` too.
      expect(await send('DELETE', `/${TASK}/attachments?prefix=docs_v2`)).toEqual({
        status: 200,
        body: { ok: true, removed: 1 },
      });
      expect(await readFile(up('docs/v2/b.md'), 'utf8')).toBe('b');

      expect(await send('DELETE', `/${TASK}/attachments?prefix=docs`)).toEqual({
        status: 200,
        body: { ok: true, removed: 2 },
      });
      expect(await exists(up('docs'))).toBe(false);
      expect(filenames()).toEqual(['d.md']);
      expect(await indexed()).toEqual(['d.md']);
    });

    it('prunes a parent the folder leaves empty', async () => {
      await seedFile('specs/api/a.md', 'a');
      expect(await send('DELETE', `/${TASK}/attachments?prefix=specs/api`)).toEqual({
        status: 200,
        body: { ok: true, removed: 1 },
      });
      expect(await exists(up('specs'))).toBe(false);
      expect(await listing(up())).toEqual([]);
    });

    it('requires a prefix and answers 404 for one with nothing under it', async () => {
      await seedFile('docs/a.md', 'a');
      expect(await send('DELETE', `/${TASK}/attachments`)).toEqual({
        status: 400,
        body: { error: 'prefix query parameter is required', code: null },
      });
      expect(await send('DELETE', `/${TASK}/attachments?prefix=nope`)).toEqual({
        status: 404,
        body: { error: 'No attachments under "nope/"', code: null },
      });
      expect(filenames()).toEqual(['docs/a.md']);
      expect(await readFile(up('docs/a.md'), 'utf8')).toBe('a');
    });

    it('never follows a link in the folder’s path', async () => {
      await mkdir(path.join(outside, 'v2'), { recursive: true });
      await writeFile(path.join(outside, 'v2', 'keep.md'), 'keep');
      await mkdir(up(), { recursive: true });
      await symlink(outside, up('docs'));
      seedAttachment('docs/v2/keep.md', 'keep');

      expect(await send('DELETE', `/${TASK}/attachments?prefix=docs/v2`)).toEqual({
        status: 200,
        body: { ok: true, removed: 1 },
      });
      expect(await readFile(path.join(outside, 'v2', 'keep.md'), 'utf8')).toBe('keep');
    });
  });

  describe('ownership and layout', () => {
    it('answers 404 to another user on every route, and changes nothing', async () => {
      const res = await upload('a.md', 'mine');
      const id = (res.body?.attachment as Row).id as string;
      const before = fake.rows(schema.taskAttachments);

      const notFound = { status: 404, body: { error: 'Task not found', code: null } };
      expect(await upload('b.md', 'theirs', { as: OTHER })).toEqual(notFound);
      expect(await send('GET', `/${TASK}/attachments`, { as: OTHER })).toEqual(notFound);
      const raw = await download(id, { as: OTHER });
      expect(raw.status).toBe(404);
      expect(JSON.parse(raw.bytes.toString('utf8'))).toMatchObject({ error: 'Task not found' });
      expect(await send('DELETE', `/${TASK}/attachments/${id}`, { as: OTHER })).toEqual(notFound);
      expect(await send('DELETE', `/${TASK}/attachments?prefix=docs`, { as: OTHER })).toEqual(
        notFound,
      );

      expect(await listing(up())).toEqual(['_ATTACHMENTS.md', 'a.md']);
      expect(await readFile(up('a.md'), 'utf8')).toBe('mine');
      expect(fake.rows(schema.taskAttachments)).toEqual(before);
    });

    it('scopes an attachment to its own task', async () => {
      const res = await upload('a.md', 'mine');
      const id = (res.body?.attachment as Row).id as string;
      const notFound = { status: 404, body: { error: 'Attachment not found', code: null } };

      const raw = await download(id, { task: TASK2 });
      expect(raw.status).toBe(404);
      expect(JSON.parse(raw.bytes.toString('utf8'))).toMatchObject({
        error: 'Attachment not found',
      });
      expect(await send('DELETE', `/${TASK2}/attachments/${id}`)).toEqual(notFound);
      expect(await readFile(up('a.md'), 'utf8')).toBe('mine');
      expect(filenames()).toEqual(['a.md']);
    });

    it('refuses a row whose stored path is not the api’s layout, and leaves what it names', async () => {
      await mkdir(path.join(outside, 'old'), { recursive: true });
      await writeFile(path.join(outside, 'a.md'), 'a');
      await writeFile(path.join(outside, 'old', 'b.md'), 'b');
      const a = seedAttachment('a.md', 'a', { storedPath: path.join(outside, 'a.md') });
      seedAttachment('old/b.md', 'b', { storedPath: path.join(outside, 'old', 'b.md') });

      const raw = await download(a.id as string);
      expect(raw.status).toBe(404);
      expect(JSON.parse(raw.bytes.toString('utf8'))).toMatchObject({
        error: 'Attachment file is missing on disk',
      });
      const refused = {
        status: 409,
        body: { error: 'Attachment path is not in a recognised layout', code: null },
      };
      expect(await send('DELETE', `/${TASK}/attachments/${a.id as string}`)).toEqual(refused);
      expect(await send('DELETE', `/${TASK}/attachments?prefix=old`)).toEqual(refused);
      expect(await readFile(path.join(outside, 'a.md'), 'utf8')).toBe('a');
      expect(await readFile(path.join(outside, 'old', 'b.md'), 'utf8')).toBe('b');
      expect(filenames()).toEqual(['a.md', 'old/b.md']);
    });
  });

  it('the fake evaluates only the conditions the routes build', () => {
    const t = schema.taskAttachments;
    const [a, b] = [
      seedAttachment('a.md', 'a', { taskId: TASK }),
      seedAttachment('b.md', 'b', { taskId: TASK2 }),
    ];
    const match = (cond: unknown): unknown[] =>
      fake
        .rows(t)
        .filter(fake.compileWhere(t, cond))
        .map((r) => r.filename);
    expect(match(and(eq(t.taskId, TASK), eq(t.userId, USER)))).toEqual(['a.md']);
    expect(match(inArray(t.id, [a.id as string, b.id as string]))).toEqual(['a.md', 'b.md']);
    expect(match(and(eq(t.id, b.id as string)))).toEqual(['b.md']);

    for (const cond of [
      or(eq(t.taskId, TASK), eq(t.taskId, TASK2)),
      isNull(t.expandedFromId),
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
});
