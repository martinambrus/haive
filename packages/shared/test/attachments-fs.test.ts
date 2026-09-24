import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, withTaskAttachmentsLock, type Database, type DbTx } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { ATTACHMENT_ARCHIVE_MAX_FILES } from '../src/attachments/archive.js';
import {
  readExpansionIntent,
  rewriteAttachmentsManifest,
  settleExpansionAttempt,
} from '../src/attachments-fs.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-0000000000a1';
const t = schema.taskAttachments;
const dirs: string[] = [];
const exists = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false,
  );

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

describe('settleExpansionAttempt', () => {
  it('acts on an intent once, so a name it freed is never taken back from its next owner', async () => {
    // An upload's file exists before its row does. Were the intent left behind, a second settle
    // would read that file as the interrupted attempt's orphan and remove it.
    const f = await fixture();
    const staging = `.expanding-${'0'.repeat(8)}-0000-4000-8000-000000000011-${'0'.repeat(8)}-0000-4000-8000-000000000012`;
    const stagingDir = path.join(f.anchor, f.uploadsRel, staging);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(
      path.join(stagingDir, 'placed-as'),
      JSON.stringify({ dir: 'spec', files: ['a.md'] }),
    );
    await mkdir(path.join(f.anchor, f.uploadsRel, 'spec'));
    await writeFile(path.join(f.anchor, f.uploadsRel, 'spec', 'a.md'), 'orphan');
    const tx = f.db as unknown as DbTx;

    await settleExpansionAttempt(tx, TASK, f.anchor, f.uploadsRel, staging);
    expect(await exists(path.join(f.anchor, f.uploadsRel, 'spec', 'a.md'))).toBe(false);

    await mkdir(path.join(f.anchor, f.uploadsRel, 'spec'), { recursive: true });
    await writeFile(path.join(f.anchor, f.uploadsRel, 'spec', 'a.md'), 'a new upload');
    await settleExpansionAttempt(tx, TASK, f.anchor, f.uploadsRel, staging);
    expect(await readFile(path.join(f.anchor, f.uploadsRel, 'spec', 'a.md'), 'utf8')).toBe(
      'a new upload',
    );
  });
});

describe('readExpansionIntent', () => {
  it('accepts as many names as an archive may hold, and refuses one more', async () => {
    // Every name becomes a bind parameter of the settle's query. A forged list past Postgres' limit
    // would fail a delete's section after its files had already gone.
    const f = await fixture();
    const stagingRel = `${f.uploadsRel}/.expanding-x`;
    await mkdir(path.join(f.anchor, stagingRel), { recursive: true });
    const intent = (count: number) =>
      writeFile(
        path.join(f.anchor, stagingRel, 'placed-as'),
        JSON.stringify({ dir: 'spec', files: Array.from({ length: count }, (_, i) => `f${i}.md`) }),
      );

    await intent(ATTACHMENT_ARCHIVE_MAX_FILES);
    expect((await readExpansionIntent(f.anchor, stagingRel))?.files).toHaveLength(
      ATTACHMENT_ARCHIVE_MAX_FILES,
    );
    await intent(ATTACHMENT_ARCHIVE_MAX_FILES + 1);
    expect(await readExpansionIntent(f.anchor, stagingRel)).toBeNull();
  });
});
