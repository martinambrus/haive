import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  classified: null as unknown,
  user: '00000000-0000-4000-8000-0000000000a1',
  removed: 0,
  failCatalog: false,
}));

// Parsing proper reads the repository's CLI providers through a join; the classifier it starts
// from is the part the extracted layout decides, so that is what the stub runs.
vi.mock('../src/bundle-parser/index.js', () => ({
  parseBundle: async (bundleId: string, _db: unknown, _logger: unknown, root: string) => {
    const { classifyBundle } = await import('../src/bundle-parser/classifier.js');
    h.classified = await classifyBundle(root, `${h.user}/${bundleId}/extracted`);
    return { items: [], ambiguous: [], dropped: [] };
  },
  persistBundleItems: async (db: Database, bundleId: string) => {
    if (h.failCatalog) {
      await db
        .delete(schema.customBundleItems)
        .where((await import('drizzle-orm')).eq(schema.customBundleItems.bundleId, bundleId));
      throw new Error('catalog write failed');
    }
    return { inserted: 0, updated: 0, removed: h.removed };
  },
}));

import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import * as recovery from '../src/repo/bundle-recovery.js';
import { createFakeDb } from '@haive/database/testing';
import type { Database } from '@haive/database';
import type { ClassifiedBundle } from '../src/bundle-parser/classifier.js';
import { extractArchive } from '../src/repo/clone.js';
import { bundleArchiveRel, handleIngestZip } from '../src/repo/bundle-ingest.js';

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@haive.local',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@haive.local',
      },
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}

let tmpRoot: string;

beforeEach(async () => {
  h.failCatalog = false;
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-bundle-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('bundle-ingest: zip extraction', () => {
  it('extracts a ZIP bundle into the bundle storage layout', async () => {
    const archivePath = path.join(tmpRoot, 'bundle.zip');
    const zip = new JSZip();
    zip.file('agents/code-reviewer.md', '---\nname: code-reviewer\n---\nbody\n');
    zip.file('skills/style-guide/SKILL.md', '---\nname: style-guide\n---\nbody\n');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(archivePath, buf);

    const dest = path.join(tmpRoot, 'user-id', 'bundle-id', 'extracted');
    await extractArchive({ anchor: tmpRoot, rel: 'bundle.zip' }, 'zip', {
      anchor: tmpRoot,
      rel: 'user-id/bundle-id/extracted',
    });

    expect(await readdir(dest)).toEqual(expect.arrayContaining(['agents', 'skills']));
    const agent = await readFile(path.join(dest, 'agents', 'code-reviewer.md'), 'utf8');
    expect(agent).toContain('name: code-reviewer');
  });

  it('extracts a tar.gz bundle (preserves agents/ + skills/ structure)', async () => {
    const src = path.join(tmpRoot, 'src');
    await mkdir(path.join(src, 'agents'), { recursive: true });
    await mkdir(path.join(src, 'skills'), { recursive: true });
    await writeFile(path.join(src, 'agents', 'foo.md'), '---\nname: foo\n---\n');
    await writeFile(path.join(src, 'skills', 'README.md'), 'skills index\n');
    const archivePath = path.join(tmpRoot, 'bundle.tar.gz');
    // Multiple top-level entries — flattenSingleTopLevel keeps both intact.
    await run('tar', ['-czf', archivePath, '-C', src, 'agents', 'skills']);

    const dest = path.join(tmpRoot, 'out');
    await extractArchive({ anchor: tmpRoot, rel: 'bundle.tar.gz' }, 'tar.gz', {
      anchor: tmpRoot,
      rel: 'out',
    });

    expect((await readdir(dest)).sort()).toEqual(['agents', 'skills']);
    expect(await readdir(path.join(dest, 'agents'))).toContain('foo.md');
  });
});

describe('handleIngestZip', () => {
  const BUNDLE = '00000000-0000-4000-8000-0000000000b1';

  const REPOSITORY = '00000000-0000-4000-8000-0000000000c1';
  let outbox: () => unknown[] = () => [];

  async function ingest(files: Record<string, string>): Promise<ClassifiedBundle> {
    const zip = new JSZip();
    for (const [name, body] of Object.entries(files)) zip.file(name, body);
    await mkdir(path.join(tmpRoot, h.user, BUNDLE), { recursive: true });
    const archivePath = path.join(tmpRoot, h.user, BUNDLE, 'source.zip');
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const fake = createFakeDb({
      customBundles: schema.customBundles,
      projectStateOutbox: schema.projectStateOutbox,
    });
    outbox = () => fake.rows(schema.projectStateOutbox);
    fake.insert(schema.customBundles, {
      id: BUNDLE,
      userId: h.user,
      repositoryId: REPOSITORY,
      name: 'bundle',
      sourceType: 'zip',
      archivePath,
      archiveFormat: 'zip',
      storageRoot: '',
    });
    h.classified = null;
    await handleIngestZip(
      { bundleId: BUNDLE, userId: h.user } as never,
      fake.db as unknown as Database,
      tmpRoot,
    );
    return h.classified as ClassifiedBundle;
  }

  const agent = '---\nname: reviewer\ndescription: reviews\n---\nbody\n';

  it.each(['success', 'catalog failure'] as const)(
    'publishes a keep-mode replacement atomically: %s',
    async (outcome) => {
      const dir = path.join(tmpRoot, h.user, BUNDLE);
      const dest = path.join(dir, 'extracted');
      const archivePath = path.join(dir, 'source.new.zip');
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'old.md'), 'old tree');
      const zip = new JSZip();
      zip.file('agents/new.md', agent);
      await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
      const fake = createFakeDb({
        customBundles: schema.customBundles,
        customBundleItems: schema.customBundleItems,
      });
      fake.insert(schema.customBundles, {
        id: BUNDLE,
        userId: h.user,
        repositoryId: REPOSITORY,
        name: 'bundle',
        sourceType: 'zip',
        archivePath,
        archiveFormat: 'zip',
        storageRoot: dest,
        status: 'syncing',
      });
      fake.insert(schema.customBundleItems, {
        id: REPOSITORY,
        bundleId: BUNDLE,
        sourcePath: 'old.md',
        contentHash: 'old',
      });
      const oldItems = structuredClone(fake.rows(schema.customBundleItems));
      await writeFile(
        `${archivePath}.replacement.json`,
        JSON.stringify({
          mode: 'keep_until_success',
          previousArchive: {
            archivePath: path.join(dir, 'source.zip'),
            archiveFilename: 'old.zip',
            archiveFormat: 'zip',
          },
        }),
      );
      h.failCatalog = outcome === 'catalog failure';
      const result = handleIngestZip(
        {
          bundleId: BUNDLE,
          userId: h.user,
          archivePath,
          replacement: {
            mode: 'keep_until_success',
            previousArchive: {
              archivePath: path.join(dir, 'source.zip'),
              archiveFilename: 'old.zip',
              archiveFormat: 'zip',
            },
          },
        },
        fake.db as unknown as Database,
        tmpRoot,
      );
      if (outcome === 'catalog failure') {
        await expect(result).rejects.toThrow('catalog write failed');
        expect(await readFile(path.join(dest, 'old.md'), 'utf8')).toBe('old tree');
        expect(fake.rows(schema.customBundleItems)).toEqual(oldItems);
        expect(fake.rows(schema.customBundles)[0]).toMatchObject({
          status: 'active',
          archiveFilename: 'old.zip',
        });
      } else {
        await result;
        expect(await readFile(path.join(dest, 'agents/new.md'), 'utf8')).toBe(agent);
        expect(await readdir(dest)).not.toContain('old.md');
        expect(fake.rows(schema.customBundles)[0]).toMatchObject({
          status: 'active',
          archivePath,
          lastSyncNote: null,
        });
      }
      await expect(readFile(`${archivePath}.replacement.json`)).rejects.toThrow();
    },
  );

  it('replays a committed replacement without extracting or changing its catalog', async () => {
    const { seedCrashedReplacement } = await import('./bundle-replacement-fixture.js');
    const fake = createFakeDb({
      customBundles: schema.customBundles,
      customBundleItems: schema.customBundleItems,
    });
    const fixture = await seedCrashedReplacement(tmpRoot, fake, 'after swap');
    // The catalog transaction's active row is the commit marker. The archive is corrupt,
    // and the record still names the old tree: extracting or rolling back would destroy this tree.
    fake.patch(schema.customBundles, BUNDLE, { status: 'active', lastSyncNote: 'committed note' });
    fake.patch(schema.customBundleItems, String(fake.rows(schema.customBundleItems)[0]!.id), {
      sourcePath: 'new.md',
    });
    const rows = structuredClone(fake.rows(schema.customBundles));
    const items = structuredClone(fake.rows(schema.customBundleItems));
    const tx = vi.spyOn(fake.db, 'transaction');
    for (let attempt = 0; attempt < 2; attempt++) {
      await handleIngestZip(fixture.payload, fake.db as unknown as Database, tmpRoot);
      expect(await readFile(path.join(fixture.dest, 'new.md'), 'utf8')).toBe('new tree');
      expect(fake.rows(schema.customBundles)).toEqual(rows);
      expect(fake.rows(schema.customBundleItems)).toEqual(items);
      await expect(readFile(`${fixture.archivePath}.replacement.json`)).rejects.toThrow();
    }
    expect(tx).not.toHaveBeenCalled();
  });

  it('fails a bundle whose replacement record does not parse, keeping the old tree and items', async () => {
    const { seedCrashedReplacement } = await import('./bundle-replacement-fixture.js');
    const fake = createFakeDb({
      customBundles: schema.customBundles,
      customBundleItems: schema.customBundleItems,
    });
    const fixture = await seedCrashedReplacement(tmpRoot, fake, 'before extract');
    const items = structuredClone(fake.rows(schema.customBundleItems));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await writeFile(`${fixture.archivePath}.replacement.json`, '{invalid json');

    const error = await handleIngestZip(
      fixture.payload,
      fake.db as unknown as Database,
      tmpRoot,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(recovery.ReplacementRecordUnreadable);
    expect(fake.rows(schema.customBundles)[0]).toMatchObject({
      status: 'failed',
      lastSyncError: recovery.UNREADABLE_REPLACEMENT_ERROR,
      lastReplacementNote: null,
    });
    expect(fake.rows(schema.customBundleItems)).toEqual(items);
    expect(await readFile(path.join(fixture.dest, 'old.md'), 'utf8')).toBe('old tree');
  });

  it.each(['restore I/O'])(
    'leaves the bundle unchanged and logs a recovery fault: %s',
    async (fault) => {
      const { seedCrashedReplacement } = await import('./bundle-replacement-fixture.js');
      const fake = createFakeDb({
        customBundles: schema.customBundles,
        customBundleItems: schema.customBundleItems,
      });
      const fixture = await seedCrashedReplacement(tmpRoot, fake, 'before extract');
      const before = structuredClone(fake.rows(schema.customBundles));
      const items = structuredClone(fake.rows(schema.customBundleItems));
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const restoreError = Object.assign(new Error('restore denied'), { code: 'EACCES' });
      vi.spyOn(recovery, 'restoreReplacementBundle').mockRejectedValueOnce(restoreError);
      const record = await readFile(`${fixture.archivePath}.replacement.json`, 'utf8');

      const error = await handleIngestZip(
        fixture.payload,
        fake.db as unknown as Database,
        tmpRoot,
      ).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBe(restoreError);
      expect(fake.rows(schema.customBundles)).toEqual(before);
      expect(fake.rows(schema.customBundleItems)).toEqual(items);
      expect(await readFile(`${fixture.archivePath}.replacement.json`, 'utf8')).toBe(record);
      expect(await readFile(path.join(fixture.dest, 'old.md'), 'utf8')).toBe('old tree');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleId: fixture.payload.bundleId,
          err: fault === 'restore I/O' ? restoreError : expect.any(Error),
        }),
        expect.any(String),
      );
    },
  );

  it('recovers the real swap after SIGKILL and a failing redelivery', async () => {
    const { seedCrashedReplacement } = await import('./bundle-replacement-fixture.js');
    const fake = createFakeDb({
      customBundles: schema.customBundles,
      customBundleItems: schema.customBundleItems,
    });
    const fixture = await seedCrashedReplacement(tmpRoot, fake, 'before extract');
    const zip = new JSZip();
    zip.file('agents/new.md', agent);
    await writeFile(fixture.archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'test/bundle-extract-crash-child.ts', tmpRoot, fixture.archivePath],
      { stdio: 'pipe' },
    );
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const signal = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (_code, signal) => resolve(signal));
    });
    expect(signal, stderr).toBe('SIGKILL');
    expect(await readFile(path.join(fixture.dest, 'agents/new.md'), 'utf8')).toBe(agent);
    const record = JSON.parse(await readFile(`${fixture.archivePath}.replacement.json`, 'utf8'));
    expect(record.recovery).toMatchObject({
      stageName: expect.stringMatching(/^\.haive-extract-/),
      dev: expect.any(String),
      ino: expect.any(String),
    });
    await writeFile(fixture.archivePath, 'corrupt zip');
    await expect(
      handleIngestZip(fixture.payload, fake.db as unknown as Database, tmpRoot),
    ).rejects.toThrow();
    expect(await readFile(path.join(fixture.dest, 'old.md'), 'utf8')).toBe('old tree');
    expect(fake.rows(schema.customBundles)[0]).toMatchObject({
      status: 'active',
      ...fixture.previousArchive,
    });
    expect(fake.rows(schema.customBundleItems)[0]).toMatchObject({ sourcePath: 'old.md' });
  });

  it.each(['before extract', 'mid extract', 'between renames', 'after swap', 'previous lost'])(
    'restores durable keep-mode state on a failing redelivery: %s',
    async (point) => {
      const { seedCrashedReplacement } = await import('./bundle-replacement-fixture.js');
      const fake = createFakeDb({
        customBundles: schema.customBundles,
        customBundleItems: schema.customBundleItems,
      });
      const fixture = await seedCrashedReplacement(tmpRoot, fake, point);
      const items = structuredClone(fake.rows(schema.customBundleItems));
      await expect(
        handleIngestZip(fixture.payload, fake.db as unknown as Database, tmpRoot),
      ).rejects.toThrow();
      expect(fake.rows(schema.customBundleItems)).toEqual(items);
      const row = fake.rows(schema.customBundles)[0]!;
      if (point === 'previous lost') {
        expect(row).toMatchObject({
          status: 'failed',
          lastSyncError: expect.stringContaining('previous extracted tree is unavailable'),
        });
      } else {
        expect(await readFile(path.join(fixture.dest, 'old.md'), 'utf8')).toBe('old tree');
        expect(row).toMatchObject({ status: 'active', ...fixture.previousArchive });
        await expect(readFile(`${fixture.archivePath}.replacement.json`)).rejects.toThrow();
      }
    },
  );

  it('keeps a lone agents/ folder, which carries what makes its files agents', async () => {
    const out = await ingest({ 'agents/reviewer.md': agent });
    expect(out.agents).toEqual([
      { kind: 'agent', sourceFormat: 'claude-md', sourcePath: 'agents/reviewer.md' },
    ]);
  });

  it('keeps a lone .gemini/ folder, so its agents stay gemini agents', async () => {
    const out = await ingest({ '.gemini/agents/reviewer.md': agent });
    expect(out.agents).toEqual([
      { kind: 'agent', sourceFormat: 'gemini-md', sourcePath: '.gemini/agents/reviewer.md' },
    ]);
  });

  it('marks the project state record dirty when the ingest removed items, and not otherwise', async () => {
    await ingest({ 'agents/reviewer.md': agent });
    expect(outbox()).toEqual([]);

    h.removed = 2;
    try {
      await ingest({ 'agents/reviewer.md': agent });
    } finally {
      h.removed = 0;
    }
    expect(outbox()).toMatchObject([{ repositoryId: REPOSITORY, revision: 1, writtenRevision: 0 }]);
  });

  it('still unwraps a folder the bundle was zipped in, so item paths do not move', async () => {
    const out = await ingest({ 'my-bundle/agents/reviewer.md': agent });
    expect(out.agents).toEqual([
      { kind: 'agent', sourceFormat: 'claude-md', sourcePath: 'agents/reviewer.md' },
    ]);
  });
});

describe('bundleArchiveRel', () => {
  const root = '/var/lib/haive/bundles';

  it('answers the one file the api moves into the bundle directory', () => {
    expect(bundleArchiveRel(root, `${root}/u1/b1/source.zip`, 'u1', 'b1')).toBe('u1/b1/source.zip');
    expect(bundleArchiveRel(`${root}/`, `${root}/u1/b1/source.tar.gz`, 'u1', 'b1')).toBe(
      'u1/b1/source.tar.gz',
    );
  });

  it('refuses a path anywhere else, rather than reading it', () => {
    expect(bundleArchiveRel(root, `${root}/u1/b2/source.zip`, 'u1', 'b1')).toBeNull();
    expect(bundleArchiveRel(root, `${root}/u2/b1/source.zip`, 'u1', 'b1')).toBeNull();
    expect(bundleArchiveRel(root, `${root}/u1/b1/extracted/source.zip`, 'u1', 'b1')).toBeNull();
    expect(bundleArchiveRel(root, `${root}/u1/b1/other.zip`, 'u1', 'b1')).toBeNull();
    expect(bundleArchiveRel(root, '/etc/source.zip', 'u1', 'b1')).toBeNull();
  });
});
