import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  error: new Error(),
  site: '',
  extracted: false,
  fired: false,
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  const wrap =
    (kind: 'lstat' | 'readdir') =>
    async (...args: unknown[]) => {
      const target = String(args[0]);
      const matches =
        h.site === 'archive'
          ? kind === 'lstat' && target.endsWith('/spec.zip')
          : h.extracted &&
            (h.site === 'listing'
              ? kind === 'readdir'
              : kind === 'lstat' && target.endsWith('/keep.md'));
      if (!h.fired && matches) {
        h.fired = true;
        throw h.error;
      }
      return (real[kind] as (...args: unknown[]) => Promise<unknown>)(...args);
    };
  return { ...real, lstat: wrap('lstat'), readdir: wrap('readdir') };
});
vi.mock('../src/repo/clone.js', () => ({
  extractArchive: async (
    _source: unknown,
    _format: unknown,
    dest: { anchor: string; rel: string },
  ) => {
    const fs = await import('@haive/shared/fs-safe');
    await fs.writeFileNoFollow(dest.anchor, `${dest.rel}/nested/keep.md`, 'specification', {
      createParents: true,
    });
    h.extracted = true;
    return { dropped: [], note: null };
  },
}));
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { ensureArchivesExpanded } from '../src/attachments/expand-archives.js';
const TASK = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
let root: string;
afterEach(async () => {
  h.site = '';
  await rm(root, { recursive: true, force: true });
});
it.each(['archive', 'listing', 'member'])(
  'leaves %s resource failures retryable without stamping an incomplete expansion',
  async (site) => {
    for (const code of ['EMFILE', 'ENFILE']) {
      root = await mkdtemp(path.join(tmpdir(), 'archive-resource-'));
      const uploads = path.join(root, '.haive/task-uploads', TASK);
      await mkdir(uploads, { recursive: true });
      await writeFile(path.join(uploads, 'spec.zip'), 'fake archive');
      const fake = createFakeDb({ taskAttachments: schema.taskAttachments });
      fake.insert(schema.taskAttachments, {
        taskId: TASK,
        userId: USER,
        filename: 'spec.zip',
        storedPath: path.join(uploads, 'spec.zip'),
        sizeBytes: 12,
      });
      h.site = site;
      h.extracted = false;
      h.fired = false;
      h.error = Object.assign(new Error('injected'), { code });
      const result = await ensureArchivesExpanded(fake.db as unknown as Database, TASK);
      expect(h.fired).toBe(true);
      expect(result).toEqual({ expanded: 0, filesAdded: 0, notes: [] });
      expect(fake.rows(schema.taskAttachments)).toHaveLength(1);
      expect(fake.rows(schema.taskAttachments)[0]?.expandedAt).toBeNull();
      h.site = '';
      expect((await ensureArchivesExpanded(fake.db as unknown as Database, TASK)).filesAdded).toBe(
        1,
      );
      await rm(root, { recursive: true, force: true });
    }
  },
);
