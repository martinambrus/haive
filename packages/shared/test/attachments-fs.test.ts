import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, withTaskAttachmentsLock, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { rewriteAttachmentsManifest } from '../src/attachments-fs.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-0000000000a1';
const t = schema.taskAttachments;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const anchor = await mkdtemp(path.join(tmpdir(), 'attachments-fs-'));
  dirs.push(anchor);
  const uploadsRel = `.haive/task-uploads/${TASK}`;
  await mkdir(path.join(anchor, uploadsRel), { recursive: true });
  const fake = createFakeDb({ taskAttachments: t });
  const attach = (filename: string) =>
    fake.insert(t, {
      taskId: TASK,
      userId: USER,
      filename,
      storedPath: path.join(anchor, uploadsRel, filename),
      sizeBytes: 1,
    });
  /** The entries the manifest names, in order, or null when there is none. */
  const listed = async (): Promise<string[] | null> => {
    const body = await readFile(path.join(anchor, uploadsRel, '_ATTACHMENTS.md'), 'utf8').catch(
      () => null,
    );
    return body === null ? null : [...body.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);
  };
  return { anchor, uploadsRel, fake, db: fake.db as unknown as Database, attach, listed };
}

describe('rewriteAttachmentsManifest', () => {
  it('waits for a section holding the task’s lock, then describes the rows it left', async () => {
    // Read-then-write with no lock let two writers finish in the other order, leaving a manifest
    // that names a file the later one had already deleted.
    const f = await fixture();
    const gone = f.attach('a.md');
    f.attach('b.md');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const del = withTaskAttachmentsLock(f.db, TASK, async (tx) => {
      held();
      await gate;
      await tx.delete(t).where(eq(t.id, gone.id as string));
    });
    await holding;
    const asked = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the writer never asked for the lock')),
        2000,
      );
      f.fake.hooks.beforeLock = () => {
        f.fake.hooks.beforeLock = null;
        clearTimeout(timer);
        resolve();
      };
    });
    const writing = rewriteAttachmentsManifest(f.db, TASK, f.anchor, f.uploadsRel);
    await asked;
    expect(await f.listed()).toBeNull();

    release();
    await del;
    await writing;
    expect(await f.listed()).toEqual(['b.md']);
  });

  it('never throws, even when the lock cannot be had in time', async () => {
    const f = await fixture();
    f.attach('a.md');
    f.fake.hooks.beforeLock = () => {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    };
    await expect(
      rewriteAttachmentsManifest(f.db, TASK, f.anchor, f.uploadsRel),
    ).resolves.toBeUndefined();
    expect(await f.listed()).toBeNull();
  });
});
