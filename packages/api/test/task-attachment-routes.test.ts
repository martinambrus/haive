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
import { eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

import { Hono } from 'hono';
import { schema, withTaskAttachmentsLock, type Database } from '@haive/database';
import { createFakeDb, type FakeRow } from '@haive/database/testing';
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

type Row = FakeRow;

/** The three tables the routes touch, in the in-memory stand-in the worker's tests share. */
function createRouteDb() {
  return createFakeDb({
    tasks: schema.tasks,
    repositories: schema.repositories,
    taskAttachments: schema.taskAttachments,
  });
}

/** Resolves the next time a section asks for the task's attachments lock. */
function nextLockRequest(fake: ReturnType<typeof createRouteDb>): Promise<void> {
  return new Promise((resolve) => {
    fake.hooks.beforeLock = () => {
      fake.hooks.beforeLock = null;
      resolve();
    };
  });
}

/** A lock wait that ran out, as Postgres reports it. */
function lockTimeout(): Error {
  return Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
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
  let fake: ReturnType<typeof createRouteDb>;
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

  /** What a worker leaves when it dies after moving an archive's tree into place and before the
   *  rows naming its files commit: the tree, and the staging dir's `placed-as` naming it. */
  async function interruptedExpansion(archiveId: string, dir: string, files: string[]) {
    const staging = up(`.expanding-${archiveId}-00000000-0000-4000-8000-000000000999`);
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, 'placed-as'), JSON.stringify({ dir, files }));
    for (const file of files) {
      await mkdir(path.dirname(up(`${dir}/${file}`)), { recursive: true });
      await writeFile(up(`${dir}/${file}`), 'placed');
    }
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
  const busy = {
    status: 503,
    body: {
      error: 'Another change to this task’s attachments is in progress; try again',
      code: null,
    },
  };

  /** What `00-plan-inputs` does to store a sidecar — under the lock, and only while the row is
   *  there — started the moment the delete is about to remove its rows. The delete is held until
   *  that write has either looked for the row or is waiting for the lock: the fake shows every write
   *  at once, so without the hold the look would always come after the rows went, lock or no lock.
   *  `result` says whether it wrote. */
  function raceSidecar(id: string, sidecar: string): { result: Promise<boolean> } {
    let resolveResult!: (wrote: Promise<boolean>) => void;
    const result = new Promise<boolean>((resolve) => (resolveResult = resolve));
    fake.hooks.beforeDelete = async () => {
      fake.hooks.beforeDelete = null;
      const asked = nextLockRequest(fake);
      let looked!: () => void;
      const lookedForRow = new Promise<void>((resolve) => (looked = resolve));
      resolveResult(
        withTaskAttachmentsLock(fake.db as unknown as Database, TASK, async (tx) => {
          const row = await tx.query.taskAttachments.findFirst({
            where: eq(schema.taskAttachments.id, id),
          });
          looked();
          if (row) await writeFile(up(sidecar), '# late');
          return row !== undefined;
        }),
      );
      await asked;
      await Promise.race([lookedForRow, new Promise((resolve) => setTimeout(resolve, 20))]);
    };
    return { result };
  }
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

    fake = createRouteDb();
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

    it('settles an interrupted expansion before claiming a name it still names', async () => {
      const archive = await seedFile('spec.zip', 'PK');
      await interruptedExpansion(archive.id as string, 'spec', ['a.md', 'b.md']);
      // Something in the sandbox removed one placed file, which frees its name for an upload.
      await rm(up('spec/a.md'));
      const res = await upload('spec/a.md', 'mine');
      expect(res.status).toBe(201);
      expect((res.body?.attachment as Row).filename).toBe('spec/a.md');
      expect(await readFile(up('spec/a.md'), 'utf8')).toBe('mine');
      // No intent is left to name the upload's path, so no later settle can take its file.
      const staging = (await listing(up())).find((n) => n.startsWith('.expanding-'))!;
      expect(await listing(up(staging))).not.toContain('placed-as');
      expect(await listing(up('spec'))).toEqual(['a.md']);
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

    it('never takes a sidecar’s name, at any depth', async () => {
      // The worker writes `<doc>.extracted.md` beside its document wherever that sits, and a delete of
      // the document unlinks that path whether or not the sidecar exists yet. An upload holding the
      // name would be overwritten by the extraction, or unlinked by a delete that raced it.
      const names: unknown[] = [];
      for (const name of ['x.docx.extracted.md', 'docs/a.pdf.extracted.md']) {
        const res = await upload(name, 'mine');
        expect(res.status).toBe(201);
        names.push((res.body?.attachment as Row).filename);
      }
      expect(names).toEqual(['x.docx.extracted (2).md', 'docs/a.pdf.extracted (2).md']);
      expect(await exists(up('x.docx.extracted.md'))).toBe(false);
    });

    it('keeps an archive’s two-part extension whole when it de-dupes', async () => {
      // `spec.tar (2).gz` is a name no archive rule recognises, so it would never be expanded.
      const first = await upload('spec.tar.gz', 'one');
      const second = await upload('spec.tar.gz', 'two');
      expect((first.body?.attachment as Row).filename).toBe('spec.tar.gz');
      expect((second.body?.attachment as Row).filename).toBe('spec (2).tar.gz');
      expect(await readFile(up('spec (2).tar.gz'), 'utf8')).toBe('two');
    });

    it('renames a folder a generated file needs, the same way for every file in it', async () => {
      // A folder arrives one request per file, so the rename is fixed rather than probed: every
      // file of `_ATTACHMENTS.md/` has to land in ONE folder.
      const names: unknown[] = [];
      for (const name of [
        '_ATTACHMENTS.md/a.txt',
        '_ATTACHMENTS.md/b.txt',
        'docs/a.pdf.extracted.md/c.txt',
        'docs/_ATTACHMENTS.md/d.txt',
      ]) {
        const res = await upload(name, 'mine');
        expect(res.status).toBe(201);
        names.push((res.body?.attachment as Row).filename);
      }
      expect(names).toEqual([
        '_ATTACHMENTS.md (2)/a.txt',
        '_ATTACHMENTS.md (2)/b.txt',
        'docs/a.pdf.extracted.md (2)/c.txt',
        'docs/_ATTACHMENTS.md/d.txt',
      ]);
      // The root name stays the index FILE every agent is told to read.
      expect((await lstat(up('_ATTACHMENTS.md'))).isFile()).toBe(true);
      expect([...((await indexed()) ?? [])].sort()).toEqual([...(names as string[])].sort());
      expect(await exists(up('docs/a.pdf.extracted.md'))).toBe(false);
    });

    it('keeps a renamed folder inside the path rules, so its prefix still removes it', async () => {
      // 200 characters: at the segment limit before ` (2)` is added.
      const folder = `${'x'.repeat(187)}.extracted.md`;
      const res = await upload(`${folder}/a.txt`, 'mine');
      expect(res.status).toBe(201);
      const [renamed] = String((res.body?.attachment as Row).filename).split('/');
      expect(renamed!.length).toBeLessThanOrEqual(200);
      const qs = new URLSearchParams({ prefix: renamed! });
      const del = await send('DELETE', `/${TASK}/attachments?${qs.toString()}`);
      expect(del.status).toBe(200);
      expect(filenames()).toEqual([]);

      // A path the rename would take past the path limit is refused like any too-long path.
      const tooLong = `_ATTACHMENTS.md/${'a'.repeat(199)}/${'b'.repeat(184)}`;
      expect(tooLong).toHaveLength(400);
      expect((await upload(tooLong, 'x')).status).toBe(400);
      expect(filenames()).toEqual([]);
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

    it('replaces a link planted at the index instead of failing after the work is done', async () => {
      // The index is written AFTER the row exists, so a refusal there used to answer 500 for an
      // upload that had happened, and a client retry then stored the file twice.
      await mkdir(up(), { recursive: true });
      await writeFile(path.join(outside, 'secret.md'), 'secret');
      await symlink(path.join(outside, 'secret.md'), up('_ATTACHMENTS.md'));

      const first = await upload('a.md', 'one');
      expect(first.status).toBe(201);
      expect((await lstat(up('_ATTACHMENTS.md'))).isFile()).toBe(true);
      expect(await indexed()).toEqual(['a.md']);

      await rm(up('_ATTACHMENTS.md'));
      await symlink(path.join(outside, 'secret.md'), up('_ATTACHMENTS.md'));
      await upload('b.md', 'two');
      const del = await send(
        'DELETE',
        `/${TASK}/attachments/${(first.body?.attachment as Row).id}`,
      );
      expect(del.status).toBe(200);
      expect(await indexed()).toEqual(['b.md']);
      expect(await readFile(path.join(outside, 'secret.md'), 'utf8')).toBe('secret');
    });

    it('still answers when a directory blocks the index, and does the work', async () => {
      await mkdir(up('_ATTACHMENTS.md'), { recursive: true });
      await writeFile(up('_ATTACHMENTS.md/keep.txt'), 'someone else’s');

      const res = await upload('a.md', 'mine');
      expect(res.status).toBe(201);
      expect(filenames()).toEqual(['a.md']);
      const del = await send('DELETE', `/${TASK}/attachments/${(res.body?.attachment as Row).id}`);
      expect(del.status).toBe(200);
      expect(filenames()).toEqual([]);
      expect(await readFile(up('_ATTACHMENTS.md/keep.txt'), 'utf8')).toBe('someone else’s');
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

    it('waits for a section holding the task’s attachments lock before it claims a name', async () => {
      // A delete holds the lock while it prunes the folders it emptied; a folder created for this
      // upload in the middle of that would be pruned from under it.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = withTaskAttachmentsLock(fake.db as unknown as Database, TASK, async () => {
        held();
        await gate;
      });
      await holding;
      const asked = nextLockRequest(fake);
      const pending = upload('docs/a.md', 'a');
      await asked;
      expect(await exists(up('docs'))).toBe(false);

      release();
      await holder;
      expect((await pending).status).toBe(201);
      expect(await readFile(up('docs/a.md'), 'utf8')).toBe('a');
      expect(await indexed()).toEqual(['docs/a.md']);
    });

    it('answers 503 and leaves nothing behind when the lock cannot be had in time', async () => {
      fake.hooks.beforeLock = () => {
        throw lockTimeout();
      };
      expect(await upload('docs/a.md', 'a')).toEqual(busy);
      expect(filenames()).toEqual([]);
      expect(await exists(up('docs'))).toBe(false);
    });

    it('keeps an upload whose insert committed although its answer was lost', async () => {
      // Answering 500 here would send the client's retry to store the file a second time.
      const insert = fake.db.insert;
      fake.db.insert = ((table: PgTable) => ({
        values: (values: Row) => ({
          returning: async () => {
            await insert(table).values(values);
            throw new Error('connection lost');
          },
        }),
      })) as unknown as typeof fake.db.insert;

      const res = await upload('a.md', 'kept');
      expect(res.status).toBe(201);
      const [row] = fake.rows(schema.taskAttachments);
      expect(res.body?.attachment).toMatchObject({ id: row!.id, filename: 'a.md' });
      expect(await readFile(up('a.md'), 'utf8')).toBe('kept');
      expect(await indexed()).toEqual(['a.md']);
    });

    it('takes the file back when its row could not be written', async () => {
      // A file no row names is invisible to every delete, and stays mounted into the sandbox.
      fake.db.insert = (() => ({
        values: () => ({
          returning: async () => {
            throw new Error('insert failed');
          },
        }),
      })) as unknown as typeof fake.db.insert;

      expect((await upload('a.md', 'x')).status).toBe(500);
      expect(filenames()).toEqual([]);
      expect(await exists(up('a.md'))).toBe(false);
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

    it('takes a document’s extracted text with it', async () => {
      const doc = await seedFile('spec.docx', 'docx');
      await plantSidecar('spec.docx');
      expect(await send('DELETE', `/${TASK}/attachments/${doc.id as string}`)).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(await exists(up('spec.docx.extracted.md'))).toBe(false);
    });

    it('prunes a folder its sidecar would otherwise keep alive', async () => {
      const doc = await seedFile('docs/spec.pdf', 'pdf');
      await plantSidecar('docs/spec.pdf');
      await send('DELETE', `/${TASK}/attachments/${doc.id as string}`);
      expect(await exists(up('docs'))).toBe(false);
    });

    it('makes a sidecar write that lands mid-delete wait for it, and then skip', async () => {
      // `00-plan-inputs` stores a sidecar only under the task's attachments lock and only while its
      // row exists. The delete holds that lock from reading the rows to rewriting the manifest, so a
      // write that starts after the files went and before the rows go waits for the whole delete.
      const doc = await seedFile('spec.docx', 'docx');
      const late = raceSidecar(doc.id as string, 'spec.docx.extracted.md');

      await send('DELETE', `/${TASK}/attachments/${doc.id as string}`);
      expect(await late.result).toBe(false);
      expect(await exists(up('spec.docx.extracted.md'))).toBe(false);
    });

    it('answers 503 and changes nothing when the lock cannot be had in time', async () => {
      const doc = await seedFile('a.md', 'a');
      fake.hooks.beforeLock = () => {
        throw lockTimeout();
      };
      expect(await send('DELETE', `/${TASK}/attachments/${doc.id as string}`)).toEqual(busy);
      expect(filenames()).toEqual(['a.md']);
      expect(await readFile(up('a.md'), 'utf8')).toBe('a');
    });

    it('takes back what an interrupted expansion of the deleted archive placed', async () => {
      // A worker that died after moving the tree into place and before its rows committed. With
      // the archive's row gone, no later expansion call would know there was anything to take back
      // — and with no row left at all, it could not even find the uploads dir.
      const archive = await seedFile('spec.zip', 'PK');
      await interruptedExpansion(archive.id as string, 'spec', ['a.md']);

      // Its staging dir outlives the section: it can hold a whole extracted archive.
      const atCommit: string[][] = [];
      fake.hooks.beforeCommit = async () => {
        atCommit.push((await listing(up())).filter((n) => n.startsWith('.expanding-')));
      };

      expect(await send('DELETE', `/${TASK}/attachments/${archive.id as string}`)).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(atCommit.at(-1)).toHaveLength(1);
      expect(await exists(up('spec'))).toBe(false);
      expect(await listing(up())).toEqual([]);
    });

    it('removes an archive with the last file extracted from it, and keeps it until then', async () => {
      await seedArchive('spec.zip', { 'spec/a.md': 'a', 'spec/b.md': 'b' });
      await plantSidecar('spec.zip');
      const idOf = (name: string) =>
        fake.rows(schema.taskAttachments).find((r) => r.filename === name)!.id as string;

      await send('DELETE', `/${TASK}/attachments/${idOf('spec/a.md')}`);
      expect(filenames()).toEqual(['spec.zip', 'spec/b.md']);

      expect(await send('DELETE', `/${TASK}/attachments/${idOf('spec/b.md')}`)).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(filenames()).toEqual([]);
      expect(await exists(up('spec.zip'))).toBe(false);
      expect(await exists(up('spec.zip.extracted.md'))).toBe(false);
      expect(await indexed()).toBeNull();
    });

    it('keeps a file another row still names', async () => {
      // Two rows can name one file: the upload claim reads the disk, not the rows.
      const first = await seedFile('a.md', 'shared');
      seedAttachment('a.md', 'shared');
      await send('DELETE', `/${TASK}/attachments/${first.id as string}`);
      expect(await readFile(up('a.md'), 'utf8')).toBe('shared');
      expect(filenames()).toEqual(['a.md']);
    });

    it('keeps an upload that merely has the sidecar’s name', async () => {
      const doc = await seedFile('x.docx', 'docx');
      await seedFile('x.docx.extracted.md', 'mine');
      await send('DELETE', `/${TASK}/attachments/${doc.id as string}`);
      expect(await readFile(up('x.docx.extracted.md'), 'utf8')).toBe('mine');
      expect(filenames()).toEqual(['x.docx.extracted.md']);
    });

    it('takes an archive apart member by member when a later upload lives in its folder', async () => {
      const bundle = await seedArchive('bundle.zip', { 'bundle/a.md': 'a' });
      await plantSidecar('bundle/a.md');
      // A folder upload whose top level matches the expansion directory lands inside it.
      await seedFile('bundle/mine.md', 'mine');

      await send('DELETE', `/${TASK}/attachments/${bundle.id as string}`);
      expect(await exists(up('bundle/a.md'))).toBe(false);
      expect(await exists(up('bundle/a.md.extracted.md'))).toBe(false);
      expect(await readFile(up('bundle/mine.md'), 'utf8')).toBe('mine');
      expect(filenames()).toEqual(['bundle/mine.md']);
    });

    it('leaves a file that reached the expansion folder after the delete read its rows', async () => {
      // An upload racing the delete: its file is on disk and its row is not written yet, which is
      // exactly what the delete's snapshot cannot see. Nothing no deleted row names may go.
      const bundle = await seedArchive('bundle.zip', { 'bundle/a.md': 'a' });
      await writeFile(up('bundle/late.md'), 'late');

      await send('DELETE', `/${TASK}/attachments/${bundle.id as string}`);
      expect(await exists(up('bundle/a.md'))).toBe(false);
      expect(await readFile(up('bundle/late.md'), 'utf8')).toBe('late');
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

    it('also removes the expansion tree of an archive inside the folder, which sits at the root', async () => {
      await seedArchive('docs/x.zip', { 'x/a.md': 'a' });
      await seedFile('docs/readme.md', 'r');
      await seedArchive('y.zip', { 'y/b.md': 'b' });

      expect(await send('DELETE', `/${TASK}/attachments?prefix=docs`)).toEqual({
        status: 200,
        body: { ok: true, removed: 2 },
      });
      expect(await exists(up('x'))).toBe(false);
      expect(await readFile(up('y/b.md'), 'utf8')).toBe('b');
      expect(filenames()).toEqual(['y.zip', 'y/b.md']);
    });

    it('leaves a file that reached the folder or an archive’s tree after the delete read its rows', async () => {
      await seedArchive('docs/x.zip', { 'x/a.md': 'a' });
      await seedFile('docs/readme.md', 'r');
      await writeFile(up('docs/late.md'), 'late');
      await writeFile(up('x/late.md'), 'late');

      expect(await send('DELETE', `/${TASK}/attachments?prefix=docs`)).toEqual({
        status: 200,
        body: { ok: true, removed: 2 },
      });
      expect(await exists(up('docs/readme.md'))).toBe(false);
      expect(await exists(up('x/a.md'))).toBe(false);
      expect(await readFile(up('docs/late.md'), 'utf8')).toBe('late');
      expect(await readFile(up('x/late.md'), 'utf8')).toBe('late');
    });

    it('makes a sidecar write that lands mid-delete wait for it, and then skip', async () => {
      const doc = await seedFile('docs/spec.pdf', 'pdf');
      const late = raceSidecar(doc.id as string, 'docs/spec.pdf.extracted.md');

      await send('DELETE', `/${TASK}/attachments?prefix=docs`);
      expect(await late.result).toBe(false);
      expect(await exists(up('docs'))).toBe(false);
    });

    it('answers 503 and changes nothing when the lock cannot be had in time', async () => {
      await seedFile('docs/a.md', 'a');
      fake.hooks.beforeLock = () => {
        throw lockTimeout();
      };
      expect(await send('DELETE', `/${TASK}/attachments?prefix=docs`)).toEqual(busy);
      expect(filenames()).toEqual(['docs/a.md']);
      expect(await readFile(up('docs/a.md'), 'utf8')).toBe('a');
    });

    it('takes back what an interrupted expansion of an archive in the folder placed', async () => {
      const archive = await seedFile('docs/x.zip', 'PK');
      await seedFile('keep.md', 'keep');
      await interruptedExpansion(archive.id as string, 'x', ['a.md']);
      const atCommit: string[][] = [];
      fake.hooks.beforeCommit = async () => {
        atCommit.push((await listing(up())).filter((n) => n.startsWith('.expanding-')));
      };

      expect(await send('DELETE', `/${TASK}/attachments?prefix=docs`)).toEqual({
        status: 200,
        body: { ok: true, removed: 1 },
      });
      expect(atCommit.at(-1)).toHaveLength(1);
      expect(await exists(up('x'))).toBe(false);
      expect(await listing(up())).toEqual(['_ATTACHMENTS.md', 'keep.md']);
    });

    it('removes the archive whose every extracted file was in the folder', async () => {
      await seedArchive('spec.zip', { 'spec/a.md': 'a', 'spec/sub/b.md': 'b' });
      await plantSidecar('spec.zip');
      await seedFile('keep.md', 'keep');

      expect(await send('DELETE', `/${TASK}/attachments?prefix=spec`)).toEqual({
        status: 200,
        body: { ok: true, removed: 3 },
      });
      expect(filenames()).toEqual(['keep.md']);
      expect(await exists(up('spec.zip'))).toBe(false);
      expect(await exists(up('spec.zip.extracted.md'))).toBe(false);
      expect(await exists(up('spec'))).toBe(false);
      expect(await indexed()).toEqual(['keep.md']);
    });

    it('keeps the archive when the folder held only some of its files', async () => {
      await seedArchive('spec.zip', { 'spec/a.md': 'a', 'spec/sub/b.md': 'b' });

      expect(await send('DELETE', `/${TASK}/attachments?prefix=spec/sub`)).toEqual({
        status: 200,
        body: { ok: true, removed: 1 },
      });
      expect(filenames()).toEqual(['spec.zip', 'spec/a.md']);
      expect(await readFile(up('spec.zip'), 'utf8')).toBe('PK');
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
});
