import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { CONFIG_KEYS, configService, logger } from '@haive/shared';
import { attachmentRoutes } from '../src/routes/tasks/attachments.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// An upload claims its name by creating it, and takes the name back when the upload fails: when the
// transaction that claimed it fails after the file was created (`claimAttachmentName`), when the
// body stops mid-stream, and when the row that records the finished upload cannot be inserted
// (`finalizeAttachment`). What it takes back is the file it created. A file somebody put at that
// name meanwhile is not its to remove, whatever it holds.
//
// Driven as task-attachment-routes.test.ts drives the same routes, with the same fake database.

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const REPO = '00000000-0000-4000-8000-0000000000f1';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', attachmentRoutes);
app.onError(errorHandler);

describe('an upload that fails after it claimed its name', () => {
  let storage: string;
  let repo: string;
  let fake: ReturnType<typeof createRouteDb>;

  const createRouteDb = () =>
    createFakeDb({
      tasks: schema.tasks,
      repositories: schema.repositories,
      taskAttachments: schema.taskAttachments,
    });

  const up = (rel = ''): string => path.join(repo, '.haive', 'task-uploads', TASK, rel);

  beforeEach(async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    storage = await mkdtemp(path.join(tmpdir(), 'attach-claim-'));
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
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      repositoryId: REPO,
      type: 'workflow',
      title: 'task',
    });
    h.db = fake.db;
    vi.spyOn(configService, 'getNumber').mockImplementation(async (key, fallback = 0) =>
      key === CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES ? 1024 * 1024 : fallback,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(storage, { recursive: true, force: true });
  });

  const upload = async (
    filename: string,
    body: string | ReadableStream<Uint8Array>,
  ): Promise<{ status: number; error: unknown }> => {
    const res = await app.request(`/${TASK}/attachments?${new URLSearchParams({ filename })}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
      duplex: 'half',
    } as RequestInit);
    const raw = await res.text();
    return {
      status: res.status,
      error: raw ? (JSON.parse(raw) as { error?: unknown }).error : null,
    };
  };

  /** A file somebody saves, to be put at the claimed name inside the failure. */
  async function otherFile(bytes: string) {
    const other = path.join(storage, 'other.bin');
    await writeFile(other, bytes, { mode: 0o600 });
    return { other, before: await lstat(other) };
  }

  const standsAt = async (name: string, bytes: string, ino: number): Promise<void> => {
    const stat = await lstat(up(name)).catch(() => null);
    expect(stat?.isFile(), `the other file is still at ${name} (it was removed)`).toBe(true);
    expect(await readFile(up(name), 'utf8'), 'it holds the other file’s bytes').toBe(bytes);
    expect(stat?.ino, 'it is the other file’s inode').toBe(ino);
    expect((await readdir(up())).sort(), 'nothing else is beside it').toEqual([name]);
  };

  // The claim's own transaction fails once its section has created the name: the commit is what
  // fails, which is when a driver gives up on work that already ran.
  it('D3 keeps a different file put at the claimed name when the claim’s transaction fails', async () => {
    const { other, before } = await otherFile('saved by someone else');
    fake.hooks.beforeCommit = async () => {
      fake.hooks.beforeCommit = null;
      await rename(other, up('a.md'));
      throw new Error('connection lost');
    };

    const res = await upload('a.md', 'mine');

    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(fake.rows(schema.taskAttachments), 'no attachment was recorded').toEqual([]);
    await standsAt('a.md', 'saved by someone else', before.ino);
  });

  it('D3 pin: takes back the name it claimed when the claim’s transaction fails', async () => {
    fake.hooks.beforeCommit = async () => {
      fake.hooks.beforeCommit = null;
      throw new Error('connection lost');
    };

    const res = await upload('a.md', 'mine');

    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(fake.rows(schema.taskAttachments), 'no attachment was recorded').toEqual([]);
    expect(await readdir(up()), 'the empty file it claimed is removed').toEqual([]);
  });

  // The body stops after the name was claimed, as when the client goes away.
  const stoppingBody = (beforeStop: () => Promise<void>): ReadableStream<Uint8Array> => {
    let pulls = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('partial'));
          return;
        }
        await beforeStop();
        controller.error(new Error('client went away'));
      },
    });
  };

  it('D3 keeps a different file put at the claimed name when the body fails mid-stream', async () => {
    const { other, before } = await otherFile('saved by someone else');

    const res = await upload(
      'a.bin',
      stoppingBody(() => rename(other, up('a.bin'))),
    );

    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(res.error).toBe('attachment write failed: client went away');
    expect(fake.rows(schema.taskAttachments), 'no attachment was recorded').toEqual([]);
    await standsAt('a.bin', 'saved by someone else', before.ino);
  });

  it('D3 pin: releases the name when the body fails mid-stream', async () => {
    const res = await upload(
      'a.bin',
      stoppingBody(async () => {}),
    );

    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(res.error).toBe('attachment write failed: client went away');
    expect(await readdir(up()), 'the partial file is removed').toEqual([]);
  });

  // The body streamed in and the file was closed, and recording it fails: the file has no row and a
  // second look finds none, so the file is taken back. The descriptor is long closed by then, so
  // what identifies the file is what the claim recorded.
  const failTheInsert = (beforeFail?: () => Promise<void>): void => {
    fake.hooks.beforeInsert = async (table) => {
      if (table !== schema.taskAttachments) return;
      fake.hooks.beforeInsert = null;
      await beforeFail?.();
      throw new Error('insert failed');
    };
  };

  it('D5 keeps a different file put at the name when the row insert fails', async () => {
    const { other, before } = await otherFile('saved by someone else');
    failTheInsert(() => rename(other, up('a.md')));

    const res = await upload('a.md', 'mine');

    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(fake.rows(schema.taskAttachments), 'no attachment was recorded').toEqual([]);
    await standsAt('a.md', 'saved by someone else', before.ino);
  });

  it('D5 pin: takes back the file it stored when the row insert fails', async () => {
    failTheInsert();

    const res = await upload('a.md', 'mine');

    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(fake.rows(schema.taskAttachments), 'no attachment was recorded').toEqual([]);
    expect(await readdir(up()), 'the file with no row is removed').toEqual([]);
  });

  // A removal judged on the inode is pinned only while the descriptor holding it is open: closed,
  // its inode number can be reused by a file put at the name.
  type Stat = (this: FileHandle, opts?: { bigint?: boolean }) => Promise<unknown>;
  let proto: { stat: unknown };
  let realStat: Stat;

  beforeAll(async () => {
    const probe = await open(fileURLToPath(import.meta.url), 'r');
    proto = Object.getPrototypeOf(probe) as { stat: unknown };
    realStat = proto.stat as Stat;
    await probe.close();
  });

  afterEach(() => {
    proto.stat = realStat;
  });

  /** Whether `name` still stood the first time the claimed descriptor closed. The handle is caught
   *  where the claim reads its identity (the one `stat({ bigint: true })`), and `close` is wrapped
   *  on it, since a FileHandle carries `close` as its own property. */
  const watchFirstClose = (name: string): { caught: boolean; stood: boolean | null } => {
    const seen = { caught: false, stood: null as boolean | null };
    proto.stat = async function (this: FileHandle, opts?: { bigint?: boolean }) {
      if (opts?.bigint === true && !seen.caught) {
        seen.caught = true;
        const close = this.close;
        this.close = async () => {
          seen.stood ??= existsSync(up(name));
          return close.call(this);
        };
      }
      return realStat.call(this, opts);
    };
    return seen;
  };

  it('releases the name while its descriptor is still open when the body fails mid-stream', async () => {
    const seen = watchFirstClose('a.bin');

    const res = await upload(
      'a.bin',
      stoppingBody(async () => {}),
    );

    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(seen.caught, 'the claim read the identity of the file it created').toBe(true);
    expect(seen.stood, 'the name was gone before its descriptor first closed').toBe(false);
  });

  it('takes back the stored file while its descriptor is still open when the row insert fails', async () => {
    failTheInsert();
    const seen = watchFirstClose('a.md');

    const res = await upload('a.md', 'mine');

    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(seen.caught, 'the claim read the identity of the file it created').toBe(true);
    expect(seen.stood, 'the file was gone before its descriptor first closed').toBe(false);
  });
});
