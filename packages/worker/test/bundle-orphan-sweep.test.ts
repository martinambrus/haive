import {
  cp,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger, type BundleJobPayload } from '@haive/shared';
import * as fsSafe from '@haive/shared/fs-safe';

vi.mock('../src/data-migrations.js', () => ({
  reconcileStrandedSyncingBundles: vi.fn(async () => undefined),
  reconcileStrandedCloningRepos: vi.fn(async () => undefined),
}));

const { StalledTaskSweeper } = await import('../src/queues/stalled-redrive.js');
const USER = '00000000-0000-4000-8000-0000000000a1';
const BUNDLE = '00000000-0000-4000-8000-0000000000b1';
const UPLOAD = '00000000-0000-4000-8000-0000000000c1';
const STAGE = '.haive-extract-123-11111111-1111-4111-8111-111111111111';
const DIR = `${USER}/${BUNDLE}`;
const ARCHIVE = `source.${UPLOAD}.zip`;
const SIDECAR = `${ARCHIVE}.replacement.json`;
const NOW = Date.UTC(2026, 10, 12);
const AGE = 1000;
const OLD = new Date(NOW - AGE - 1);
let template: string;
let root: string;
let fake: ReturnType<typeof createFakeDb>;
let db: Database;
let readJobs: ReturnType<typeof vi.fn<() => Promise<Partial<BundleJobPayload>[] | null>>>;

// Unrelated stalled-task queries see no work; the cleanup reads real fake-db bundle tables.
function sweepDb(): Database {
  const empty: unknown = new Proxy(() => empty, {
    get: (_target, key) =>
      key === 'then' ? (ok: (rows: unknown[]) => unknown) => Promise.resolve([]).then(ok) : empty,
    apply: () => empty,
  });
  return new Proxy(empty as Database, {
    get: (target, key) =>
      key === 'select'
        ? (...args: Parameters<Database['select']>) => ({
            from: (table: unknown) =>
              table === schema.customBundles || table === schema.customBundleUploads
                ? fake.db.select(...args).from(table as typeof schema.customBundles)
                : empty,
          })
        : Reflect.get(target, key),
  });
}

function sweeper(options = {}) {
  return new StalledTaskSweeper({
    db,
    bundleOrphans: { root, now: () => NOW, maxAgeMs: AGE, readJobs, ...options },
  });
}

function bundle(status: 'syncing' | 'active' | 'failed') {
  fake.insert(schema.customBundles, {
    id: BUNDLE,
    userId: USER,
    status,
    archivePath: path.join(root, DIR, ARCHIVE),
  });
}

const exists = (name: string) => lstat(path.join(root, DIR, name));

beforeAll(async () => {
  template = await mkdtemp(path.join(tmpdir(), 'orp-template-'));
  await mkdir(path.join(template, DIR, STAGE, 'old'), { recursive: true });
  await writeFile(path.join(template, DIR, STAGE, 'old', 'kept.md'), 'previous tree');
  for (const name of ['source.zip', ARCHIVE, SIDECAR]) {
    await writeFile(path.join(template, DIR, name), name);
    await utimes(path.join(template, DIR, name), OLD, OLD);
  }
  await utimes(path.join(template, DIR, STAGE), OLD, OLD);
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orp-sweep-'));
  await cp(template, root, { recursive: true, preserveTimestamps: true });
  // cp preserves file timestamps, but creating its children restamps the copied directories.
  await utimes(path.join(root, DIR, STAGE), OLD, OLD);
  fake = createFakeDb({
    customBundles: schema.customBundles,
    customBundleUploads: schema.customBundleUploads,
  });
  db = sweepDb();
  readJobs = vi.fn(async () => []);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(template, { recursive: true, force: true });
});

describe('bundle orphan cleanup through the stalled sweep', () => {
  it('deletes an unowned stage older than the injected bound', async () => {
    await sweeper().sweep();
    await expect(exists(STAGE)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([NOW - AGE, NOW])('keeps a stage at or younger than the cutoff (%s)', async (mtime) => {
    await utimes(path.join(root, DIR, STAGE), new Date(mtime), new Date(mtime));
    await sweeper().sweep();
    expect((await exists(STAGE)).isDirectory()).toBe(true);
  });

  it('keeps a stage owned by a syncing bundle before its swap record exists', async () => {
    bundle('syncing');
    await rm(path.join(root, DIR, SIDECAR));
    await sweeper().sweep();
    expect((await exists(STAGE)).isDirectory()).toBe(true);
  });

  it('keeps the sidecar of a live replacement', async () => {
    bundle('syncing');
    await sweeper().sweep();
    expect((await exists(SIDECAR)).isFile()).toBe(true);
  });

  it('deletes an orphan replacement sidecar', async () => {
    await sweeper().sweep();
    await expect(exists(SIDECAR)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes a superseded archive after the replacement committed', async () => {
    bundle('active');
    await sweeper().sweep();
    await expect(exists('source.zip')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await exists(ARCHIVE)).isFile()).toBe(true);
  });

  it.each(['active', 'failed'] as const)(
    'keeps the current archive of a %s bundle',
    async (status) => {
      bundle(status);
      await sweeper().sweep();
      expect((await exists(ARCHIVE)).isFile()).toBe(true);
    },
  );

  it('keeps the previous archive and old tree until keep_until_success commits', async () => {
    bundle('syncing');
    await writeFile(
      path.join(root, DIR, SIDECAR),
      JSON.stringify({
        mode: 'keep_until_success',
        previousArchive: {
          archivePath: path.join(root, DIR, 'source.zip'),
          archiveFilename: 'old.zip',
          archiveFormat: 'zip',
        },
        recovery: { stageName: STAGE, dev: '1', ino: '2' },
      }),
    );
    await utimes(path.join(root, DIR, SIDECAR), OLD, OLD);
    await sweeper().sweep();
    expect(await readFile(path.join(root, DIR, STAGE, 'old', 'kept.md'), 'utf8')).toBe(
      'previous tree',
    );
    expect((await exists('source.zip')).isFile()).toBe(true);
  });

  it('leaves a stage symlink and its target untouched', async () => {
    const target = path.join(root, 'outside');
    await mkdir(target);
    await writeFile(path.join(target, 'keep'), 'untouched');
    await rm(path.join(root, DIR, STAGE), { recursive: true });
    await symlink(target, path.join(root, DIR, STAGE));
    await lutimes(path.join(root, DIR, STAGE), OLD, OLD);
    await sweeper().sweep();
    expect((await exists(STAGE)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(target, 'keep'), 'utf8')).toBe('untouched');
  });

  it.each(['unknown', 'throws'] as const)('deletes nothing when the queue %s', async (failure) => {
    if (failure === 'unknown') readJobs.mockResolvedValue(null);
    else readJobs.mockRejectedValue(new Error('redis unavailable'));
    await sweeper().sweep();
    for (const name of [STAGE, SIDECAR, ARCHIVE, 'source.zip'])
      await expect(exists(name)).resolves.toBeDefined();
  });

  it('keeps artifacts referenced by a live job even without a bundle row', async () => {
    readJobs.mockResolvedValue([
      { bundleId: BUNDLE, userId: USER, archivePath: path.join(root, DIR, ARCHIVE) },
    ]);
    await sweeper().sweep();
    for (const name of [STAGE, SIDECAR, ARCHIVE, 'source.zip'])
      await expect(exists(name)).resolves.toBeDefined();
  });

  it('keeps an archive referenced by another bundle row', async () => {
    fake.insert(schema.customBundles, {
      id: '00000000-0000-4000-8000-0000000000b2',
      userId: USER,
      status: 'active',
      archivePath: path.join(root, DIR, ARCHIVE),
    });
    await sweeper().sweep();
    expect((await exists(ARCHIVE)).isFile()).toBe(true);
  });

  it('keeps a previous archive referenced by another live job', async () => {
    readJobs.mockResolvedValue([
      {
        bundleId: '00000000-0000-4000-8000-0000000000b2',
        userId: USER,
        replacement: {
          mode: 'keep_until_success',
          previousArchive: {
            archivePath: path.join(root, DIR, ARCHIVE),
            archiveFilename: 'kit.zip',
            archiveFormat: 'zip',
          },
        },
      },
    ]);
    await sweeper().sweep();
    expect((await exists(ARCHIVE)).isFile()).toBe(true);
  });

  it.each(['uploading', 'completing'])(
    'keeps an unpromoted archive during an %s session',
    async (status) => {
      fake.insert(schema.customBundleUploads, {
        id: UPLOAD,
        userId: USER,
        bundleId: BUNDLE,
        status,
      });
      await sweeper().sweep();
      expect((await exists(ARCHIVE)).isFile()).toBe(true);
    },
  );

  it('does not treat near-match names or nested extracted content as artifacts', async () => {
    const names = [
      '.haive-extract-123-no-uuid',
      'source.notes.zip',
      'source.zip.replacement.json.bak',
      'extracted',
    ];
    for (const name of names) {
      await mkdir(path.join(root, DIR, name));
      await writeFile(path.join(root, DIR, name, 'source.zip'), 'untouched');
      await utimes(path.join(root, DIR, name), OLD, OLD);
    }
    await sweeper().sweep();
    for (const name of names)
      expect(await readFile(path.join(root, DIR, name, 'source.zip'), 'utf8')).toBe('untouched');
  });

  it('logs one entry fault and continues with other orphans', async () => {
    const original = fsSafe.removeNoFollow;
    const remove = vi.spyOn(fsSafe, 'removeNoFollow');
    remove.mockImplementation(async (anchor, rel, opts) => {
      if (rel.endsWith(STAGE)) throw new Error('entry unavailable');
      return original(anchor, rel, opts);
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await sweeper().sweep();
    expect((await exists(STAGE)).isDirectory()).toBe(true);
    await expect(exists(SIDECAR)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(warn).toHaveBeenCalled();
  });

  it('runs at the injected cadence and rechecks ownership on the next pass', async () => {
    let now = NOW;
    const worker = sweeper({ now: () => now, intervalMs: 10 });
    bundle('syncing');
    await worker.sweep();
    fake.patch(schema.customBundles, BUNDLE, { status: 'active' });
    now += 9;
    await worker.sweep();
    expect(readJobs).toHaveBeenCalledTimes(1);
    expect((await exists(STAGE)).isDirectory()).toBe(true);
    now += 1;
    await worker.sweep();
    expect(readJobs).toHaveBeenCalledTimes(2);
    await expect(exists(STAGE)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rotates a small bundle budget past a live bundle', async () => {
    bundle('syncing');
    const other = '00000000-0000-4000-8000-0000000000b2';
    const orphan = path.join(root, USER, other, STAGE);
    await mkdir(orphan, { recursive: true });
    await utimes(orphan, OLD, OLD);
    const worker = sweeper({ intervalMs: 0, maxBundlesPerPass: 1 });
    await worker.sweep();
    expect((await lstat(orphan)).isDirectory()).toBe(true);
    await worker.sweep();
    await expect(lstat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await exists(STAGE)).isDirectory()).toBe(true);
  });

  it('skips a capped directory without making an incomplete ownership decision', async () => {
    await sweeper({ maxDirectoryEntries: 3 }).sweep();
    for (const name of [STAGE, SIDECAR, ARCHIVE, 'source.zip'])
      await expect(exists(name)).resolves.toBeDefined();
  });

  it('retains a bundle whose database ownership cannot be read', async () => {
    vi.spyOn(fake.db, 'select').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    await sweeper().sweep();
    for (const name of [STAGE, SIDECAR, ARCHIVE, 'source.zip'])
      await expect(exists(name)).resolves.toBeDefined();
  });

  it('never follows a symlink in the owner directory levels', async () => {
    const target = path.join(root, 'elsewhere');
    await mkdir(target);
    await writeFile(path.join(target, 'source.zip'), 'untouched');
    await rm(path.join(root, DIR), { recursive: true });
    await symlink(target, path.join(root, DIR));
    await sweeper().sweep();
    expect((await lstat(path.join(root, DIR))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(target, 'source.zip'), 'utf8')).toBe('untouched');
  });
});
