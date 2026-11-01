import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { RepoJobPayload } from '@haive/shared';
import { handleExtract } from '../src/repo/clone.js';

const claim = vi.hoisted(() => ({ release: vi.fn(async () => {}) }));

// Root-claim SQL is covered against Postgres by the claim tests; this fixture exercises extraction.
vi.mock('@haive/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/database')>()),
  acquireRootClaim: async () => ({ release: claim.release, lost: () => false }),
}));

vi.mock('../src/plan/sync-checkout.js', () => ({ syncPlanFromCheckout: async () => {} }));
vi.mock('../src/project-state/sync.js', () => ({
  syncProjectStateFromCheckout: async () => ({ outcome: 'absent' }),
}));
vi.mock('../src/project-state/rtk-conflict.js', () => ({ raiseRtkQuestion: async () => {} }));

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
let root: string;
let fake: ReturnType<typeof makeDb>;
let payload: RepoJobPayload;
function makeDb() {
  return createFakeDb({
    repositories: schema.repositories,
    repoUploads: schema.repoUploads,
    tasks: schema.tasks,
  });
}
beforeEach(async () => {
  claim.release.mockClear();
  root = await mkdtemp(path.join(tmpdir(), 'extract-retry-'));
  fake = makeDb();
  payload = {
    repositoryId: REPO,
    userId: USER,
    source: 'upload',
    archivePath: path.join(root, '_uploads', USER, `${REPO}.zip`),
    archiveFormat: 'zip',
  };
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'retry',
    source: 'upload',
    status: 'cloning',
  });
  fake.insert(schema.repoUploads, {
    id: REPO,
    userId: USER,
    archivePath: payload.archivePath,
    archiveFormat: 'zip',
    filename: 'a.zip',
    totalSize: 10,
    chunkSize: 10,
    status: 'complete',
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function archive() {
  await mkdir(path.dirname(payload.archivePath!), { recursive: true });
  const zip = new JSZip();
  zip.file('README.md', '# fresh\n');
  zip.file('src/main.ts', 'export {};\n');
  await writeFile(payload.archivePath!, await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('extract upload retry', () => {
  it('replaces a failed run with a clean tree and removes the archive on success', async () => {
    await mkdir(path.join(root, USER, REPO), { recursive: true });
    await writeFile(path.join(root, USER, REPO, 'partial.txt'), 'failed run');
    await archive();
    await handleExtract(payload, fake.db as never, root);
    expect(await readdir(path.join(root, USER, REPO))).not.toContain('partial.txt');
    expect(await readFile(path.join(root, USER, REPO, 'README.md'), 'utf8')).toBe('# fresh\n');
    expect(fake.rows(schema.repositories)[0]!.status).toBe('ready');
    expect(claim.release).toHaveBeenCalledTimes(1);
    await expect(readFile(payload.archivePath!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses unsafe Git metadata before publishing or detecting an uploaded repository', async () => {
    await mkdir(path.dirname(payload.archivePath!), { recursive: true });
    const zip = new JSZip();
    zip.file('.git', 'gitdir: /private-secret-value');
    zip.file('README.md', '# untrusted new tree');
    await writeFile(payload.archivePath!, await zip.generateAsync({ type: 'nodebuffer' }));
    const dest = path.join(root, USER, REPO);
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, 'keep.txt'), 'previous checkout');
    await expect(handleExtract(payload, fake.db as never, root)).rejects.toThrow(
      /Uploaded Git metadata is unsafe or unsupported/,
    );
    expect(await readdir(dest)).toEqual(['keep.txt']);
    expect(await readFile(path.join(dest, 'keep.txt'), 'utf8')).toBe('previous checkout');
    expect(fake.rows(schema.repositories)[0]!.status).toBe('cloning');
    expect(fake.rows(schema.repoUploads)[0]!.status).toBe('complete');
    expect(await readFile(payload.archivePath!)).not.toHaveLength(0);
    expect(claim.release).toHaveBeenCalledTimes(1);
  });

  it('records a missing archive and tells the user to delete and upload again', async () => {
    await expect(handleExtract(payload, fake.db as never, root)).rejects.toThrow(
      /delete.*repository.*upload.*again/i,
    );
    expect(fake.rows(schema.repoUploads)[0]!.status).toBe('cancelled');
    expect(claim.release).toHaveBeenCalledTimes(1);
  });

  it('does not replace a tree while a task holds it', async () => {
    await archive();
    fake.insert(schema.tasks, {
      repositoryId: REPO,
      userId: USER,
      type: 'workflow',
      title: 'holds root',
      status: 'running',
    });
    await expect(handleExtract(payload, fake.db as never, root)).rejects.toThrow(
      /using this repository/i,
    );
    expect(fake.rows(schema.repoUploads)[0]!.status).toBe('complete');
    expect(claim.release).toHaveBeenCalledTimes(1);
    expect(await readFile(payload.archivePath!)).not.toHaveLength(0);
  });
});
